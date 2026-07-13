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
  test("reports held then released only from the production-owned mesh spool", async () => {
    const controlled = meshAuthority();
    const submitted: string[] = [];
    const followUps: string[] = [];
    let settled = false;
    let binding: ReturnType<typeof bindProductionMeshProbe> | undefined;
    const spool = new MeshSpool({
      mode: "managed",
      getSessionId: () => "remote-pi-probe-session",
      authority: controlled.authority,
      submit: (_lane, envelopes) => {
        // The production boundary receives this callback only after the
        // lifecycle's post-settlement release cut; model it as one follow-up
        // turn per released batch, not a turn while the receipt is held.
        expect(settled).toBe(true);
        submitted.push(...envelopes.map((envelope) => envelope.id));
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

    const receipt = await probe.inject({
      consumer: "remote-pi",
      kind: "mesh-arrival",
      id: "mesh-opaque-id",
      lane: "unsolicited",
    });
    expect(receipt).toMatchObject({ consumer: "remote-pi", id: "mesh-opaque-id", outcome: "held", generationId: "generation-a" });
    expect(Object.isFrozen(receipt)).toBe(true);
    // The archive seam observes a held receipt before it can wake Pi.
    expect(submitted).toEqual([]);
    expect(followUps).toEqual([]);

    settled = true;
    controlled.settle();
    expect(submitted).toEqual(["mesh-opaque-id"]);
    expect(followUps).toEqual(["mesh-opaque-id"]);
    expect(await probe.observations()).toEqual([
      receipt,
      expect.objectContaining({ consumer: "remote-pi", id: "mesh-opaque-id", outcome: "released", generationId: "generation-a" }),
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
