import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isRuntimeIdentity, type RuntimeIdentity } from "./runtime_identity.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY_PATTERN = /^rpel1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const RUNNER_DELEGATION_PATTERN = /^rprd1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const BINDING_KEYS = new Set(["runId", "workspaceId", "agentId", "processEpoch", "mode"]);
const IDENTITY_KEYS = new Set(["workspaceId", "agentId", "processEpoch"]);
const LEASE_KEYS = new Set(["relayExposureLeaseId", "parent", "binding", "issuedAt", "expiresAt"]);
const MAX_RUN_ID_BYTES = 512;
const DEFAULT_MAX_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_DELEGATION_TTL_MS = 10 * 60_000;
const DEFAULT_TOMBSTONE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_LIVE_LEASES_PER_PARENT = 256;
const DEFAULT_MAX_RENEWAL_RECEIPTS_PER_LEASE = 256;
const DEFAULT_MAX_RECORDS = 4_096;
const DEFAULT_MAX_RUNNER_DELEGATIONS = 256;
const DEFAULT_MAX_RUNNER_CHILD_ISSUES = 128;

/** Non-secret correlation/fencing metadata; never authority by itself. */
export interface RelayExposureBinding {
  runId: string;
  workspaceId: string;
  agentId: string;
  processEpoch: string;
  mode: "relay";
}

/** Safe lease metadata. It deliberately excludes the bearer capability/nonce. */
export interface RelayExposureLease {
  relayExposureLeaseId: string;
  parent: RuntimeIdentity;
  binding: RelayExposureBinding;
  issuedAt: number;
  expiresAt: number;
}

export interface ParentDelegationOptions {
  delegationTtlMs?: number;
  maxLeaseTtlMs?: number;
}

export type RelayExposureIntentSource = "run" | "agent" | "fallback";

export interface RunnerDelegationOptions {
  rootRunId: string;
  workspaceId: string;
  delegationTtlMs: number;
  maxLeaseTtlMs: number;
  maxChildIssues: number;
  intentSources: readonly RelayExposureIntentSource[];
}

export type RunnerDelegationResult =
  | {
      ok: true;
      token: string;
      expiresAt: number;
      maxLeaseTtlMs: number;
      maxChildIssues: number;
    }
  | {
      ok: false;
      reason:
        | "unauthorized_parent"
        | "delegation_expired"
        | "invalid_runner_scope"
        | "invalid_ttl"
        | "ttl_exceeds_delegation"
        | "ttl_exceeds_maximum"
        | "invalid_child_issue_limit"
        | "runner_delegation_capacity_exceeded";
    };

export type RunnerDelegationFailure =
  | { ok: false; reason: "invalid_runner_delegation" | "runner_delegation_expired" | "runner_issue_capacity_exceeded" | "runner_intent_source_denied" | "ttl_exceeds_runner_maximum" | "runner_lease_not_owned" }
  | { ok: false; reason: "runner_binding_mismatch"; field: "runId" | "workspaceId" };

export type RelayExposureIssueResult =
  | { ok: true; capability: string; lease: RelayExposureLease }
  | { ok: false; reason: "lease_already_exists"; lease: RelayExposureLease }
  | {
      ok: false;
      reason:
        | "unauthorized_parent"
        | "delegation_expired"
        | "invalid_binding"
        | "invalid_ttl"
        | "ttl_exceeds_maximum"
        | "ttl_exceeds_delegation"
        | "parent_capacity_exceeded"
        | "authority_capacity_exceeded";
    };

export type RelayExposurePromoteResult =
  | { ok: true; state: "promoted" | "idempotent"; lease: RelayExposureLease }
  | { ok: false; reason: Exclude<Extract<RelayExposureIssueResult, { ok: false }>["reason"], "lease_already_exists"> }
  | { ok: false; reason: "lease_already_exists"; lease: RelayExposureLease }
  | { ok: false; reason: "activation_failed" };

export type RelayExposureActivationResult =
  | { ok: true; state: "activated" | "idempotent"; lease: RelayExposureLease }
  | {
      ok: false;
      reason:
        | "missing_capability"
        | "forged_capability"
        | "expired_capability"
        | "revoked_capability"
        | "replayed_capability";
    }
  | { ok: false; reason: "binding_mismatch"; field: keyof RelayExposureBinding };

export type RelayExposureRenewResult =
  | { ok: true; state: "renewed" | "idempotent"; lease: RelayExposureLease }
  | {
      ok: false;
      reason:
        | "unauthorized_parent"
        | "delegation_expired"
        | "lease_not_found"
        | "lease_not_active"
        | "invalid_binding"
        | "invalid_ttl"
        | "invalid_renewal_id"
        | "renewal_capacity_exceeded"
        | "ttl_exceeds_maximum"
        | "ttl_exceeds_delegation";
    }
  | { ok: false; reason: "binding_mismatch"; field: keyof RelayExposureBinding };

