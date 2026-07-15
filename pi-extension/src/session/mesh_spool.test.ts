import { describe, expect, test } from "vitest";
import type { DrainAck, LifecycleEvent, ReleasePermit, Snapshot } from "@yourdigitaltoolbox/pi-context-lifecycle";
import { envelope, serialize } from "./envelope.js";
import {
  MAX_MESH_ENVELOPE_BYTES,
  MAX_MESH_ENVELOPES,
  MAX_MESH_TOTAL_BYTES,
  MeshSpool,
  recoverableMeshSpoolEvents,
  type MeshBatchProof,
  type MeshSpoolAuthority,
  type PersistedMeshSpoolEvent,
} from "./mesh_spool.js";

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
  test("holds through dispatch and releases reply before unsolicited only after exact proofs", () => {
    const controlled = fakeAuthority();
    const submitted: Array<{ lane: string; ids: string[]; submissionId: string; generationId: string }> = [];
    const spool = new MeshSpool({
      mode: "managed",
      getSessionId: () => "session-a",
      authority: controlled.authority,
      submit: (lane, values, submissionId, generationId) => {
        submitted.push({ lane, ids: values.map((value) => value.id), submissionId, generationId });
        return true;
      },
    });
    const unsolicited = message({ type: "notice" });
    const reply = message({ type: "reply" }, "00000000-0000-7000-8000-000000000001");
    expect(spool.accept(unsolicited)).toEqual({ status: "received" });
    expect(spool.accept(reply)).toEqual({ status: "received" });
    expect(submitted).toEqual([]);
    expect(spool.counts()).toMatchObject({ replies: 1, unsolicited: 1 });

    controlled.set(snapshot({ sequence: 2, phase: "idle" }));
    expect(submitted.map(({ lane, ids }) => ({ lane, ids }))).toEqual([
      { lane: "mesh-reply", ids: [reply.id] },
      { lane: "mesh-unsolicited", ids: [unsolicited.id] },
    ]);
    // A non-throwing SDK call is not release proof.
    expect(spool.counts()).toMatchObject({ replies: 1, unsolicited: 1 });
    const [replyAttempt, unsolicitedAttempt] = submitted;
    expect(spool.confirmSubmission({ ...replyAttempt!, envelopeIds: ["wrong-id"] })).toBe(false);
    expect(spool.confirmSubmission({ ...replyAttempt!, envelopeIds: replyAttempt!.ids })).toBe(true);
    expect(spool.counts()).toMatchObject({ replies: 0, unsolicited: 1 });
    expect(spool.confirmSubmission({ ...unsolicitedAttempt!, envelopeIds: unsolicitedAttempt!.ids })).toBe(true);
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

  test("release cut cannot let post-cut same-lane work overtake a proof-pending batch", () => {
    const controlled = fakeAuthority();
    const submitted: Array<{ ids: string[]; submissionId: string; generationId: string }> = [];
    const spool = new MeshSpool({
      mode: "managed",
      getSessionId: () => "session-a",
      authority: controlled.authority,
      submit: (_lane, values, submissionId, generationId) => {
        submitted.push({ ids: values.map((value) => value.id), submissionId, generationId });
        return true;
      },
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
    expect(submitted.map((attempt) => attempt.ids)).toEqual([[older.id]]);
    controlled.set(snapshot({ phase: "idle" }));
    expect(submitted.map((attempt) => attempt.ids)).toEqual([[older.id]]);
    const first = submitted[0]!;
    expect(spool.confirmSubmission({ ...first, envelopeIds: first.ids })).toBe(true);
    spool.reconcile();
    expect(submitted.map((attempt) => attempt.ids)).toEqual([[older.id], [later.id]]);
  });

  test("fails closed without a matching lifecycle owner/session and never submits", () => {
    const controlled = fakeAuthority(snapshot({ registryState: "unavailable", sessionId: undefined, generationId: undefined, phase: undefined }));
    let submits = 0;
    const spool = new MeshSpool({ mode: "managed", getSessionId: () => "session-a", authority: controlled.authority, submit: () => { submits += 1; return true; } });
    expect(spool.accept(message({ blocked: true }))).toMatchObject({ status: "denied", code: "lifecycle-authority-unavailable" });
    expect(submits).toBe(0);
  });

  test("denies new work honestly while lifecycle is blocked-unknown", () => {
    const controlled = fakeAuthority(snapshot({ phase: "blocked-unknown" }));
    const persisted: string[] = [];
    const spool = new MeshSpool({
      mode: "managed",
      getSessionId: () => "session-a",
      authority: controlled.authority,
      submit: () => true,
      persist: (event) => persisted.push(event.state),
    });
    expect(spool.accept(message({ blocked: true }))).toEqual({ status: "denied", code: "lifecycle-blocked" });
    expect(persisted).toEqual([]);
    expect(spool.counts()).toMatchObject({ replies: 0, unsolicited: 0, bytes: 0 });
  });

  test("retains while Pi is active and dispatches only at a genuine idle boundary", () => {
    const controlled = fakeAuthority(snapshot({ phase: "idle" }));
    let runtimeIdle = false;
    const states: string[] = [];
    let submits = 0;
    const spool = new MeshSpool({
      mode: "managed",
      getSessionId: () => "session-a",
      isRuntimeIdle: () => runtimeIdle,
      authority: controlled.authority,
      submit: () => { submits += 1; return true; },
      persist: (event) => states.push(event.state),
    });
    expect(spool.accept(message({ during: "active-turn" }))).toEqual({ status: "received" });
    expect(states).toEqual(["held"]);
    expect(submits).toBe(0);
    runtimeIdle = true;
    spool.reconcile();
    expect(states).toEqual(["held", "submitting"]);
    expect(submits).toBe(1);
    expect(spool.counts().unsolicited).toBe(1);
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

  test("a proofless attempt returns to held and retries only when settlement is reconciled", () => {
    const controlled = fakeAuthority(snapshot({ phase: "idle" }));
    const events: string[] = [];
    const attempts: Array<{ submissionId: string; generationId: string; ids: string[] }> = [];
    const spool = new MeshSpool({
      mode: "managed", getSessionId: () => "session-a", authority: controlled.authority,
      submit: (_lane, values, submissionId, generationId) => {
        events.push("sdk-submit");
        attempts.push({ submissionId, generationId, ids: values.map((value) => value.id) });
        return true;
      },
      persist: (event) => events.push(event.state),
    });
    expect(spool.accept(message({ recoverable: true }))).toEqual({ status: "received" });
    expect(events).toEqual(["held", "submitting", "sdk-submit"]);
    expect(attempts).toHaveLength(1);
    spool.retryUnproved();
    expect(events).toEqual(["held", "submitting", "sdk-submit", "held"]);
    expect(spool.counts().unsolicited).toBe(1);
    // Returning to held does not itself resubmit; the caller supplies the next
    // genuine agent_settled boundary by reconciling once.
    expect(attempts).toHaveLength(1);
    spool.reconcile();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.submissionId).not.toBe(attempts[0]!.submissionId);
  });

  test("does not requeue a fresh lifecycle release batch started during the same settled event", () => {
    const controlled = fakeAuthority(snapshot({ phase: "idle" }));
    let runtimeIdle = true;
    let attempt!: { submissionId: string; generationId: string; ids: string[] };
    const states: string[] = [];
    const spool = new MeshSpool({
      mode: "managed",
      getSessionId: () => "session-a",
      isRuntimeIdle: () => runtimeIdle,
      authority: controlled.authority,
      submit: (_lane, values, submissionId, generationId) => {
        attempt = { submissionId, generationId, ids: values.map((value) => value.id) };
        // The SDK synchronously starts the release batch's own model turn.
        runtimeIdle = false;
        return true;
      },
      persist: (event) => states.push(event.state),
    });
    expect(spool.accept(message({ released: "during-agent-settled" }))).toEqual({ status: "received" });
    expect(states).toEqual(["held", "submitting"]);

    spool.retryUnproved();
    expect(states).toEqual(["held", "submitting"]);
    expect(spool.counts().unsolicited).toBe(1);
    expect(spool.confirmSubmission({ ...attempt, envelopeIds: attempt.ids })).toBe(true);
    expect(spool.counts().unsolicited).toBe(0);
  });

  test("durable proof prevents duplicate delivery even if the advisory terminal marker fails", () => {
    const controlled = fakeAuthority(snapshot({ phase: "idle" }));
    let attempt!: { submissionId: string; generationId: string; ids: string[] };
    const blocked: string[] = [];
    const spool = new MeshSpool({
      mode: "managed", getSessionId: () => "session-a", authority: controlled.authority,
      submit: (_lane, values, submissionId, generationId) => {
        attempt = { submissionId, generationId, ids: values.map((value) => value.id) };
        return true;
      },
      persist: (event) => {
        if (event.state === "submitted") throw new Error("marker storage interrupted");
      },
      onBlocked: (code) => blocked.push(code),
    });
    expect(spool.accept(message({ recoverable: true }))).toEqual({ status: "received" });
    expect(spool.confirmSubmission({ ...attempt, envelopeIds: attempt.ids })).toBe(true);
    expect(spool.counts().unsolicited).toBe(0);
    expect(blocked).toContain("mesh-submitted-marker-failed");
    spool.retryUnproved();
    spool.reconcile();
    expect(spool.counts().unsolicited).toBe(0);
  });

  test("same-session records rebind across a lifecycle generation replacement", () => {
    const controlled = fakeAuthority(snapshot({ generationId: "generation-b" }));
    const submitted: Array<{ ids: string[]; generationId: string }> = [];
    const blocked: string[] = [];
    const spool = new MeshSpool({
      mode: "managed", getSessionId: () => "session-a", authority: controlled.authority,
      submit: (_lane, values, _submissionId, generationId) => {
        submitted.push({ ids: values.map((value) => value.id), generationId });
        return true;
      },
      onBlocked: (code) => blocked.push(code),
    });
    const restored = message({ stale: true });
    expect(spool.restore("mesh-unsolicited", restored, "generation-a")).toBe(true);
    controlled.set(snapshot({ generationId: "generation-b", phase: "idle" }));
    expect(submitted).toEqual([{ ids: [restored.id], generationId: "generation-b" }]);
    expect(blocked).toContain("rebound-mesh-spool-generation");
  });

  test("startup restores submitted-without-proof and suppresses only an exact batch proof", () => {
    const one = message({ id: "one" });
    const two = message({ id: "two" });
    const event = (
      envelopeValue: typeof one,
      state: PersistedMeshSpoolEvent["state"],
      submissionId?: string,
    ): PersistedMeshSpoolEvent => ({
      schemaVersion: 1,
      sessionId: "session-a",
      state,
      lane: "mesh-unsolicited",
      generationId: "generation-a",
      envelope: envelopeValue,
      ...(submissionId ? { submissionId } : {}),
    });
    const events = [
      event(one, "held"),
      event(two, "held"),
      event(one, "submitting", "submission-a"),
      event(two, "submitting", "submission-a"),
      event(one, "submitted", "submission-a"),
      event(two, "submitted", "submission-a"),
    ];
    expect(recoverableMeshSpoolEvents(events, []).map((value) => value.envelope.id)).toEqual([one.id, two.id]);

    const exact: MeshBatchProof = {
      sessionId: "session-a",
      generationId: "generation-a",
      submissionId: "submission-a",
      envelopeIds: [one.id, two.id],
    };
    expect(recoverableMeshSpoolEvents(events, [exact])).toEqual([]);
    expect(recoverableMeshSpoolEvents(events, [{ ...exact, envelopeIds: [two.id, one.id] }])
      .map((value) => value.envelope.id)).toEqual([one.id, two.id]);
    expect(recoverableMeshSpoolEvents(events, [{ ...exact, sessionId: "other-session" }])
      .map((value) => value.envelope.id)).toEqual([one.id, two.id]);
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
