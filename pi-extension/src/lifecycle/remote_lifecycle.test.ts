import { describe, expect, test } from "vitest";
import type { CompactDisposition, DiagnosticRecord, LifecycleEvent, RepairDisposition, RepairRequest, Snapshot } from "@yourdigitaltoolbox/pi-context-lifecycle";
import { RemoteLifecycleController, type LifecycleAuthority } from "./remote_lifecycle.js";

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    protocolVersion: 1,
    registryState: "ready",
    sequence: 1,
    sessionId: "session-a",
    generationId: "generation-a",
    phase: "idle",
    ...overrides,
  };
}

function authority(initial: Snapshot) {
  let current = initial;
  const listeners = new Set<(event: LifecycleEvent) => void>();
  const requests: Parameters<LifecycleAuthority["request"]>[0][] = [];
  const repairs: RepairRequest[] = [];
  let result: CompactDisposition = { disposition: "accepted", operationId: "operation-a", generationId: "generation-a" };
  const value: LifecycleAuthority = {
    snapshot: () => current,
    observe(listener) {
      listeners.add(listener);
      return { snapshot: current, unsubscribe: () => listeners.delete(listener) };
    },
    request(request) { requests.push(request); return result; },
    repair(request) {
      repairs.push(request);
      return { disposition: "applied", action: request.action, operationId: request.operationId, generationId: request.generationId };
    },
    diagnostics: () => [{ protocolVersion: 1, sequence: 2, timestamp: 1, code: "redacted", operationId: "operation-a", phase: "compacting" }] satisfies DiagnosticRecord[],
  };
  return {
    value,
    requests,
    repairs,
    setResult(next: CompactDisposition) { result = next; },
    emit(next: Snapshot) {
      current = next;
      for (const listener of listeners) listener({ ...next, event: "snapshot" });
    },
  };
}

describe("RemoteLifecycleController", () => {
  test("correlates accepted/joined compact actions and terminal lifecycle evidence", () => {
    const controlled = authority(snapshot());
    const events: unknown[] = [];
    const controller = new RemoteLifecycleController((event) => events.push(event), controlled.value);
    controller.bind("session-a");

    expect(controller.request("request-a")).toMatchObject({ disposition: "accepted", operationId: "operation-a" });
    expect(controlled.requests).toEqual([{
      requestId: "request-a", sessionId: "session-a", generationId: "generation-a", reason: "remote", source: "remote-pi-action",
    }]);
    controlled.setResult({ disposition: "joined", operationId: "operation-a", generationId: "generation-a" });
    expect(controller.request("request-b")).toMatchObject({ disposition: "joined" });
    controlled.emit(snapshot({ sequence: 2, phase: "compacting", operationId: "operation-a" }));
    controlled.emit(snapshot({ sequence: 3, phase: "idle", lastOutcome: "completed" }));

    expect(events).toEqual([
      { type: "accepted", operationId: "operation-a", sessionId: "session-a", generationId: "generation-a" },
      { type: "joined", operationId: "operation-a", sessionId: "session-a", generationId: "generation-a" },
      { type: "terminal", operationId: "operation-a", sessionId: "session-a", generationId: "generation-a", outcome: "completed" },
    ]);
  });

  test("maps lifecycle failure/cancellation and fences stale-generation observer callbacks", () => {
    const controlled = authority(snapshot());
    const events: unknown[] = [];
    const controller = new RemoteLifecycleController((event) => events.push(event), controlled.value);
    controller.bind("session-a");
    controller.request("request-a");
    controlled.emit(snapshot({ sequence: 2, phase: "idle", lastOutcome: "failed" }));
    expect(events.at(-1)).toMatchObject({ type: "terminal", outcome: "failed" });

    controller.bind("session-a");
    controller.request("request-b");
    controlled.emit(snapshot({ sequence: 3, generationId: "generation-stale", phase: "idle", lastOutcome: "cancelled" }));
    expect(events.at(-1)).toMatchObject({ type: "accepted" });
    controlled.emit(snapshot({ sequence: 4, phase: "idle", lastOutcome: "cancelled" }));
    expect(events.at(-1)).toMatchObject({ type: "terminal", outcome: "cancelled" });
  });

  test("fails closed when the authority/session/generation cannot be proven", () => {
    const controlled = authority(snapshot({ registryState: "unavailable", sessionId: undefined, generationId: undefined, phase: undefined }));
    const controller = new RemoteLifecycleController(() => undefined, controlled.value);
    controller.bind("session-a");
    expect(controller.request("request-a")).toMatchObject({ disposition: "rejected", code: "lifecycle-authority-unavailable" });
    expect(controlled.requests).toEqual([]);
  });

  test("surfaces blocked state and forwards remote repair with mandatory actor/channel", () => {
    const controlled = authority(snapshot());
    const events: unknown[] = [];
    const controller = new RemoteLifecycleController((event) => events.push(event), controlled.value);
    controller.bind("session-a");
    controller.request("request-a");
    controlled.emit(snapshot({ sequence: 2, phase: "blocked-unknown", operationId: "operation-a" }));
    expect(events.at(-1)).toMatchObject({ type: "terminal", outcome: "blocked", code: "blocked-unknown" });

    const repair = controller.repair({
      action: "abandon-ambiguous-resume",
      operationId: "operation-a",
      sessionId: "session-a",
      generationId: "generation-a",
      expectedPhase: "blocked-unknown",
      expectedSequence: 2,
      evidenceClass: "current-process-quiescent",
    });
    expect(repair).toMatchObject({ disposition: "applied", operationId: "operation-a" });
    expect(controlled.repairs[0]).toMatchObject({ actor: "operator", channel: "remote" });
  });

  test("turns authority disappearance or disposal into a correlated degraded terminal state", () => {
    const controlled = authority(snapshot());
    const events: unknown[] = [];
    const controller = new RemoteLifecycleController((event) => events.push(event), controlled.value);
    controller.bind("session-a");
    controller.request("request-a");
    controlled.emit(snapshot({ sequence: 2, registryState: "disposing", sessionId: undefined, generationId: undefined, phase: undefined }));
    expect(events.at(-1)).toMatchObject({ type: "terminal", outcome: "blocked", code: "lifecycle-authority-disposing" });

    controlled.emit(snapshot({ sequence: 3 }));
    controller.bind("session-a");
    controller.request("request-b");
    controller.dispose();
    expect(events.at(-1)).toMatchObject({ type: "terminal", outcome: "blocked", code: "lifecycle-authority-disposed" });
  });

  test("status exposes bounded metadata but never consumer payloads", () => {
    const controlled = authority(snapshot());
    const controller = new RemoteLifecycleController(() => undefined, controlled.value);
    controller.bind("session-a");
    const status = controller.status();
    expect(status.snapshot).toMatchObject({ registryState: "ready", sessionId: "session-a" });
    expect(status.diagnostics).toEqual([{ sequence: 2, timestamp: 1, code: "redacted", operationId: "operation-a", phase: "compacting" }]);
    expect(JSON.stringify(status)).not.toContain("request-a");
  });
});
