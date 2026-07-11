import { describe, expect, test } from "vitest";
import {
  parseRelayRunnerDelegateRequest,
  parseRelayRunnerDelegateResult,
  parseRelayRunnerRequest,
} from "./relay_runner_rpc.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const binding = {
  runId: "run-async",
  workspaceId,
  agentId: "22222222-2222-4222-8222-222222222222",
  processEpoch: "33333333-3333-4333-8333-333333333333",
  mode: "relay" as const,
};
const token = `rprd1.44444444-4444-4444-8444-444444444444.${"a".repeat(43)}`;

 describe("relay runner RPC schemas", () => {
  test("accepts exact bounded delegate and rejects authority-looking schema drift", () => {
    const request = {
      type: "relay_runner_delegate",
      version: 1,
      rootRunId: binding.runId,
      workspaceId,
      delegationTtlMs: 60_000,
      maxLeaseTtlMs: 30_000,
      maxChildIssues: 4,
    };
    expect(parseRelayRunnerDelegateRequest(request)).toEqual(request);
    for (const extra of [{ capability: "forged" }, { workloadId: "forged" }, { nonce: "forged" }, { task: "secret" }]) {
      expect(parseRelayRunnerDelegateRequest({ ...request, ...extra })).toBeUndefined();
    }
  });

  test("parses exact delegate results without accepting malformed tokens", () => {
    const success = {
      type: "relay_runner_delegate_result",
      version: 1,
      ok: true,
      token,
      expiresAt: Date.now() + 60_000,
      maxLeaseTtlMs: 30_000,
      maxChildIssues: 4,
    };
    expect(parseRelayRunnerDelegateResult(success)).toEqual(success);
    expect(parseRelayRunnerDelegateResult({ ...success, token: "rpel1.not-a-runner-token" })).toBeUndefined();
    expect(parseRelayRunnerDelegateResult({ ...success, socketPath: "/tmp/forged" })).toBeUndefined();
  });

  test("accepts exact issue, renew, close, revoke, and release requests only", () => {
    const requests = [
      { type: "relay_runner_issue", version: 1, requestId: "55555555-5555-4555-8555-555555555555", token, binding, ttlMs: 30_000 },
      { type: "relay_runner_renew", version: 1, requestId: "55555555-5555-4555-8555-555555555555", token, relayExposureLeaseId: "66666666-6666-4666-8666-666666666666", renewalId: "77777777-7777-4777-8777-777777777777", binding, ttlMs: 30_000 },
      { type: "relay_runner_revoke", version: 1, requestId: "55555555-5555-4555-8555-555555555555", token, relayExposureLeaseId: "66666666-6666-4666-8666-666666666666", binding },
      { type: "relay_runner_close", version: 1, requestId: "55555555-5555-4555-8555-555555555555", token, relayExposureLeaseId: "66666666-6666-4666-8666-666666666666", binding, reason: "completed" },
      { type: "relay_runner_release", version: 1, requestId: "55555555-5555-4555-8555-555555555555", token },
    ];
    for (const request of requests) {
      expect(parseRelayRunnerRequest(request)).toEqual(request);
      expect(parseRelayRunnerRequest({ ...request, capability: "forged" })).toBeUndefined();
    }
  });
});
