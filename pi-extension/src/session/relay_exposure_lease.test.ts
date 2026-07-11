import { describe, expect, test } from "vitest";
import {
  RelayExposureLeaseAuthority,
  type RelayExposureBinding,
} from "./relay_exposure_lease.js";

const PARENT = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  processEpoch: "33333333-3333-4333-8333-333333333333",
};
const RENEWAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD: RelayExposureBinding = {
  runId: "run-1",
  workspaceId: PARENT.workspaceId,
  agentId: "44444444-4444-4444-8444-444444444444",
  processEpoch: "55555555-5555-4555-8555-555555555555",
  mode: "relay",
};

function fixture() {
  let now = 1_000_000;
  const authority = new RelayExposureLeaseAuthority({ now: () => now });
  const parentConnection = {};
  const childConnection = {};
  authority.authorizeParent(parentConnection, PARENT, {
    delegationTtlMs: 120_000,
    maxLeaseTtlMs: 60_000,
  });
  return {
    authority,
    parentConnection,
    childConnection,
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

function issueFixture() {
  const value = fixture();
  const result = value.authority.issue(value.parentConnection, CHILD, { ttlMs: 30_000 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return { ...value, issued: result };
}

describe("relay exposure lease authority", () => {
  test("only an explicitly authorized live parent connection can issue", () => {
    const authority = new RelayExposureLeaseAuthority();
    expect(authority.issue({}, CHILD, { ttlMs: 30_000 })).toEqual({
      ok: false,
      reason: "unauthorized_parent",
    });
  });

  test("rejects missing and forged capabilities without exposing capability material", () => {
    const { authority, childConnection, issued } = issueFixture();
    expect(authority.activate(undefined, CHILD, childConnection)).toEqual({ ok: false, reason: "missing_capability" });

    const forged = `${issued.capability.slice(0, -1)}${issued.capability.endsWith("a") ? "b" : "a"}`;
    const rejected = authority.activate(forged, CHILD, childConnection);
    expect(rejected).toEqual({ ok: false, reason: "forged_capability" });
    expect(JSON.stringify(rejected)).not.toContain(issued.capability);
  });

  test("rejects expired capabilities and enforces the delegated maximum TTL", () => {
    const { authority, parentConnection, childConnection, advance, issued } = issueFixture();
    advance(30_001);
    expect(authority.activate(issued.capability, CHILD, childConnection)).toEqual({ ok: false, reason: "expired_capability" });
    expect(authority.issue(parentConnection, CHILD, { ttlMs: 60_001 })).toEqual({
      ok: false,
      reason: "ttl_exceeds_maximum",
    });
  });

  test("rejects wrong run, workspace, agent, mode, and process without consuming the valid capability", () => {
    const { authority, childConnection, issued } = issueFixture();
    expect(authority.activate(issued.capability, { ...CHILD, runId: "run-2" }, childConnection)).toEqual({
      ok: false,
      reason: "binding_mismatch",
      field: "runId",
    });
    expect(authority.activate(issued.capability, {
      ...CHILD,
      workspaceId: "66666666-6666-4666-8666-666666666666",
    }, childConnection)).toEqual({ ok: false, reason: "binding_mismatch", field: "workspaceId" });
    expect(authority.activate(issued.capability, {
      ...CHILD,
      agentId: "66666666-6666-4666-8666-666666666666",
    }, childConnection)).toEqual({ ok: false, reason: "binding_mismatch", field: "agentId" });
    expect(authority.activate(issued.capability, {
      ...CHILD,
      mode: "local",
    } as unknown as RelayExposureBinding, childConnection)).toEqual({ ok: false, reason: "forged_capability" });
    expect(authority.activate(issued.capability, {
      ...CHILD,
      processEpoch: "66666666-6666-4666-8666-666666666666",
    }, childConnection)).toEqual({
      ok: false,
      reason: "binding_mismatch",
      field: "processEpoch",
    });
    expect(authority.activate(issued.capability, CHILD, childConnection)).toMatchObject({
      ok: true,
      state: "activated",
      lease: { relayExposureLeaseId: issued.lease.relayExposureLeaseId },
    });
  });

  test("rejects bindings with unknown fields before issuance", () => {
    const { authority, parentConnection } = fixture();
    expect(authority.issue(parentConnection, {
      ...CHILD,
      authority: "apex",
    } as RelayExposureBinding, { ttlMs: 30_000 })).toEqual({
      ok: false,
      reason: "invalid_binding",
    });
  });

  test("rejects duplicate issuance for one live binding without creating a second lease", () => {
    const { authority, parentConnection, issued } = issueFixture();
    expect(authority.issue(parentConnection, CHILD, { ttlMs: 30_000 })).toEqual({
      ok: false,
      reason: "lease_already_exists",
      lease: issued.lease,
    });
  });

  test("atomically promotes the exact child without returning a bearer", () => {
    const { authority, parentConnection, childConnection } = fixture();
    const promoted = authority.promote(parentConnection, CHILD, childConnection, { ttlMs: 30_000 });
    expect(promoted).toMatchObject({
      ok: true,
      state: "promoted",
      lease: { binding: CHILD },
    });
    expect("capability" in promoted).toBe(false);
    expect(authority.promote(parentConnection, CHILD, childConnection, { ttlMs: 30_000 }))
      .toMatchObject({ ok: true, state: "idempotent", lease: promoted.ok ? promoted.lease : undefined });
    expect(authority.promote(parentConnection, CHILD, {}, { ttlMs: 30_000 }))
      .toMatchObject({ ok: false, reason: "lease_already_exists" });
  });

  test("binds activation idempotency to the exact live child connection", () => {
    const { authority, childConnection, issued } = issueFixture();
    expect(authority.activate(issued.capability, CHILD, childConnection)).toMatchObject({ ok: true, state: "activated" });
    expect(authority.activate(issued.capability, CHILD, childConnection)).toMatchObject({
      ok: true,
      state: "idempotent",
      lease: { relayExposureLeaseId: issued.lease.relayExposureLeaseId },
    });
    expect(authority.activate(issued.capability, CHILD, {})).toEqual({ ok: false, reason: "replayed_capability" });
    expect(authority.activate(issued.capability, {
      ...CHILD,
      processEpoch: "66666666-6666-4666-8666-666666666666",
    }, childConnection)).toEqual({ ok: false, reason: "replayed_capability" });
  });

  test("renews only the exact active lease and makes duplicate renewal idempotent", () => {
    const { authority, parentConnection, childConnection, now, advance, issued } = issueFixture();
    expect(authority.activate(issued.capability, CHILD, childConnection)).toMatchObject({ ok: true });
    advance(10_000);
    const renewed = authority.renew(
      parentConnection,
      issued.lease.relayExposureLeaseId,
      CHILD,
      { ttlMs: 30_000, renewalId: RENEWAL_ID },
    );
    expect(renewed).toMatchObject({ ok: true, state: "renewed", lease: { expiresAt: now() + 30_000 } });
    expect(authority.drainRenewals()).toEqual([expect.objectContaining({
      childConnection,
      lease: expect.objectContaining({ expiresAt: now() + 30_000 }),
    })]);
    advance(1_000);
    expect(authority.renew(parentConnection, issued.lease.relayExposureLeaseId, CHILD, {
      ttlMs: 30_000,
      renewalId: RENEWAL_ID,
    })).toMatchObject({ ok: true, state: "idempotent", lease: { expiresAt: now() + 29_000 } });
    expect(authority.drainRenewals()).toEqual([]);
    expect(authority.renew(parentConnection, "88888888-8888-4888-8888-888888888888", CHILD, {
      ttlMs: 30_000,
      renewalId: RENEWAL_ID,
    })).toEqual({ ok: false, reason: "lease_not_found" });
    expect(authority.renew(parentConnection, issued.lease.relayExposureLeaseId, {
      ...CHILD,
      processEpoch: "99999999-9999-4999-8999-999999999999",
    }, { ttlMs: 30_000, renewalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }))
      .toEqual({ ok: false, reason: "binding_mismatch", field: "processEpoch" });
    expect(authority.renew({}, issued.lease.relayExposureLeaseId, CHILD, {
      ttlMs: 30_000,
      renewalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })).toEqual({ ok: false, reason: "unauthorized_parent" });
  });

  test("returns the original receipt for an out-of-order A/B/A renewal retry", () => {
    const { authority, parentConnection, childConnection, now, advance, issued } = issueFixture();
    expect(authority.activate(issued.capability, CHILD, childConnection)).toMatchObject({ ok: true });

    advance(10_000);
    const renewalA = authority.renew(parentConnection, issued.lease.relayExposureLeaseId, CHILD, {
      ttlMs: 30_000,
      renewalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(renewalA).toMatchObject({ ok: true, state: "renewed", lease: { expiresAt: now() + 30_000 } });
    const expiryA = renewalA.ok ? renewalA.lease.expiresAt : 0;
    authority.drainRenewals();

    advance(1_000);
    const renewalB = authority.renew(parentConnection, issued.lease.relayExposureLeaseId, CHILD, {
      ttlMs: 30_000,
      renewalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(renewalB).toMatchObject({ ok: true, state: "renewed", lease: { expiresAt: now() + 30_000 } });
    const expiryB = renewalB.ok ? renewalB.lease.expiresAt : 0;
    expect(expiryB).toBeGreaterThan(expiryA);
    authority.drainRenewals();

    advance(1_000);
    expect(authority.renew(parentConnection, issued.lease.relayExposureLeaseId, CHILD, {
      ttlMs: 30_000,
      renewalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    })).toMatchObject({ ok: true, state: "idempotent", lease: { expiresAt: expiryA } });
    expect(authority.drainRenewals()).toEqual([]);
  });

  test("fails closed instead of forgetting consumed renewal IDs at receipt capacity", () => {
    let now = 1_000_000;
    const authority = new RelayExposureLeaseAuthority({
      now: () => now,
      maxRenewalReceiptsPerLease: 1,
    });
    const parentConnection = {};
    const childConnection = {};
    authority.authorizeParent(parentConnection, PARENT, { delegationTtlMs: 120_000, maxLeaseTtlMs: 60_000 });
    const issued = authority.issue(parentConnection, CHILD, { ttlMs: 30_000 });
    if (!issued.ok) throw new Error(issued.reason);
    expect(authority.activate(issued.capability, CHILD, childConnection)).toMatchObject({ ok: true });
    now += 10_000;
    expect(authority.renew(parentConnection, issued.lease.relayExposureLeaseId, CHILD, {
      ttlMs: 30_000,
      renewalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    })).toMatchObject({ ok: true, state: "renewed" });
    now += 1_000;
    expect(authority.renew(parentConnection, issued.lease.relayExposureLeaseId, CHILD, {
      ttlMs: 30_000,
      renewalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })).toEqual({ ok: false, reason: "renewal_capacity_exceeded" });
    expect(authority.renew(parentConnection, issued.lease.relayExposureLeaseId, CHILD, {
      ttlMs: 30_000,
      renewalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    })).toMatchObject({ ok: true, state: "idempotent", lease: { expiresAt: 1_040_000 } });
  });

  test("parent revoke is fenced, idempotent, and cannot affect a replacement lease", () => {
    const first = issueFixture();
    expect(first.authority.activate(first.issued.capability, CHILD, first.childConnection)).toMatchObject({ ok: true });
    expect(first.authority.revoke(
      first.parentConnection,
      first.issued.lease.relayExposureLeaseId,
      CHILD,
    )).toMatchObject({ ok: true, state: "revoked" });
    expect(first.authority.drainTransitions()).toEqual([expect.objectContaining({
      reason: "parent_revoked",
      childConnection: first.childConnection,
      lease: expect.objectContaining({ relayExposureLeaseId: first.issued.lease.relayExposureLeaseId }),
    })]);
    expect(first.authority.revoke(
      first.parentConnection,
      first.issued.lease.relayExposureLeaseId,
      CHILD,
    )).toMatchObject({ ok: true, state: "idempotent" });
    expect(first.authority.drainTransitions()).toEqual([]);

    const replacement = first.authority.issue(first.parentConnection, CHILD, { ttlMs: 30_000 });
    if (!replacement.ok) throw new Error(replacement.reason);
    const replacementConnection = {};
    expect(first.authority.activate(replacement.capability, CHILD, replacementConnection)).toMatchObject({ ok: true, state: "activated" });
    expect(first.authority.revoke(
      first.parentConnection,
      first.issued.lease.relayExposureLeaseId,
      CHILD,
    )).toMatchObject({ ok: true, state: "idempotent" });
    expect(first.authority.activate(replacement.capability, CHILD, replacementConnection)).toMatchObject({ ok: true, state: "idempotent" });
  });

  test("expires active leases once and fences stale lifecycle operations", () => {
    const { authority, parentConnection, childConnection, advance, issued } = issueFixture();
    expect(authority.activate(issued.capability, CHILD, childConnection)).toMatchObject({ ok: true });
    advance(30_001);
    authority.expireDue();
    expect(authority.drainTransitions()).toEqual([expect.objectContaining({
      reason: "expired",
      childConnection,
      lease: expect.objectContaining({ relayExposureLeaseId: issued.lease.relayExposureLeaseId }),
    })]);
    authority.expireDue();
    expect(authority.drainTransitions()).toEqual([]);
    expect(authority.renew(parentConnection, issued.lease.relayExposureLeaseId, CHILD, {
      ttlMs: 1_000,
      renewalId: RENEWAL_ID,
    })).toEqual({ ok: false, reason: "lease_not_active" });
  });

  test("parent normal close is issuer-fenced and preserves a typed reason", () => {
    const value = issueFixture();
    expect(value.authority.activate(value.issued.capability, CHILD, value.childConnection)).toMatchObject({ ok: true });
    expect(value.authority.closeByParent(
      value.parentConnection,
      value.issued.lease.relayExposureLeaseId,
      CHILD,
      "timeout",
    )).toMatchObject({ ok: true, state: "closed" });
    expect(value.authority.drainTransitions()).toEqual([expect.objectContaining({
      reason: "child_closed",
      closeReason: "timeout",
      childConnection: value.childConnection,
    })]);
    expect(value.authority.closeByParent(
      value.parentConnection,
      value.issued.lease.relayExposureLeaseId,
      CHILD,
      "timeout",
    )).toMatchObject({ ok: true, state: "idempotent" });
    expect(value.authority.closeByParent(
      {},
      value.issued.lease.relayExposureLeaseId,
      CHILD,
      "timeout",
    )).toEqual({ ok: false, reason: "unauthorized_parent" });
  });

  test("normal close and child disconnect are exact-connection fenced and idempotent", () => {
    const normal = issueFixture();
    expect(normal.authority.activate(normal.issued.capability, CHILD, normal.childConnection)).toMatchObject({ ok: true });
    expect(normal.authority.close(
      normal.childConnection,
      normal.issued.lease.relayExposureLeaseId,
      CHILD,
      "completed",
    )).toMatchObject({ ok: true, state: "closed" });
    expect(normal.authority.close(
      normal.childConnection,
      normal.issued.lease.relayExposureLeaseId,
      CHILD,
      "completed",
    )).toMatchObject({ ok: true, state: "idempotent" });
    expect(normal.authority.close({}, normal.issued.lease.relayExposureLeaseId, CHILD, "completed"))
      .toEqual({ ok: false, reason: "stale_child_connection" });

    const abnormal = issueFixture();
    expect(abnormal.authority.activate(abnormal.issued.capability, CHILD, abnormal.childConnection)).toMatchObject({ ok: true });
    abnormal.authority.disconnectChild(abnormal.childConnection);
    expect(abnormal.authority.drainTransitions()).toEqual([expect.objectContaining({
      reason: "child_disconnected",
      childConnection: abnormal.childConnection,
    })]);
  });

  test("bounds live leases per parent and prunes terminal tombstones", () => {
    let now = 1_000_000;
    const authority = new RelayExposureLeaseAuthority({
      now: () => now,
      maxLiveLeasesPerParent: 1,
      maxRecords: 1,
      tombstoneTtlMs: 100,
    });
    const parentConnection = {};
    authority.authorizeParent(parentConnection, PARENT, { delegationTtlMs: 120_000, maxLeaseTtlMs: 60_000 });
    const first = authority.issue(parentConnection, CHILD, { ttlMs: 30_000 });
    if (!first.ok) throw new Error(first.reason);
    expect(authority.issue(parentConnection, {
      ...CHILD,
      runId: "run-other",
      agentId: "66666666-6666-4666-8666-666666666666",
    }, { ttlMs: 30_000 })).toEqual({ ok: false, reason: "parent_capacity_exceeded" });

    authority.revokeParent(parentConnection);
    authority.authorizeParent(parentConnection, PARENT, { delegationTtlMs: 120_000, maxLeaseTtlMs: 60_000 });
    expect(authority.issue(parentConnection, {
      ...CHILD,
      runId: "run-other",
      agentId: "66666666-6666-4666-8666-666666666666",
    }, { ttlMs: 30_000 })).toEqual({ ok: false, reason: "authority_capacity_exceeded" });

    now += 101;
    expect(authority.issue(parentConnection, {
      ...CHILD,
      runId: "run-other",
      agentId: "66666666-6666-4666-8666-666666666666",
    }, { ttlMs: 30_000 })).toMatchObject({ ok: true });
    const records = (authority as unknown as { recordsByDigest: Map<string, unknown> }).recordsByDigest;
    expect(records.size).toBe(1);
  });

  test("keeps only a capability digest in authority state and rejects it after broker restart", () => {
    const { authority, childConnection, issued } = issueFixture();
    const records = (authority as unknown as { recordsByDigest: Map<string, unknown> }).recordsByDigest;
    expect(records.size).toBe(1);
    expect([...records.keys()]).not.toContain(issued.capability);
    expect(JSON.stringify([...records.entries()])).not.toContain(issued.capability);

    const restarted = new RelayExposureLeaseAuthority();
    expect(restarted.activate(issued.capability, CHILD, childConnection)).toEqual({ ok: false, reason: "forged_capability" });
  });

  test("parent delegation expiry and disconnect revocation fail closed", () => {
    const { authority, parentConnection, advance } = fixture();
    advance(120_001);
    expect(authority.issue(parentConnection, CHILD, { ttlMs: 1_000 })).toEqual({
      ok: false,
      reason: "delegation_expired",
    });

    const second = issueFixture();
    expect(second.authority.activate(second.issued.capability, CHILD, second.childConnection))
      .toMatchObject({ ok: true, state: "activated" });
    second.authority.revokeParent(second.parentConnection);
    expect(second.authority.drainTransitions()).toEqual([expect.objectContaining({
      reason: "parent_disconnected",
      childConnection: second.childConnection,
    })]);
    expect(second.authority.activate(second.issued.capability, CHILD, second.childConnection)).toEqual({
      ok: false,
      reason: "revoked_capability",
    });
  });

  test("issues bounded digest-only runner subdelegation and fences its child lifecycle", () => {
    const { authority, parentConnection, childConnection } = fixture();
    const delegated = authority.delegateRunner(parentConnection, {
      rootRunId: CHILD.runId,
      workspaceId: CHILD.workspaceId,
      delegationTtlMs: 60_000,
      maxLeaseTtlMs: 30_000,
      maxChildIssues: 2,
    });
    expect(delegated.ok).toBe(true);
    if (!delegated.ok) throw new Error(delegated.reason);
    expect(delegated.token).toMatch(/^rprd1\./);
    expect(JSON.stringify(authority)).not.toContain(delegated.token);

    const issued = authority.issueForRunner(delegated.token, CHILD, { ttlMs: 20_000 });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error(issued.reason);
    expect(authority.activate(issued.capability, CHILD, childConnection)).toMatchObject({ ok: true, state: "activated" });
    expect(authority.renewForRunner(delegated.token, issued.lease.relayExposureLeaseId, CHILD, {
      ttlMs: 25_000,
      renewalId: RENEWAL_ID,
    })).toMatchObject({ ok: true, state: "renewed" });
    expect(authority.closeForRunner(
      delegated.token,
      issued.lease.relayExposureLeaseId,
      CHILD,
      "completed",
    )).toMatchObject({ ok: true, state: "closed" });
    expect(authority.releaseRunner(delegated.token)).toEqual({ ok: true, state: "released" });
    expect(authority.issueForRunner(delegated.token, {
      ...CHILD,
      agentId: "66666666-6666-4666-8666-666666666666",
    }, { ttlMs: 20_000 })).toEqual({ ok: false, reason: "invalid_runner_delegation" });
  });

  test("abandoned runner authority expires its active child lease without forging normal close", () => {
    const { authority, parentConnection, childConnection, advance } = fixture();
    const delegated = authority.delegateRunner(parentConnection, {
      rootRunId: CHILD.runId,
      workspaceId: CHILD.workspaceId,
      delegationTtlMs: 5_000,
      maxLeaseTtlMs: 1_000,
      maxChildIssues: 1,
    });
    expect(delegated.ok).toBe(true);
    if (!delegated.ok) throw new Error(delegated.reason);
    const issued = authority.issueForRunner(delegated.token, CHILD, { ttlMs: 1_000 });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error(issued.reason);
    expect(authority.activate(issued.capability, CHILD, childConnection)).toMatchObject({ ok: true, state: "activated" });

    advance(1_001);
    authority.expireDue();
    expect(authority.drainTransitions()).toEqual([expect.objectContaining({
      reason: "expired",
      childConnection,
      lease: expect.objectContaining({ relayExposureLeaseId: issued.lease.relayExposureLeaseId }),
    })]);
    expect(authority.closeForRunner(
      delegated.token,
      issued.lease.relayExposureLeaseId,
      CHILD,
      "completed",
    )).toMatchObject({ ok: true, state: "idempotent" });
    expect(authority.drainTransitions()).toEqual([]);

    advance(4_000);
    expect(authority.closeForRunner(
      delegated.token,
      issued.lease.relayExposureLeaseId,
      CHILD,
      "completed",
    )).toEqual({ ok: false, reason: "runner_delegation_expired" });
    const runnerDelegations = (authority as unknown as { runnerDelegationsByDigest: Map<string, unknown> }).runnerDelegationsByDigest;
    expect(runnerDelegations.size).toBe(0);
    expect(JSON.stringify(authority)).not.toContain(delegated.token);
  });

  test("runner subdelegation fails closed for wrong scope, expiry, count, and parent revocation", () => {
    const { authority, parentConnection, advance } = fixture();
    const delegated = authority.delegateRunner(parentConnection, {
      rootRunId: CHILD.runId,
      workspaceId: CHILD.workspaceId,
      delegationTtlMs: 40_000,
      maxLeaseTtlMs: 20_000,
      maxChildIssues: 1,
    });
    expect(delegated.ok).toBe(true);
    if (!delegated.ok) throw new Error(delegated.reason);

    expect(authority.issueForRunner("rprd1.77777777-7777-4777-8777-777777777777.forged", CHILD, { ttlMs: 10_000 }))
      .toEqual({ ok: false, reason: "invalid_runner_delegation" });
    expect(authority.issueForRunner(delegated.token, { ...CHILD, runId: "other-run" }, { ttlMs: 10_000 }))
      .toEqual({ ok: false, reason: "runner_binding_mismatch", field: "runId" });
    expect(authority.issueForRunner(delegated.token, {
      ...CHILD,
      workspaceId: "77777777-7777-4777-8777-777777777777",
    }, { ttlMs: 10_000 })).toEqual({ ok: false, reason: "runner_binding_mismatch", field: "workspaceId" });
    expect(authority.issueForRunner(delegated.token, CHILD, { ttlMs: 20_001 }))
      .toEqual({ ok: false, reason: "ttl_exceeds_runner_maximum" });
    expect(authority.issueForRunner(delegated.token, CHILD, { ttlMs: 10_000 })).toMatchObject({ ok: true });
    expect(authority.issueForRunner(delegated.token, {
      ...CHILD,
      agentId: "77777777-7777-4777-8777-777777777777",
      processEpoch: "88888888-8888-4888-8888-888888888888",
    }, { ttlMs: 10_000 })).toEqual({ ok: false, reason: "runner_issue_capacity_exceeded" });

    const expiring = authority.delegateRunner(parentConnection, {
      rootRunId: "expiring-run",
      workspaceId: CHILD.workspaceId,
      delegationTtlMs: 1_000,
      maxLeaseTtlMs: 1_000,
      maxChildIssues: 1,
    });
    expect(expiring.ok).toBe(true);
    if (!expiring.ok) throw new Error(expiring.reason);
    advance(1_001);
    expect(authority.issueForRunner(expiring.token, { ...CHILD, runId: "expiring-run" }, { ttlMs: 500 }))
      .toEqual({ ok: false, reason: "runner_delegation_expired" });

    authority.revokeParent(parentConnection);
    expect(authority.issueForRunner(delegated.token, CHILD, { ttlMs: 10_000 }))
      .toEqual({ ok: false, reason: "invalid_runner_delegation" });
  });
});
