import { describe, expect, test } from "vitest";
import type { DrainAck, LifecycleEvent, ReleasePermit, Snapshot } from "@yourdigitaltoolbox/pi-context-lifecycle";
import { envelope, serialize } from "./envelope.js";
import { MAX_MESH_ENVELOPE_BYTES, MAX_MESH_ENVELOPES, MAX_MESH_TOTAL_BYTES, MeshSpool, type MeshSpoolAuthority } from "./mesh_spool.js";

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { protocolVersion: 1, registryState: "ready", sequence: 1, sessionId: "session-a", generationId: "generation-a", phase: "compacting", ...overrides };
}

function fakeAuthority(initial = snapshot()) {
  let current = initial;
  const listeners = new Set<(event: LifecycleEvent) => void>();
  const drainers = new Map<string, { capture(): { watermark: number; heldCount: number }; drain(permit: ReleasePermit): DrainAck }>();
  const authority: MeshSpoolAuthority = {
    snapshot: () => current,
    observe(listener) {
      listeners.add(listener);
      return { snapshot: current, unsubscribe: () => listeners.delete(listener) };
    },
    admitWake: (_request, permit) => current.phase === "idle" || permit ? { disposition: "deliver", code: "idle", generationId: "generation-a" } : { disposition: "hold", code: "active", generationId: "generation-a" },
    registerDrainer(registration) {
      const key = registration.laneId;
      drainers.set(key, registration);
      return () => drainers.delete(key);
    },
  };
  return {
    authority,
    drainers,
    set(next: Snapshot) {
      current = next;
      for (const listener of listeners) listener({ ...next, event: "snapshot" });
    },
  };
}

function message(body: unknown, re: string | null = null) {
  return envelope("sender", "target", body, re);
}

/** `serialize` grows one UTF-8 byte per ASCII x, so every size is reachable. */
function retainedMessageAtSerializedBytes(bytes: number) {
  let low = 0;
  let high = bytes;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = { ...message("x".repeat(count)), deliveryReceipt: { required: true as const } };
    const actual = Buffer.byteLength(serialize(candidate), "utf8");
    if (actual === bytes) return candidate;
    if (actual < bytes) low = count + 1;
    else high = count - 1;
  }
  throw new Error(`no envelope body has serialized size ${bytes}`);
}