export type RelayExposureRevokeResult =
  | { ok: true; state: "revoked" | "idempotent"; lease: RelayExposureLease }
  | { ok: false; reason: "unauthorized_parent" | "lease_not_found" | "invalid_binding" }
  | { ok: false; reason: "binding_mismatch"; field: keyof RelayExposureBinding };

export type RelayExposureNormalCloseReason = "completed" | "interrupted" | "timeout" | "controlled_shutdown";

export type RelayExposureCloseResult =
  | { ok: true; state: "closed" | "idempotent"; lease: RelayExposureLease }
  | { ok: false; reason: "unauthorized_parent" | "lease_not_found" | "lease_not_active" | "invalid_binding" | "invalid_close_reason" | "stale_child_connection" }
  | { ok: false; reason: "binding_mismatch"; field: keyof RelayExposureBinding };

export type RelayExposureTransitionReason =
  | "parent_revoked"
  | "parent_disconnected"
  | "expired"
  | "child_closed"
  | "child_disconnected";

/** Internal broker handoff. childConnection is never serialized. */
export interface RelayExposureTransition {
  lease: RelayExposureLease;
  reason: RelayExposureTransitionReason;
  childConnection?: object;
  closeReason?: RelayExposureNormalCloseReason;
}

export interface RelayExposureRenewal {
  lease: RelayExposureLease;
  childConnection: object;
}

interface ParentDelegation {
  parent: RuntimeIdentity;
  expiresAt: number;
  maxLeaseTtlMs: number;
}

interface RunnerDelegation {
  parentConnection: object;
  rootRunId: string;
  workspaceId: string;
  expiresAt: number;
  maxLeaseTtlMs: number;
  maxChildIssues: number;
  childIssues: number;
  allowedIntentSources: Set<RelayExposureIntentSource>;
  leaseIds: Set<string>;
}

interface LeaseRecord {
  parentConnection: object;
  childConnection?: object;
  capabilityDigest: string;
  bindingKey: string;
  lease: RelayExposureLease;
  status: "issued" | "active" | "revoked" | "expired" | "closed";
  terminalAt?: number;
  terminalReason?: RelayExposureTransitionReason;
  /** Stable receipts make delayed/out-of-order retries idempotent. */
  renewalReceipts: Map<string, RelayExposureLease>;
}

export interface RelayExposureLeaseAuthorityOptions {
  now?: () => number;
  randomUuid?: () => string;
  randomToken?: () => string;
  tombstoneTtlMs?: number;
  maxLiveLeasesPerParent?: number;
  maxRenewalReceiptsPerLease?: number;
  maxRecords?: number;
  maxRunnerDelegations?: number;
  maxRunnerChildIssues?: number;
}

function cloneIdentity(identity: RuntimeIdentity): RuntimeIdentity {
  return { ...identity };
}

function cloneBinding(binding: RelayExposureBinding): RelayExposureBinding {
  return { ...binding };
}

function cloneLease(lease: RelayExposureLease): RelayExposureLease {
  return { ...lease, parent: cloneIdentity(lease.parent), binding: cloneBinding(lease.binding) };
}

function capabilityDigest(capability: string): string {
  return createHash("sha256")
    .update("remote-pi/relayExposureLease/v1\0")
    .update(capability)
    .digest("hex");
}

function runnerDelegationDigest(token: string): string {
  return createHash("sha256")
    .update("remote-pi/relayRunnerDelegation/v1\0")
    .update(token)
    .digest("hex");
}

function hasExactKeys(value: object, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

export function isRelayExposureCapability(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = CAPABILITY_PATTERN.exec(value);
  return match !== null && UUID_PATTERN.test(match[1]!);
}

export function relayExposureCapabilityLeaseId(capability: string): string | undefined {
  const match = CAPABILITY_PATTERN.exec(capability);
  return match && UUID_PATTERN.test(match[1]!) ? match[1]!.toLowerCase() : undefined;
}

export function isRelayExposureRuntimeIdentity(value: unknown): value is RuntimeIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, IDENTITY_KEYS)) return false;
  return isRuntimeIdentity(value);
}

export function isRelayExposureBinding(value: unknown): value is RelayExposureBinding {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, BINDING_KEYS)) return false;
  const binding = value as Partial<RelayExposureBinding>;
  return typeof binding.runId === "string"
    && binding.runId.trim().length > 0
    && Buffer.byteLength(binding.runId, "utf8") <= MAX_RUN_ID_BYTES
    && typeof binding.workspaceId === "string"
    && typeof binding.agentId === "string"
    && typeof binding.processEpoch === "string"
    && UUID_PATTERN.test(binding.workspaceId)
    && UUID_PATTERN.test(binding.agentId)
    && UUID_PATTERN.test(binding.processEpoch)
    && binding.mode === "relay";
}

