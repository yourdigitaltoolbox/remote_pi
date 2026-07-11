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
    workspaceId: "33333333-3333-4333-8333-333333333333",
    agentId: "11111111-1111-5111-8111-111111111111",
    processEpoch: "22222222-2222-4222-8222-222222222222",
    index: 0,
    requestedExposure: "local",
    producer: {
      name: "pi-subagents",
      version: "0.34.0",
      protocolVersion: 1,
      manifestSha256: "a".repeat(64),
    },
    compatibility: {
      remotePi: {
        state: "compatible",
        version: "0.5.4",
        protocolVersion: 1,
        manifestSha256: "b".repeat(64),
      },
    },
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
    expect(policy.descriptor).toMatchObject({
      runId: "run-1",
      workspaceId: "33333333-3333-4333-8333-333333333333",
      processEpoch: "22222222-2222-4222-8222-222222222222",
      producer: { name: "pi-subagents", protocolVersion: 1 },
      compatibility: { remotePi: { state: "compatible", protocolVersion: 1 } },
    });
    expect(policy.diagnostic).toContain("relay authorization");
  });

  test("rejects a valid-looking preflight identity that does not match the loaded package", () => {
    const policy = resolveSessionExposure(
      { [CHILD_DESCRIPTOR_ENV]: JSON.stringify(descriptor()) },
      {},
      { name: "remote-pi", version: "0.5.4", manifestSha256: "c".repeat(64) },
    );
    expect(policy).toMatchObject({
      classification: "child_invalid",
      mode: "local",
      source: "invalid-descriptor",
    });
    expect(policy.diagnostic).toContain("does not match loaded remote-pi");
  });

  test("a descriptor that claimed remote-pi was absent is invalid if remote-pi actually loaded", () => {
    const policy = resolveSessionExposure({
      [CHILD_DESCRIPTOR_ENV]: JSON.stringify(descriptor({ compatibility: { remotePi: { state: "absent" } } })),
    });
    expect(policy).toMatchObject({
      classification: "child_invalid",
      mode: "local",
      source: "invalid-descriptor",
    });
    expect(policy.diagnostic).toContain("not compatibility-preflighted");
  });

  test.each([
    "{not-json",
    JSON.stringify({ version: 99, kind: "pi-subagent-child", sessionClass: "child" }),
    JSON.stringify(descriptor({ processEpoch: "" })),
    JSON.stringify(descriptor({ workspaceId: "" })),
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