describe("MeshSpool", () => {
  test("holds work until settlement, then releases reply before unsolicited follow-up submissions", () => {
    const controlled = fakeAuthority();
    const submitted: Array<{ lane: string; ids: string[] }> = [];
    const followUps: string[] = [];
    const spool = new MeshSpool({
      mode: "managed",
      getSessionId: () => "session-a",
      authority: controlled.authority,
      submit: (lane, values) => {
        submitted.push({ lane, ids: values.map((value) => value.id) });
        followUps.push(...values.map((value) => value.id));
        return true;
      },
    });
    const unsolicited = message({ type: "notice" });
    const reply = message({ type: "reply" }, "00000000-0000-7000-8000-000000000001");
    expect(spool.accept(unsolicited)).toEqual({ status: "received" });
    expect(spool.accept(reply)).toEqual({ status: "received" });
    // No model follow-up is submitted while lifecycle settlement still holds it.
    expect(submitted).toEqual([]);
    expect(followUps).toEqual([]);
    expect(spool.counts()).toMatchObject({ replies: 1, unsolicited: 1 });

    controlled.set(snapshot({ sequence: 2, phase: "idle" }));
    expect(submitted).toEqual([
      { lane: "mesh-reply", ids: [reply.id] },
      { lane: "mesh-unsolicited", ids: [unsolicited.id] },
    ]);
    expect(followUps).toEqual([reply.id, unsolicited.id]);
    expect(spool.counts()).toMatchObject({ replies: 0, unsolicited: 0 });
  });

  test("enforces exact per-envelope, shared count, and total-byte caps before accepting", () => {
    const controlled = fakeAuthority();
    for (const [bytes, expected] of [
      [MAX_MESH_ENVELOPE_BYTES - 1, "received"],
      [MAX_MESH_ENVELOPE_BYTES, "received"],
      [MAX_MESH_ENVELOPE_BYTES + 1, "denied"],
    ] as const) {
      const spool = new MeshSpool({ mode: "managed", getSessionId: () => "session-a", authority: controlled.authority, submit: () => true });
      const result = spool.accept(retainedMessageAtSerializedBytes(bytes));
      expect(result.status).toBe(expected);
      if (expected === "denied") expect(result).toMatchObject({ code: "envelope-too-large" });
    }

    const count = new MeshSpool({ mode: "managed", getSessionId: () => "session-a", authority: controlled.authority, submit: () => true });
    for (let i = 0; i < MAX_MESH_ENVELOPES - 1; i++) expect(count.accept(message({ i }))).toEqual({ status: "received" });
    expect(count.counts().replies + count.counts().unsolicited).toBe(255);
    expect(count.accept(message({ i: 255 }))).toEqual({ status: "received" });
    expect(count.counts().replies + count.counts().unsolicited).toBe(256);
    expect(count.accept(message({ i: 256 }))).toMatchObject({ status: "denied", code: "spool-envelope-capacity" });

    const total = new MeshSpool({ mode: "managed", getSessionId: () => "session-a", authority: controlled.authority, submit: () => true });
    for (let i = 0; i < MAX_MESH_TOTAL_BYTES / MAX_MESH_ENVELOPE_BYTES; i++) expect(total.accept(retainedMessageAtSerializedBytes(MAX_MESH_ENVELOPE_BYTES))).toEqual({ status: "received" });
    expect(total.counts().bytes).toBe(MAX_MESH_TOTAL_BYTES);
    expect(total.accept(message({ overflow: true }))).toMatchObject({ status: "denied", code: "spool-byte-capacity" });
  });

  test("release cut cannot let post-cut same-lane work overtake retained FIFO work", () => {
    const controlled = fakeAuthority();
    const submitted: string[] = [];
    const spool = new MeshSpool({
      mode: "managed",
      getSessionId: () => "session-a",
      authority: controlled.authority,
      submit: (_lane, values) => { submitted.push(...values.map((value) => value.id)); return true; },
    });
    const older = message({ order: "older" });
    const later = message({ order: "later" });
    expect(spool.accept(older)).toEqual({ status: "received" });
    const drainer = controlled.drainers.get("mesh-unsolicited")!;
    const cut = drainer.capture();
    expect(spool.accept(later)).toEqual({ status: "received" });
    const ack = drainer.drain({
      protocolVersion: 1, sessionId: "session-a", generationId: "generation-a",
      operationId: "operation-a", releaseId: "release-a", consumerId: "remote-pi-mesh",
      laneId: "mesh-unsolicited", cut,
    });
    expect(ack).toMatchObject({ disposition: "submitted", handledCount: 1 });
    expect(submitted).toEqual([older.id]);
    controlled.set(snapshot({ phase: "idle" }));
    expect(submitted).toEqual([older.id, later.id]);
  });

  test("fails closed without a matching lifecycle owner/session and never submits", () => {
    const controlled = fakeAuthority(snapshot({ registryState: "unavailable", sessionId: undefined, generationId: undefined, phase: undefined }));
    let submits = 0;
    const spool = new MeshSpool({ mode: "managed", getSessionId: () => "session-a", authority: controlled.authority, submit: () => { submits += 1; return true; } });
    expect(spool.accept(message({ blocked: true }))).toMatchObject({ status: "denied", code: "lifecycle-authority-unavailable" });
    expect(submits).toBe(0);
  });

  test("restored records bind to the current session and drain only after current idle admission", () => {
    const controlled = fakeAuthority();
    const submitted: string[] = [];
    const spool = new MeshSpool({
      mode: "managed",
      getSessionId: () => "session-a",
      authority: controlled.authority,
      submit: (_lane, values) => { submitted.push(...values.map((value) => value.id)); return true; },
    });
    const restored = message({ restore: true });
    expect(spool.restore("mesh-unsolicited", restored, "generation-a")).toBe(true);
    expect(submitted).toEqual([]);
    controlled.set(snapshot({ phase: "idle" }));
    expect(submitted).toEqual([restored.id]);
  });

  test("persists submission intent before SDK submit and never retries after a terminal-marker failure", () => {
    const controlled = fakeAuthority();
    const events: string[] = [];
    let submits = 0;
    const spool = new MeshSpool({
      mode: "managed", getSessionId: () => "session-a", authority: controlled.authority,
      submit: () => { events.push("sdk-submit"); submits += 1; return true; },
      persist: (event) => {
        events.push(event.state);
        if (event.state === "submitted") throw new Error("marker storage interrupted");
      },
    });
    expect(spool.accept(message({ recoverable: true }))).toEqual({ status: "received" });
    controlled.set(snapshot({ phase: "idle" }));
    expect(events).toEqual(["held", "submitting", "sdk-submit", "submitted"]);
    expect(submits).toBe(1);
    // A later idle notification cannot duplicate a submission which already
    // has a durable custom-message proof even if its terminal marker failed.
    controlled.set(snapshot({ sequence: 3, phase: "idle" }));
    expect(submits).toBe(1);
  });

  test("same-session records from a prior generation are quarantined instead of flushed", () => {
    const controlled = fakeAuthority(snapshot({ generationId: "generation-b" }));
    const submitted: string[] = [];
    const blocked: string[] = [];
    const spool = new MeshSpool({
      mode: "managed", getSessionId: () => "session-a", authority: controlled.authority,
      submit: (_lane, values) => { submitted.push(...values.map((value) => value.id)); return true; },
      onBlocked: (code) => blocked.push(code),
    });
    expect(spool.restore("mesh-unsolicited", message({ stale: true }), "generation-a")).toBe(true);
    controlled.set(snapshot({ generationId: "generation-b", phase: "idle" }));
    expect(submitted).toEqual([]);
    expect(blocked).toContain("stale-mesh-spool-generation");
  });

  test("a stale/disposed spool cannot flush or accept a new target receipt", () => {
    const controlled = fakeAuthority();
    let submits = 0;
    const spool = new MeshSpool({ mode: "managed", getSessionId: () => "session-a", authority: controlled.authority, submit: () => { submits += 1; return true; } });
    expect(spool.accept(message({ held: true }))).toEqual({ status: "received" });
    spool.dispose();
    controlled.set(snapshot({ phase: "idle" }));
    expect(submits).toBe(0);
    expect(spool.accept(message({ later: true }))).toMatchObject({ status: "denied", code: "spool-disposed" });
  });
});