export function isRelayExposureLease(value: unknown): value is RelayExposureLease {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, LEASE_KEYS)) return false;
  const lease = value as Partial<RelayExposureLease>;
  return typeof lease.relayExposureLeaseId === "string"
    && UUID_PATTERN.test(lease.relayExposureLeaseId)
    && isRelayExposureRuntimeIdentity(lease.parent)
    && isRelayExposureBinding(lease.binding)
    && typeof lease.issuedAt === "number"
    && Number.isSafeInteger(lease.issuedAt)
    && typeof lease.expiresAt === "number"
    && Number.isSafeInteger(lease.expiresAt)
    && lease.expiresAt > lease.issuedAt;
}

function normalizedBinding(binding: RelayExposureBinding): RelayExposureBinding {
  return {
    runId: binding.runId,
    workspaceId: binding.workspaceId.toLowerCase(),
    agentId: binding.agentId.toLowerCase(),
    processEpoch: binding.processEpoch.toLowerCase(),
    mode: "relay",
  };
}

function firstBindingMismatch(
  expected: RelayExposureBinding,
  actual: RelayExposureBinding,
): keyof RelayExposureBinding | undefined {
  const fields: Array<keyof RelayExposureBinding> = ["runId", "workspaceId", "agentId", "processEpoch", "mode"];
  return fields.find((field) => expected[field] !== actual[field]);
}

function bindingKey(binding: RelayExposureBinding): string {
  return JSON.stringify([binding.runId, binding.workspaceId, binding.agentId, binding.processEpoch, binding.mode]);
}

function validCloseReason(value: unknown): value is RelayExposureNormalCloseReason {
  return value === "completed" || value === "interrupted" || value === "timeout" || value === "controlled_shutdown";
}

/** Broker-memory authority. Restart discards all delegation and lease state. */
export class RelayExposureLeaseAuthority {
  private readonly now: () => number;
  private readonly randomUuid: () => string;
  private readonly randomToken: () => string;
  private readonly tombstoneTtlMs: number;
  private readonly maxLiveLeasesPerParent: number;
  private readonly maxRenewalReceiptsPerLease: number;
  private readonly maxRecords: number;
  private readonly maxRunnerDelegations: number;
  private readonly maxRunnerChildIssues: number;
  private readonly delegations = new Map<object, ParentDelegation>();
  private readonly runnerDelegationsByDigest = new Map<string, RunnerDelegation>();
  private readonly recordsByDigest = new Map<string, LeaseRecord>();
  private readonly recordsByLeaseId = new Map<string, LeaseRecord>();
  private readonly recordsByBinding = new Map<string, LeaseRecord>();
  /** One terminal notice and latest renewal notice per retained lease record. */
  private readonly pendingTransitions = new Map<string, RelayExposureTransition>();
  private readonly pendingRenewals = new Map<string, RelayExposureRenewal>();

