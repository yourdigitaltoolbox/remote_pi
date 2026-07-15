import { describe, expect, test } from "vitest";
import type { SessionExposurePolicy } from "./child_policy.js";
import type { LocalConfigInspection } from "./local_config.js";
import { EpochFence, agentIdFromSessionId, resolveRuntimeIdentity, rollRuntimeIdentity } from "./runtime_identity.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const EPOCH_1 = "33333333-3333-4333-8333-333333333333";
const EPOCH_2 = "44444444-4444-4444-8444-444444444444";

function loadedConfig(workspaceId = WORKSPACE_ID): LocalConfigInspection {
  return {
    state: "loaded",
    config: { agent_name: "configured", auto_start_relay: true },
    schemaVersion: 1,
    revision: 2,
    workspaceId,
    path: "/workspace/.pi/remote-pi/config.json",
    hash: "a".repeat(64),
  };
}

function childPolicy(workspaceId = WORKSPACE_ID): SessionExposurePolicy {
  return {
    classification: "child_current",
    mode: "local",
    source: "descriptor",
    descriptor: {
      version: 1,
      kind: "pi-subagent-child",
      sessionClass: "child",
      runId: "run-1",
      workspaceId,
      agentId: AGENT_ID,
      processEpoch: EPOCH_1,
      index: 0,
      requestedExposure: "local",
      producer: { name: "pi-subagents", version: "0.34.0", protocolVersion: 1, manifestSha256: "b".repeat(64) },
      compatibility: { remotePi: { state: "compatible", version: "0.5.4", protocolVersion: 1, manifestSha256: "c".repeat(64) } },
    },
  };
}

describe("runtime identity", () => {
  test("uses current child descriptor IDs exactly and rejects a durable workspace mismatch", () => {
    expect(resolveRuntimeIdentity({ config: loadedConfig(), exposure: childPolicy(), displayName: "worker" })).toEqual({
      status: "ready",
      identity: { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, processEpoch: EPOCH_1 },
      presentation: { displayName: "worker" },
      source: { workspaceId: "config+descriptor", agentId: "descriptor", processEpoch: "descriptor" },
    });

    expect(resolveRuntimeIdentity({ config: loadedConfig(), exposure: childPolicy("55555555-5555-4555-8555-555555555555"), displayName: "worker" }))
      .toMatchObject({ status: "repair_required", reason: "workspace_identity_mismatch" });
  });

  test("derives a stable logical agent ID from Pi session state but rotates process epoch", () => {
    const first = resolveRuntimeIdentity({
      config: loadedConfig(),
      exposure: { classification: "normal", mode: "relay", source: "normal-config" },
      sessionId: "pi-session-abc",
      processEpoch: EPOCH_1,
      displayName: "before",
    });
    const second = resolveRuntimeIdentity({
      config: loadedConfig(),
      exposure: { classification: "normal", mode: "relay", source: "normal-config" },
      sessionId: "pi-session-abc",
      processEpoch: EPOCH_2,
      displayName: "after",
    });
    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") return;
    expect(first.identity.agentId).toBe(agentIdFromSessionId("pi-session-abc"));
    expect(second.identity.agentId).toBe(first.identity.agentId);
    expect(second.identity.processEpoch).not.toBe(first.identity.processEpoch);
    expect(second.presentation.displayName).toBe("after");
  });

  test("rolls only agentId from the preferred identity and current process epoch", () => {
    const preferred = { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, processEpoch: EPOCH_1 };
    const first = rollRuntimeIdentity(preferred);
    const repeat = rollRuntimeIdentity(preferred);
    const nextProcess = rollRuntimeIdentity({ ...preferred, processEpoch: EPOCH_2 });

    expect(first).toEqual(repeat);
    expect(first).toMatchObject({ workspaceId: WORKSPACE_ID, processEpoch: EPOCH_1 });
    expect(first.agentId).not.toBe(AGENT_ID);
    expect(nextProcess.agentId).not.toBe(first.agentId);
    expect(preferred).toEqual({ workspaceId: WORKSPACE_ID, agentId: AGENT_ID, processEpoch: EPOCH_1 });
  });

  test("supports a supervisor-injected workspace identity without durable cwd config", () => {
    const missing: LocalConfigInspection = { state: "missing", config: {}, revision: 0, path: "/workspace/.pi/remote-pi/config.json" };
    const resolved = resolveRuntimeIdentity({
      config: missing,
      exposure: { classification: "normal", mode: "relay", source: "normal-config" },
      sessionId: "daemon-session",
      injectedWorkspaceId: WORKSPACE_ID,
      processEpoch: EPOCH_1,
      displayName: "daemon",
    });
    expect(resolved).toMatchObject({
      status: "ready",
      identity: { workspaceId: WORKSPACE_ID, processEpoch: EPOCH_1 },
      source: { workspaceId: "injected" },
    });
    expect(resolveRuntimeIdentity({
      config: loadedConfig(),
      exposure: { classification: "normal", mode: "relay", source: "normal-config" },
      sessionId: "daemon-session",
      injectedWorkspaceId: "55555555-5555-4555-8555-555555555555",
      processEpoch: EPOCH_1,
      displayName: "daemon",
    })).toMatchObject({ status: "repair_required", reason: "workspace_identity_mismatch" });
  });

  test("fences stale epochs without letting stale retirement affect the replacement", () => {
    const fence = new EpochFence();
    const first = { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, processEpoch: EPOCH_1 };
    const second = { ...first, processEpoch: EPOCH_2 };
    expect(fence.activate(first)).toBe("activated");
    expect(fence.activate(first)).toBe("idempotent");
    expect(fence.activate(second)).toBe("replaced");
    expect(fence.isCurrent(first)).toBe(false);
    expect(fence.retire(first)).toBe(false);
    expect(fence.isCurrent(second)).toBe(true);
    expect(fence.retire(second)).toBe(true);
  });
});
