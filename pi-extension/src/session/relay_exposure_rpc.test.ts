import { describe, expect, test } from "vitest";
import {
  parseRelayExposureActivationBrokerReply,
  parseRelayExposureActivationBrokerRequest,
  parseRelayExposureCloseBrokerRequest,
  parseRelayExposureClosedNotice,
  parseRelayExposureIssueBrokerReply,
  parseRelayExposureIssueBrokerRequest,
  parseRelayExposureLifecycleBrokerReply,
  parseRelayExposureCloseRequest,
  parseRelayExposurePromoteBrokerReply,
  parseRelayExposurePromoteBrokerRequest,
  parseRelayExposurePromoteRequest,
  parseRelayExposurePromotedNotice,
  parseRelayExposureIssueRequest,
  parseRelayExposureRenewBrokerRequest,
  parseRelayExposureRenewRequest,
  parseRelayExposureRevokeRequest,
  parseRelayExposureRenewedNotice,
  parseRelayExposureRevokeBrokerRequest,
  parseRelayRunnerDelegateEventRequest,
} from "./relay_exposure_rpc.js";

const binding = {
  runId: "run-1",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  processEpoch: "33333333-3333-4333-8333-333333333333",
  mode: "relay" as const,
};
const lease = {
  relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
  parent: {
    workspaceId: "55555555-5555-4555-8555-555555555555",
    agentId: "66666666-6666-4666-8666-666666666666",
    processEpoch: "77777777-7777-4777-8777-777777777777",
  },
  binding,
  issuedAt: 1_000,
  expiresAt: 31_000,
};
const capability = `rpel1.${lease.relayExposureLeaseId}.${"a".repeat(43)}`;