  constructor(options: RelayExposureLeaseAuthorityOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomUuid = options.randomUuid ?? randomUUID;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.tombstoneTtlMs = options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
    this.maxLiveLeasesPerParent = options.maxLiveLeasesPerParent ?? DEFAULT_MAX_LIVE_LEASES_PER_PARENT;
    this.maxRenewalReceiptsPerLease = options.maxRenewalReceiptsPerLease ?? DEFAULT_MAX_RENEWAL_RECEIPTS_PER_LEASE;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxRunnerDelegations = options.maxRunnerDelegations ?? DEFAULT_MAX_RUNNER_DELEGATIONS;
    this.maxRunnerChildIssues = options.maxRunnerChildIssues ?? DEFAULT_MAX_RUNNER_CHILD_ISSUES;
    for (const [label, value] of [
      ["Relay exposure tombstone TTL", this.tombstoneTtlMs],
      ["Relay exposure per-parent capacity", this.maxLiveLeasesPerParent],
      ["Relay exposure per-lease renewal receipt capacity", this.maxRenewalReceiptsPerLease],
      ["Relay exposure authority capacity", this.maxRecords],
      ["Relay runner delegation capacity", this.maxRunnerDelegations],
      ["Relay runner child issue capacity", this.maxRunnerChildIssues],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
    }
  }

  private terminate(
    record: LeaseRecord,
    status: "revoked" | "expired" | "closed",
    reason: RelayExposureTransitionReason,
    now: number,
    closeReason?: RelayExposureNormalCloseReason,
  ): boolean {
    if (record.status !== "issued" && record.status !== "active") return false;
    const wasActive = record.status === "active";
    record.status = status;
    record.terminalAt = now;
    record.terminalReason = reason;
    const leaseId = record.lease.relayExposureLeaseId;
    this.pendingRenewals.delete(leaseId);
    if (this.recordsByBinding.get(record.bindingKey) === record) this.recordsByBinding.delete(record.bindingKey);
    if (wasActive && record.childConnection) {
      this.pendingTransitions.set(leaseId, {
        lease: cloneLease(record.lease),
        reason,
        childConnection: record.childConnection,
        ...(closeReason ? { closeReason } : {}),
      });
    }
    return true;
  }

  private prune(now: number): void {
    for (const [digest, record] of this.recordsByDigest) {
      if ((record.status === "issued" || record.status === "active") && record.lease.expiresAt <= now) {
        this.terminate(record, "expired", "expired", now);
      }
      if ((record.status === "revoked" || record.status === "expired" || record.status === "closed")
        && record.terminalAt !== undefined
        && record.terminalAt + this.tombstoneTtlMs <= now
        && !this.pendingTransitions.has(record.lease.relayExposureLeaseId)) {
        this.recordsByDigest.delete(digest);
        if (this.recordsByLeaseId.get(record.lease.relayExposureLeaseId) === record) {
          this.recordsByLeaseId.delete(record.lease.relayExposureLeaseId);
        }
      }
    }
  }

  private recordFor(leaseId: string): LeaseRecord | undefined {
    return UUID_PATTERN.test(leaseId) ? this.recordsByLeaseId.get(leaseId.toLowerCase()) : undefined;
  }

  private normalizedLifecycleBinding(binding: RelayExposureBinding): RelayExposureBinding | undefined {
    return isRelayExposureBinding(binding) ? normalizedBinding(binding) : undefined;
  }

  private runnerDelegation(token: string): RunnerDelegation | RunnerDelegationFailure {
    if (!RUNNER_DELEGATION_PATTERN.test(token)) return { ok: false, reason: "invalid_runner_delegation" };
    const digest = runnerDelegationDigest(token);
    const delegation = this.runnerDelegationsByDigest.get(digest);
    if (!delegation) return { ok: false, reason: "invalid_runner_delegation" };
    if (delegation.expiresAt <= this.now()) {
      this.runnerDelegationsByDigest.delete(digest);
      return { ok: false, reason: "runner_delegation_expired" };
    }
    return delegation;
  }

  private runnerDelegationForBinding(
    token: string,
    binding: RelayExposureBinding,
  ): RunnerDelegation | RunnerDelegationFailure {
    const delegation = this.runnerDelegation(token);
    if ("ok" in delegation) return delegation;
    if (!isRelayExposureBinding(binding)) return { ok: false, reason: "invalid_runner_delegation" };
    if (binding.runId !== delegation.rootRunId) return { ok: false, reason: "runner_binding_mismatch", field: "runId" };
    if (binding.workspaceId.toLowerCase() !== delegation.workspaceId) {
      return { ok: false, reason: "runner_binding_mismatch", field: "workspaceId" };
    }
    return delegation;
  }

  /** Called only after an operator action authorizes this exact live parent connection. */
  authorizeParent(parentConnection: object, parent: RuntimeIdentity, options: ParentDelegationOptions = {}): void {
    if (!parentConnection || typeof parentConnection !== "object") throw new Error("Parent delegation requires a live connection object.");
    if (!isRuntimeIdentity(parent)) throw new Error("Parent delegation requires a valid runtime identity.");
    const delegationTtlMs = options.delegationTtlMs ?? DEFAULT_DELEGATION_TTL_MS;
    const maxLeaseTtlMs = options.maxLeaseTtlMs ?? DEFAULT_MAX_LEASE_TTL_MS;
    if (!Number.isSafeInteger(delegationTtlMs) || delegationTtlMs <= 0) throw new Error("Parent delegation TTL must be a positive integer.");
    if (!Number.isSafeInteger(maxLeaseTtlMs) || maxLeaseTtlMs <= 0) throw new Error("Maximum relay exposure lease TTL must be a positive integer.");
    this.delegations.set(parentConnection, {
      parent: cloneIdentity(parent),
      expiresAt: this.now() + delegationTtlMs,
      maxLeaseTtlMs,
    });
  }

  delegateRunner(parentConnection: object, options: RunnerDelegationOptions): RunnerDelegationResult {
    const now = this.now();
    for (const [digest, runner] of this.runnerDelegationsByDigest) {
      if (runner.expiresAt <= now) this.runnerDelegationsByDigest.delete(digest);
    }
    const parent = this.delegations.get(parentConnection);
    if (!parent) return { ok: false, reason: "unauthorized_parent" };
    if (parent.expiresAt <= now) {
      this.delegations.delete(parentConnection);
      return { ok: false, reason: "delegation_expired" };
    }
    if (typeof options.rootRunId !== "string"
      || !options.rootRunId.trim()
      || Buffer.byteLength(options.rootRunId, "utf8") > MAX_RUN_ID_BYTES
      || !UUID_PATTERN.test(options.workspaceId)
      || options.workspaceId.toLowerCase() !== parent.parent.workspaceId.toLowerCase()) {
      return { ok: false, reason: "invalid_runner_scope" };
    }
    if (!Number.isSafeInteger(options.delegationTtlMs) || options.delegationTtlMs <= 0
      || !Number.isSafeInteger(options.maxLeaseTtlMs) || options.maxLeaseTtlMs <= 0) {
      return { ok: false, reason: "invalid_ttl" };
    }
    const expiresAt = now + options.delegationTtlMs;
    if (expiresAt > parent.expiresAt) return { ok: false, reason: "ttl_exceeds_delegation" };
    if (options.maxLeaseTtlMs > parent.maxLeaseTtlMs) return { ok: false, reason: "ttl_exceeds_maximum" };
    if (options.maxLeaseTtlMs > options.delegationTtlMs) return { ok: false, reason: "ttl_exceeds_delegation" };
    if (!Number.isSafeInteger(options.maxChildIssues)
      || options.maxChildIssues <= 0
      || options.maxChildIssues > this.maxRunnerChildIssues) {
      return { ok: false, reason: "invalid_child_issue_limit" };
    }
    if (!Array.isArray(options.intentSources)
      || options.intentSources.length === 0
      || options.intentSources.some((source) => source !== "run" && source !== "agent" && source !== "fallback")) {
      return { ok: false, reason: "invalid_runner_scope" };
    }
    const allowedIntentSources = new Set(options.intentSources);
    if (this.runnerDelegationsByDigest.size >= this.maxRunnerDelegations) {
      return { ok: false, reason: "runner_delegation_capacity_exceeded" };
    }
    let token = "";
    let digest = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      token = `rprd1.${this.randomUuid().toLowerCase()}.${this.randomToken()}`;
      digest = runnerDelegationDigest(token);
      if (!this.runnerDelegationsByDigest.has(digest)) break;
      token = "";
    }
    if (!token) throw new Error("Relay runner delegation collision.");
    this.runnerDelegationsByDigest.set(digest, {
      parentConnection,
      rootRunId: options.rootRunId,
      workspaceId: options.workspaceId.toLowerCase(),
      expiresAt,
      maxLeaseTtlMs: options.maxLeaseTtlMs,
      maxChildIssues: options.maxChildIssues,
      childIssues: 0,
      allowedIntentSources,
      leaseIds: new Set(),
    });
    return {
      ok: true,
      token,
      expiresAt,
      maxLeaseTtlMs: options.maxLeaseTtlMs,
      maxChildIssues: options.maxChildIssues,
    };
  }

