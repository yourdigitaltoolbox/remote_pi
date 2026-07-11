import { describe, expect, test } from "vitest";
import {
  CHILD_DESCRIPTOR_ENV,
  LEGACY_CHILD_ENV,
  resolveSessionExposure,
  type ChildSessionDescriptorV1,
} from "./child_policy.js";

function descriptor(overrides: Partial<ChildSessionDescriptorV1> = {}): ChildSessionDescriptorV1 {
  return {
    version: 1,
    kind: "pi-subagent-child",
    sessionClass: "child",
    runId: "run-1",
    agentId: "reviewer",
    processEpoch: "epoch-1",
    ...overrides,
  };
}

describe("child session exposure policy", () => {
  test("normal sessions retain configured relay auto-start behavior", () => {
    expect(resolveSessionExposure({}, { auto_start_relay: true })).toMatchObject({
      classification: "normal",
      mode: "relay",
      source: "normal-config",
    });
    expect(resolveSessionExposure({}, { auto_start_relay: false })).toMatchObject({
      classification: "normal",
      mode: "local",
      source: "normal-config",
    });
  });

  test("legacy pi-subagents children are capped at local despite cwd relay consent", () => {
    expect(resolveSessionExposure({ [LEGACY_CHILD_ENV]: "1" }, { auto_start_relay: true })).toEqual({
      classification: "child_legacy",
      mode: "local",
      source: "legacy-marker",
      diagnostic: "legacy child marker is local-only",
    });
  });

  test("a valid current descriptor classifies the child but does not self-authorize relay", () => {
    const env = {
      [CHILD_DESCRIPTOR_ENV]: JSON.stringify(descriptor({ requestedExposure: "relay" })),
    };
    const policy = resolveSessionExposure(env, { auto_start_relay: true });
    expect(policy.classification).toBe("child_current");
    expect(policy.mode).toBe("local");
    expect(policy.source).toBe("descriptor");
    expect(policy.descriptor).toMatchObject({ runId: "run-1", processEpoch: "epoch-1" });
    expect(policy.diagnostic).toContain("relay authorization");
  });

  test.each([
    "{not-json",
    JSON.stringify({ version: 99, kind: "pi-subagent-child", sessionClass: "child" }),
    JSON.stringify(descriptor({ processEpoch: "" })),
  ])("malformed or unsupported claimed-child descriptors fail closed to local", (raw) => {
    const policy = resolveSessionExposure({ [CHILD_DESCRIPTOR_ENV]: raw }, { auto_start_relay: true });
    expect(policy.classification).toBe("child_invalid");
    expect(policy.mode).toBe("local");
    expect(policy.source).toBe("invalid-descriptor");
    expect(policy.diagnostic).toBeTruthy();
  });

  test("a non-empty invalid legacy marker is treated as an invalid child claim", () => {
    expect(resolveSessionExposure({ [LEGACY_CHILD_ENV]: "yes" }, { auto_start_relay: true })).toMatchObject({
      classification: "child_invalid",
      mode: "local",
      source: "invalid-legacy-marker",
    });
  });

  test("unrelated environment values never classify a normal session as a child", () => {
    expect(resolveSessionExposure({ OTHER_EXTENSION: "1" }, {})).toMatchObject({
      classification: "normal",
      mode: "relay",
      source: "normal-config",
    });
  });
});
