import { describe, expect, test } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifecycleEvent, Snapshot } from "@yourdigitaltoolbox/pi-context-lifecycle";
import { MeshSpool, type MeshSpoolAuthority } from "../session/mesh_spool.js";
import { bindProductionMeshProbe } from "./production_mesh_probe.js";
import { createExactCandidateProbe } from "./index.js";

function session(): AgentSession {
  return {
    sessionId: "remote-pi-probe-session",
    sendCustomMessage: async () => undefined,
  } as unknown as AgentSession;
}

function meshAuthority() {
  let current: Snapshot = {
    protocolVersion: 1,
    registryState: "ready",
    sequence: 1,
    sessionId: "remote-pi-probe-session",
    generationId: "generation-a",
    phase: "compacting",
  };
  const listeners = new Set<(event: LifecycleEvent) => void>();
  const authority: MeshSpoolAuthority = {
    snapshot: () => current,
    observe(listener) {
      listeners.add(listener);
      return { snapshot: current, unsubscribe: () => listeners.delete(listener) };
    },
    admitWake: (_request, permit) => current.phase === "idle" || permit
      ? { disposition: "deliver", code: "idle", generationId: current.generationId! }
      : { disposition: "hold", code: "lifecycle-active", generationId: current.generationId! },
    registerDrainer() {
      return () => undefined;
    },
  };
  return {
    authority,
    settle() {
      current = { ...current, sequence: 2, phase: "idle" };
      for (const listener of listeners) listener({ ...current, event: "snapshot" });
    },
  };
}

describe("remote-pi/testing", () => {
  test("reports lane-tagged held and released receipts in reply-before-unsolicited order from the production-owned mesh spool", async () => {
    const controlled = meshAuthority();
    const submitted: Array<{ lane: string; ids: string[] }> = [];
    const followUps: string[] = [];
    let settled = false;
    let binding: ReturnType<typeof bindProductionMeshProbe> | undefined;
    const spool = new MeshSpool({
      mode: "managed",
      getSessionId: () => "remote-pi-probe-session",
      authority: controlled.authority,
      submit: (lane, envelopes) => {
        // The production boundary receives this callback only after the
        // lifecycle's post-settlement release cut; model it as one follow-up
        // turn per released batch, not a turn while the receipt is held.
        expect(settled).toBe(true);
        submitted.push({ lane, ids: envelopes.map((envelope) => envelope.id) });
        followUps.push(...envelopes.map((envelope) => envelope.id));
        return true;
      },
      onTransition: (transition) => binding?.publish(transition),
    });
    binding = bindProductionMeshProbe("remote-pi-probe-session", ({ id, lane }) => spool.accept({
      from: "remote-pi-probe",
      to: "remote-pi-probe-target",
      id,
      re: lane === "mesh-reply" ? id : null,
      body: null,
      deliveryReceipt: { required: true },
    }));
    const probe = createExactCandidateProbe({
      session: session(),
      seed: "archive-seed",
      packageDirectory: "/candidate/node_modules/remote-pi",
    });

    const unsolicitedReceipt = await probe.inject({
      consumer: "remote-pi",
      kind: "mesh-arrival",
      id: "mesh-unsolicited-id",
      lane: "unsolicited",
    });
    const replyReceipt = await probe.inject({
      consumer: "remote-pi",
      kind: "mesh-arrival",
      id: "mesh-reply-id",
      lane: "reply",
    });
    expect(unsolicitedReceipt).toEqual({
      consumer: "remote-pi", id: "mesh-unsolicited-id", lane: "mesh-unsolicited", outcome: "held", generationId: "generation-a",
    });
    expect(replyReceipt).toEqual({
      consumer: "remote-pi", id: "mesh-reply-id", lane: "mesh-reply", outcome: "held", generationId: "generation-a",
    });
    expect(Object.isFrozen(replyReceipt)).toBe(true);
    // The archive seam observes both held receipts before either can wake Pi.
    expect(submitted).toEqual([]);
    expect(followUps).toEqual([]);

    settled = true;
    controlled.settle();
    // Actual production spool submission and the redacted testing receipts
    // expose the same reply-first lane ordering without envelope contents.
    expect(submitted).toEqual([
      { lane: "mesh-reply", ids: ["mesh-reply-id"] },
      { lane: "mesh-unsolicited", ids: ["mesh-unsolicited-id"] },
    ]);
    expect(followUps).toEqual(["mesh-reply-id", "mesh-unsolicited-id"]);
    expect(await probe.observations()).toEqual([
      unsolicitedReceipt,
      replyReceipt,
      { consumer: "remote-pi", id: "mesh-reply-id", lane: "mesh-reply", outcome: "released", generationId: "generation-a" },
      { consumer: "remote-pi", id: "mesh-unsolicited-id", lane: "mesh-unsolicited", outcome: "released", generationId: "generation-a" },
    ]);

    await probe.dispose();
    binding.dispose();
    spool.dispose();
  });

  test("rejects mesh injection when no loaded production extension owns the spool", async () => {
    const probe = createExactCandidateProbe({
      session: session(),
      seed: "archive-seed",
      packageDirectory: "/candidate/node_modules/remote-pi",
    });

    await expect(probe.inject({
      consumer: "remote-pi",
      kind: "mesh-arrival",
      id: "unbound-mesh",
      lane: "reply",
    })).resolves.toMatchObject({ outcome: "rejected" });
    await probe.dispose();
  });
});