  issueForRunner(
    token: string,
    binding: RelayExposureBinding,
    options: { ttlMs: number; intentSource: RelayExposureIntentSource },
  ): RelayExposureIssueResult | RunnerDelegationFailure {
    const runner = this.runnerDelegationForBinding(token, binding);
    if ("ok" in runner) return runner;
    if (!runner.allowedIntentSources.has(options.intentSource)) return { ok: false, reason: "runner_intent_source_denied" };
    if (runner.childIssues >= runner.maxChildIssues) return { ok: false, reason: "runner_issue_capacity_exceeded" };
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) return { ok: false, reason: "invalid_ttl" };
    if (options.ttlMs > runner.maxLeaseTtlMs) return { ok: false, reason: "ttl_exceeds_runner_maximum" };
    if (this.now() + options.ttlMs > runner.expiresAt) return { ok: false, reason: "ttl_exceeds_delegation" };
    const result = this.issue(runner.parentConnection, binding, options);
    if (result.ok) {
      runner.childIssues++;
      runner.leaseIds.add(result.lease.relayExposureLeaseId);
    }
    return result;
  }

  renewForRunner(
    token: string,
    relayExposureLeaseId: string,
    binding: RelayExposureBinding,
    options: { ttlMs: number; renewalId: string },
  ): RelayExposureRenewResult | RunnerDelegationFailure {
    const runner = this.runnerDelegationForBinding(token, binding);
    if ("ok" in runner) return runner;
    if (!runner.leaseIds.has(relayExposureLeaseId.toLowerCase())) return { ok: false, reason: "runner_lease_not_owned" };
    if (options.ttlMs > runner.maxLeaseTtlMs) return { ok: false, reason: "ttl_exceeds_runner_maximum" };
    if (this.now() + options.ttlMs > runner.expiresAt) return { ok: false, reason: "ttl_exceeds_delegation" };
    return this.renew(runner.parentConnection, relayExposureLeaseId, binding, options);
  }

  revokeForRunner(
    token: string,
    relayExposureLeaseId: string,
    binding: RelayExposureBinding,
  ): RelayExposureRevokeResult | RunnerDelegationFailure {
    const runner = this.runnerDelegationForBinding(token, binding);
    if ("ok" in runner) return runner;
    if (!runner.leaseIds.has(relayExposureLeaseId.toLowerCase())) return { ok: false, reason: "runner_lease_not_owned" };
    return this.revoke(runner.parentConnection, relayExposureLeaseId, binding);
  }

  closeForRunner(
    token: string,
    relayExposureLeaseId: string,
    binding: RelayExposureBinding,
    closeReason: RelayExposureNormalCloseReason,
  ): RelayExposureCloseResult | RunnerDelegationFailure {
    const runner = this.runnerDelegationForBinding(token, binding);
    if ("ok" in runner) return runner;
    if (!runner.leaseIds.has(relayExposureLeaseId.toLowerCase())) return { ok: false, reason: "runner_lease_not_owned" };
    return this.closeByParent(runner.parentConnection, relayExposureLeaseId, binding, closeReason);
  }

  releaseRunner(token: string): { ok: true; state: "released" } | RunnerDelegationFailure {
    const runner = this.runnerDelegation(token);
    if ("ok" in runner) return runner;
    const now = this.now();
    for (const leaseId of runner.leaseIds) {
      const record = this.recordFor(leaseId);
      if (record?.parentConnection === runner.parentConnection) {
        this.terminate(record, "closed", "child_closed", now, "controlled_shutdown");
      }
    }
    this.runnerDelegationsByDigest.delete(runnerDelegationDigest(token));
    return { ok: true, state: "released" };
  }

  revokeParent(
    parentConnection: object,
    reason: Extract<RelayExposureTransitionReason, "parent_revoked" | "parent_disconnected"> = "parent_disconnected",
  ): void {
    this.delegations.delete(parentConnection);
    for (const [digest, runner] of this.runnerDelegationsByDigest) {
      if (runner.parentConnection === parentConnection) this.runnerDelegationsByDigest.delete(digest);
    }
    const now = this.now();
    this.prune(now);
    for (const record of this.recordsByDigest.values()) {
      if (record.parentConnection === parentConnection) {
        this.terminate(record, "revoked", reason, now);
      }
    }
  }

  /** Withdraw every live parent delegation in one exact workspace policy scope. */
  revokeWorkspace(
    workspaceId: string,
    reason: Extract<RelayExposureTransitionReason, "parent_revoked"> = "parent_revoked",
  ): number {
    if (!UUID_PATTERN.test(workspaceId)) return 0;
    const normalizedWorkspaceId = workspaceId.toLowerCase();
    const parents = [...this.delegations.entries()]
      .filter(([, delegation]) => delegation.parent.workspaceId.toLowerCase() === normalizedWorkspaceId)
      .map(([connection]) => connection);
    for (const parentConnection of parents) this.revokeParent(parentConnection, reason);
    return parents.length;
  }

  issue(parentConnection: object, binding: RelayExposureBinding, options: { ttlMs: number }): RelayExposureIssueResult {
    const delegation = parentConnection && typeof parentConnection === "object" ? this.delegations.get(parentConnection) : undefined;
    if (!delegation) return { ok: false, reason: "unauthorized_parent" };
    const now = this.now();
    this.prune(now);
    if (delegation.expiresAt <= now) {
      this.delegations.delete(parentConnection);
      return { ok: false, reason: "delegation_expired" };
    }
    if (!isRelayExposureBinding(binding)) return { ok: false, reason: "invalid_binding" };
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) return { ok: false, reason: "invalid_ttl" };
    if (options.ttlMs > delegation.maxLeaseTtlMs) return { ok: false, reason: "ttl_exceeds_maximum" };
    if (now + options.ttlMs > delegation.expiresAt) return { ok: false, reason: "ttl_exceeds_delegation" };

    const normalized = normalizedBinding(binding);
    const key = bindingKey(normalized);
    const existing = this.recordsByBinding.get(key);
    if (existing) return { ok: false, reason: "lease_already_exists", lease: cloneLease(existing.lease) };
    let parentLiveCount = 0;
    for (const record of this.recordsByDigest.values()) {
      if (record.parentConnection === parentConnection && (record.status === "issued" || record.status === "active")) parentLiveCount++;
    }
    if (parentLiveCount >= this.maxLiveLeasesPerParent) return { ok: false, reason: "parent_capacity_exceeded" };
    if (this.recordsByDigest.size >= this.maxRecords) return { ok: false, reason: "authority_capacity_exceeded" };

    const relayExposureLeaseId = this.randomUuid().toLowerCase();
    const nonce = this.randomToken();
    if (!UUID_PATTERN.test(relayExposureLeaseId) || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
      throw new Error("Relay exposure lease entropy source returned invalid material.");
    }
    const capability = `rpel1.${relayExposureLeaseId}.${nonce}`;
    const digest = capabilityDigest(capability);
    if (this.recordsByDigest.has(digest) || this.recordsByLeaseId.has(relayExposureLeaseId)) {
      throw new Error("Relay exposure capability collision.");
    }
    const lease: RelayExposureLease = {
      relayExposureLeaseId,
      parent: cloneIdentity(delegation.parent),
      binding: normalized,
      issuedAt: now,
      expiresAt: now + options.ttlMs,
    };
    const record: LeaseRecord = {
      parentConnection,
      capabilityDigest: digest,
      bindingKey: key,
      lease,
      status: "issued",
      renewalReceipts: new Map(),
    };
    this.recordsByDigest.set(digest, record);
    this.recordsByLeaseId.set(relayExposureLeaseId, record);
    this.recordsByBinding.set(key, record);
    return { ok: true, capability, lease: cloneLease(lease) };
  }

  /** Mint and consume a one-process capability entirely inside broker memory for live promotion. */
  promote(
    parentConnection: object,
    binding: RelayExposureBinding,
    childConnection: object,
    options: { ttlMs: number },
  ): RelayExposurePromoteResult {
    const issued = this.issue(parentConnection, binding, options);
    if (!issued.ok) {
      if (issued.reason !== "lease_already_exists") return issued;
      const existing = this.recordFor(issued.lease.relayExposureLeaseId);
      if (existing
        && existing.parentConnection === parentConnection
        && existing.childConnection === childConnection
        && existing.status === "active") {
        return { ok: true, state: "idempotent", lease: cloneLease(existing.lease) };
      }
      return issued;
    }

    const activated = this.activate(issued.capability, binding, childConnection);
    if (activated.ok) {
      return { ok: true, state: "promoted", lease: activated.lease };
    }
    // This path is unreachable without an internal invariant violation, but
    // release the freshly issued binding rather than leaving a live bearer.
    this.revoke(parentConnection, issued.lease.relayExposureLeaseId, binding);
    return { ok: false, reason: "activation_failed" };
  }

  activate(
    capability: string | undefined,
    binding: RelayExposureBinding,
    childConnection: object,
  ): RelayExposureActivationResult {
    if (capability === undefined || capability.length === 0) return { ok: false, reason: "missing_capability" };
    if (!isRelayExposureCapability(capability) || !childConnection || typeof childConnection !== "object") {
      return { ok: false, reason: "forged_capability" };
    }
    const now = this.now();
    this.prune(now);
    const digest = capabilityDigest(capability);
    const record = this.recordsByDigest.get(digest);
    if (!record || record.capabilityDigest !== digest) return { ok: false, reason: "forged_capability" };
    if (record.status === "revoked" || record.status === "closed") return { ok: false, reason: "revoked_capability" };
    if (record.status === "expired" || record.lease.expiresAt <= now) {
      if (record.status !== "expired") this.terminate(record, "expired", "expired", now);
      return { ok: false, reason: "expired_capability" };
    }
    if (!isRelayExposureBinding(binding)) return { ok: false, reason: "forged_capability" };
    const normalized = normalizedBinding(binding);
    if (record.status === "active") {
      return firstBindingMismatch(record.lease.binding, normalized) === undefined && record.childConnection === childConnection
        ? { ok: true, state: "idempotent", lease: cloneLease(record.lease) }
        : { ok: false, reason: "replayed_capability" };
    }
    const mismatch = firstBindingMismatch(record.lease.binding, normalized);
    if (mismatch !== undefined) return { ok: false, reason: "binding_mismatch", field: mismatch };
    record.status = "active";
    record.childConnection = childConnection;
    return { ok: true, state: "activated", lease: cloneLease(record.lease) };
  }

  renew(
    parentConnection: object,
    relayExposureLeaseId: string,
    binding: RelayExposureBinding,
    options: { ttlMs: number; renewalId: string },
  ): RelayExposureRenewResult {
    const now = this.now();
    this.prune(now);
    const record = this.recordFor(relayExposureLeaseId);
    if (!record) return { ok: false, reason: "lease_not_found" };
    if (record.parentConnection !== parentConnection) return { ok: false, reason: "unauthorized_parent" };
    const delegation = this.delegations.get(parentConnection);
    if (!delegation) return { ok: false, reason: "unauthorized_parent" };
    if (delegation.expiresAt <= now) return { ok: false, reason: "delegation_expired" };
    const normalized = this.normalizedLifecycleBinding(binding);
    if (!normalized) return { ok: false, reason: "invalid_binding" };
    const mismatch = firstBindingMismatch(record.lease.binding, normalized);
    if (mismatch !== undefined) return { ok: false, reason: "binding_mismatch", field: mismatch };
    if (record.status !== "active") return { ok: false, reason: "lease_not_active" };
    if (!UUID_PATTERN.test(options.renewalId)) return { ok: false, reason: "invalid_renewal_id" };
    const renewalId = options.renewalId.toLowerCase();
    const previousReceipt = record.renewalReceipts.get(renewalId);
    if (previousReceipt) {
      return { ok: true, state: "idempotent", lease: cloneLease(previousReceipt) };
    }
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) return { ok: false, reason: "invalid_ttl" };
    if (options.ttlMs > delegation.maxLeaseTtlMs) return { ok: false, reason: "ttl_exceeds_maximum" };
    const nextExpiry = now + options.ttlMs;
    if (nextExpiry > delegation.expiresAt) return { ok: false, reason: "ttl_exceeds_delegation" };
    if (record.renewalReceipts.size >= this.maxRenewalReceiptsPerLease) {
      return { ok: false, reason: "renewal_capacity_exceeded" };
    }
    const state = nextExpiry > record.lease.expiresAt ? "renewed" : "idempotent";
    if (state === "renewed") {
      record.lease.expiresAt = nextExpiry;
      if (record.childConnection) {
        this.pendingRenewals.set(record.lease.relayExposureLeaseId, {
          lease: cloneLease(record.lease),
          childConnection: record.childConnection,
        });
      }
    }
    const receipt = cloneLease(record.lease);
    record.renewalReceipts.set(renewalId, receipt);
    return { ok: true, state, lease: cloneLease(receipt) };
  }

  revoke(
    parentConnection: object,
    relayExposureLeaseId: string,
    binding: RelayExposureBinding,
  ): RelayExposureRevokeResult {
    const now = this.now();
    this.prune(now);
    const record = this.recordFor(relayExposureLeaseId);
    if (!record) return { ok: false, reason: "lease_not_found" };
    if (record.parentConnection !== parentConnection) return { ok: false, reason: "unauthorized_parent" };
    const normalized = this.normalizedLifecycleBinding(binding);
    if (!normalized) return { ok: false, reason: "invalid_binding" };
    const mismatch = firstBindingMismatch(record.lease.binding, normalized);
    if (mismatch !== undefined) return { ok: false, reason: "binding_mismatch", field: mismatch };
    if (record.status !== "issued" && record.status !== "active") {
      return { ok: true, state: "idempotent", lease: cloneLease(record.lease) };
    }
    this.terminate(record, "revoked", "parent_revoked", now);
    return { ok: true, state: "revoked", lease: cloneLease(record.lease) };
  }

  closeByParent(
    parentConnection: object,
    relayExposureLeaseId: string,
    binding: RelayExposureBinding,
    closeReason: RelayExposureNormalCloseReason,
  ): RelayExposureCloseResult {
    const now = this.now();
    this.prune(now);
    const record = this.recordFor(relayExposureLeaseId);
    if (!record) return { ok: false, reason: "lease_not_found" };
    if (record.parentConnection !== parentConnection) return { ok: false, reason: "unauthorized_parent" };
    const normalized = this.normalizedLifecycleBinding(binding);
    if (!normalized) return { ok: false, reason: "invalid_binding" };
    if (!validCloseReason(closeReason)) return { ok: false, reason: "invalid_close_reason" };
    const mismatch = firstBindingMismatch(record.lease.binding, normalized);
    if (mismatch !== undefined) return { ok: false, reason: "binding_mismatch", field: mismatch };
    if (record.status !== "issued" && record.status !== "active") {
      return { ok: true, state: "idempotent", lease: cloneLease(record.lease) };
    }
    this.terminate(record, "closed", "child_closed", now, closeReason);
    return { ok: true, state: "closed", lease: cloneLease(record.lease) };
  }

  close(
    childConnection: object,
    relayExposureLeaseId: string,
    binding: RelayExposureBinding,
    closeReason: RelayExposureNormalCloseReason,
  ): RelayExposureCloseResult {
    const now = this.now();
    this.prune(now);
    const record = this.recordFor(relayExposureLeaseId);
    if (!record) return { ok: false, reason: "lease_not_found" };
    const normalized = this.normalizedLifecycleBinding(binding);
    if (!normalized) return { ok: false, reason: "invalid_binding" };
    if (!validCloseReason(closeReason)) return { ok: false, reason: "invalid_close_reason" };
    const mismatch = firstBindingMismatch(record.lease.binding, normalized);
    if (mismatch !== undefined) return { ok: false, reason: "binding_mismatch", field: mismatch };
    if (record.childConnection !== childConnection) return { ok: false, reason: "stale_child_connection" };
    if (record.status !== "active") {
      return record.status === "closed"
        ? { ok: true, state: "idempotent", lease: cloneLease(record.lease) }
        : { ok: false, reason: "lease_not_active" };
    }
    this.terminate(record, "closed", "child_closed", now, closeReason);
    return { ok: true, state: "closed", lease: cloneLease(record.lease) };
  }

  disconnectChild(childConnection: object): void {
    const now = this.now();
    this.prune(now);
    for (const record of this.recordsByDigest.values()) {
      if (record.status === "active" && record.childConnection === childConnection) {
        this.terminate(record, "closed", "child_disconnected", now);
      }
    }
  }

  expireDue(): void {
    this.prune(this.now());
  }

  drainRenewals(): RelayExposureRenewal[] {
    const renewals = [...this.pendingRenewals.values()].map((renewal) => ({
      ...renewal,
      lease: cloneLease(renewal.lease),
    }));
    this.pendingRenewals.clear();
    return renewals;
  }

  drainTransitions(): RelayExposureTransition[] {
    const transitions = [...this.pendingTransitions.values()].map((transition) => ({
      ...transition,
      lease: cloneLease(transition.lease),
    }));
    this.pendingTransitions.clear();
    return transitions;
  }
}