describe("relay exposure broker RPC schemas", () => {
  test("accepts only exact versioned issuance requests", () => {
    const request = {
      version: 1,
      requestId: "88888888-8888-4888-8888-888888888888",
      method: "issue",
      binding,
      ttlMs: 30_000,
      intentSource: "agent" as const,
    };
    expect(parseRelayExposureIssueRequest(request)).toEqual(request);
    const { intentSource: _legacySource, ...legacyRequest } = request;
    expect(parseRelayExposureIssueRequest(legacyRequest)).toEqual({ ...legacyRequest, intentSource: "agent" });
    expect(parseRelayExposureIssueRequest({ ...request, version: 2 })).toBeUndefined();
    expect(parseRelayExposureIssueRequest({ ...request, requestId: "not-a-uuid" })).toBeUndefined();
    expect(parseRelayExposureIssueRequest({ ...request, workloadId: "forged" })).toBeUndefined();
    expect(parseRelayExposureIssueRequest({
      ...request,
      binding: { ...binding, role: "writer" },
    })).toBeUndefined();
    const promote = { ...legacyRequest, method: "promote" };
    expect(parseRelayExposurePromoteRequest(promote)).toEqual(promote);
    expect(parseRelayExposurePromoteRequest({ ...promote, capability })).toBeUndefined();

    const renew = {
      version: 1,
      requestId: request.requestId,
      method: "renew",
      relayExposureLeaseId: lease.relayExposureLeaseId,
      renewalId: "99999999-9999-4999-8999-999999999999",
      binding,
      ttlMs: 30_000,
    };
    expect(parseRelayExposureRenewRequest(renew)).toEqual(renew);
    expect(parseRelayExposureRenewRequest({ ...renew, task: "secret" })).toBeUndefined();

    const revoke = {
      version: 1,
      requestId: request.requestId,
      method: "revoke",
      relayExposureLeaseId: lease.relayExposureLeaseId,
      binding,
    };
    expect(parseRelayExposureRevokeRequest(revoke)).toEqual(revoke);
    expect(parseRelayExposureRevokeRequest({ ...revoke, role: "writer" })).toBeUndefined();

    const close = { ...revoke, method: "close", reason: "completed" };
    expect(parseRelayExposureCloseRequest(close)).toEqual(close);
    expect(parseRelayExposureCloseRequest({ ...close, reason: "deploy" })).toBeUndefined();

    const delegateRunner = {
      version: 1,
      requestId: request.requestId,
      method: "delegate_runner",
      rootRunId: "run-async",
      workspaceId: binding.workspaceId,
      delegationTtlMs: 60_000,
      maxLeaseTtlMs: 30_000,
      maxChildIssues: 4,
      intentSources: ["agent", "fallback"] as const,
    };
    expect(parseRelayRunnerDelegateEventRequest(delegateRunner)).toEqual(delegateRunner);
    const { intentSources: _legacyRunnerSources, ...legacyRunner } = delegateRunner;
    expect(parseRelayRunnerDelegateEventRequest(legacyRunner)).toEqual({ ...legacyRunner, intentSources: ["agent"] });
    expect(parseRelayRunnerDelegateEventRequest({ ...delegateRunner, intentSources: ["run", "run"] })).toBeUndefined();
    expect(parseRelayRunnerDelegateEventRequest({ ...delegateRunner, capability: "forged" })).toBeUndefined();
    expect(parseRelayRunnerDelegateEventRequest({ ...delegateRunner, workloadId: "forged" })).toBeUndefined();

    const renewResult = {
      type: "relay_lease_renew_result",
      ok: true,
      state: "renewed",
      lease: { ...lease, expiresAt: 61_000 },
    };
    expect(parseRelayExposureLifecycleBrokerReply(renewResult, renew, 0)).toEqual(renewResult);
    expect(parseRelayExposureLifecycleBrokerReply({ ...renewResult, role: "writer" }, renew, 0)).toBeUndefined();
    expect(parseRelayExposureLifecycleBrokerReply({
      ...renewResult,
      lease: { ...renewResult.lease, relayExposureLeaseId: "77777777-7777-4777-8777-777777777777" },
    }, renew, 0)).toBeUndefined();
    expect(parseRelayExposureLifecycleBrokerReply({
      type: "relay_lease_close_result",
      ok: true,
      state: "closed",
      lease,
    }, close, 0)).toMatchObject({ ok: true, state: "closed" });
  });

  test("accepts only exact broker issue and activation requests", () => {
    const issue = { type: "relay_lease_issue", binding, ttlMs: 30_000 };
    expect(parseRelayExposureIssueBrokerRequest(issue)).toEqual(issue);
    expect(parseRelayExposureIssueBrokerRequest({ ...issue, workloadId: "forged" })).toBeUndefined();
    expect(parseRelayExposureIssueBrokerRequest({
      ...issue,
      binding: { ...binding, role: "writer" },
    })).toBeUndefined();
    const promote = { type: "relay_lease_promote", binding, ttlMs: 30_000 };
    expect(parseRelayExposurePromoteBrokerRequest(promote)).toEqual(promote);
    expect(parseRelayExposurePromoteBrokerRequest({ ...promote, capability })).toBeUndefined();

    const activation = {
      type: "relay_lease_activate",
      capability,
      runId: binding.runId,
      mode: "relay",
    };
    expect(parseRelayExposureActivationBrokerRequest(activation)).toEqual(activation);
    expect(parseRelayExposureActivationBrokerRequest({ ...activation, workloadId: "forged" })).toBeUndefined();
    expect(parseRelayExposureActivationBrokerRequest({ ...activation, mode: "local" })).toBeUndefined();
  });

  test("accepts only exact fenced renew, revoke, and close requests", () => {
    const renew = {
      type: "relay_lease_renew",
      relayExposureLeaseId: lease.relayExposureLeaseId,
      renewalId: "88888888-8888-4888-8888-888888888888",
      binding,
      ttlMs: 30_000,
    };
    expect(parseRelayExposureRenewBrokerRequest(renew)).toEqual(renew);
    expect(parseRelayExposureRenewBrokerRequest({ ...renew, processEpoch: binding.processEpoch })).toBeUndefined();
    expect(parseRelayExposureRenewBrokerRequest({ ...renew, renewalId: "bad" })).toBeUndefined();

    const revoke = {
      type: "relay_lease_revoke",
      relayExposureLeaseId: lease.relayExposureLeaseId,
      binding,
    };
    expect(parseRelayExposureRevokeBrokerRequest(revoke)).toEqual(revoke);
    expect(parseRelayExposureRevokeBrokerRequest({ ...revoke, role: "writer" })).toBeUndefined();

    const close = {
      type: "relay_lease_close",
      relayExposureLeaseId: lease.relayExposureLeaseId,
      binding,
      reason: "timeout",
    };
    expect(parseRelayExposureCloseBrokerRequest(close)).toEqual(close);
    expect(parseRelayExposureCloseBrokerRequest({ ...close, reason: "deploy" })).toBeUndefined();
    expect(parseRelayExposureCloseBrokerRequest({ ...close, task: "secret" })).toBeUndefined();
  });

  test("accepts only exact promotion replies and promoted notices without a bearer", () => {
    const reply = { type: "relay_lease_promote_result", ok: true, state: "promoted", lease };
    expect(parseRelayExposurePromoteBrokerReply(reply, binding, 0)).toEqual(reply);
    expect(parseRelayExposurePromoteBrokerReply({ ...reply, capability }, binding, 0)).toBeUndefined();
    expect(parseRelayExposurePromoteBrokerReply({ ...reply, lease: { ...lease, binding: { ...binding, role: "writer" } } }, binding, 0)).toBeUndefined();

    const notice = { type: "relay_lease_promoted", version: 1, lease };
    expect(parseRelayExposurePromotedNotice(notice, 0)).toEqual(notice);
    expect(parseRelayExposurePromotedNotice({ ...notice, capability }, 0)).toBeUndefined();
    expect(parseRelayExposurePromotedNotice(notice, lease.expiresAt)).toBeUndefined();
  });

  test("accepts only exact fresh relay-renewed notices", () => {
    const renewed = {
      type: "relay_lease_renewed",
      version: 1,
      relayExposureLeaseId: lease.relayExposureLeaseId,
      binding,
      expiresAt: 31_000,
    };
    expect(parseRelayExposureRenewedNotice(renewed, 0)).toEqual(renewed);
    expect(parseRelayExposureRenewedNotice({ ...renewed, role: "writer" }, 0)).toBeUndefined();
    expect(parseRelayExposureRenewedNotice(renewed, 31_000)).toBeUndefined();
  });

  test("accepts only exact fenced relay-closed notices", () => {
    const expired = {
      type: "relay_lease_closed",
      version: 1,
      relayExposureLeaseId: lease.relayExposureLeaseId,
      binding,
      reason: "expired",
    };
    expect(parseRelayExposureClosedNotice(expired)).toEqual(expired);
    expect(parseRelayExposureClosedNotice({ ...expired, workloadId: "forged" })).toBeUndefined();
    expect(parseRelayExposureClosedNotice({ ...expired, closeReason: "timeout" })).toBeUndefined();
    const normal = { ...expired, reason: "child_closed", closeReason: "timeout" };
    expect(parseRelayExposureClosedNotice(normal)).toEqual(normal);
    expect(parseRelayExposureClosedNotice({ ...normal, closeReason: "deploy" })).toBeUndefined();
  });

  test("accepts only an exact fresh issuance success and binds capability ID to lease ID", () => {
    const valid = {
      type: "relay_lease_issue_result",
      ok: true,
      capability,
      lease,
    };
    expect(parseRelayExposureIssueBrokerReply(valid, 0)).toEqual(valid);
    expect(parseRelayExposureIssueBrokerReply({ ...valid, authority: "apex" }, 0)).toBeUndefined();
    expect(parseRelayExposureIssueBrokerReply({
      ...valid,
      capability: `rpel1.88888888-8888-4888-8888-888888888888.${"a".repeat(43)}`,
    }, 0)).toBeUndefined();
    expect(parseRelayExposureIssueBrokerReply({
      ...valid,
      lease: { ...lease, parent: { ...lease.parent, role: "writer" } },
    }, 0)).toBeUndefined();
    expect(parseRelayExposureIssueBrokerReply({
      ...valid,
      lease: { ...lease, binding: { ...binding, workloadId: "forged" } },
    }, 0)).toBeUndefined();
    expect(parseRelayExposureIssueBrokerReply({
      ...valid,
      lease: { ...lease, issuedAt: 0, expiresAt: 999 },
    }, 1_000)).toBeUndefined();
  });

  test("accepts only exact activation success and failure variants", () => {
    const valid = {
      type: "relay_lease_activate_result",
      ok: true,
      state: "activated",
      lease,
    };
    expect(parseRelayExposureActivationBrokerReply(valid, capability, 0)).toEqual(valid);
    expect(parseRelayExposureActivationBrokerReply({ ...valid, nonce: "secret" }, capability, 0)).toBeUndefined();
    expect(parseRelayExposureActivationBrokerReply({
      ...valid,
      lease: { ...lease, binding: { ...binding, extra: true } },
    }, capability, 0)).toBeUndefined();
    expect(parseRelayExposureActivationBrokerReply(
      valid,
      `rpel1.88888888-8888-4888-8888-888888888888.${"a".repeat(43)}`,
      0,
    )).toBeUndefined();
    expect(parseRelayExposureActivationBrokerReply({
      type: "relay_lease_activate_result",
      ok: false,
      reason: "binding_mismatch",
      field: "processEpoch",
    }, capability, 0)).toEqual({
      type: "relay_lease_activate_result",
      ok: false,
      reason: "binding_mismatch",
      field: "processEpoch",
    });
    expect(parseRelayExposureActivationBrokerReply({
      type: "relay_lease_activate_result",
      ok: false,
      reason: "binding_mismatch",
      field: "processEpoch",
      extra: true,
    }, capability, 0)).toBeUndefined();
  });
});
