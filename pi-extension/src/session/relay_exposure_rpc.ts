import {
  isRelayExposureBinding,
  isRelayExposureCapability,
  isRelayExposureLease,
  relayExposureCapabilityLeaseId,
  type RelayExposureBinding,
  type RelayExposureIssueResult,
  type RelayExposureLease,
  type RelayExposureNormalCloseReason,
} from "./relay_exposure_lease.js";

export const RELAY_EXPOSURE_RPC_VERSION = 1 as const;
export const RELAY_EXPOSURE_REQUEST_EVENT = "remote-pi:relay-exposure:v1:request";
export const RELAY_EXPOSURE_READY_EVENT = "remote-pi:relay-exposure:v1:ready";
export const RELAY_EXPOSURE_REPLY_EVENT_PREFIX = "remote-pi:relay-exposure:v1:reply:";
export const RELAY_EXPOSURE_CAPABILITY_ENV = "PI_SUBAGENT_RELAY_EXPOSURE_CAPABILITY";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISSUE_REQUEST_KEYS = new Set(["version", "requestId", "method", "binding", "ttlMs", "intentSource"]);
const PROMOTE_REQUEST_KEYS = new Set(["version", "requestId", "method", "binding", "ttlMs"]);
const LEGACY_ISSUE_REQUEST_KEYS = PROMOTE_REQUEST_KEYS;
const RENEW_REQUEST_KEYS = new Set(["version", "requestId", "method", "relayExposureLeaseId", "renewalId", "binding", "ttlMs"]);
const REVOKE_REQUEST_KEYS = new Set(["version", "requestId", "method", "relayExposureLeaseId", "binding"]);
const CLOSE_REQUEST_KEYS = new Set(["version", "requestId", "method", "relayExposureLeaseId", "binding", "reason"]);
const RUNNER_DELEGATE_EVENT_KEYS = new Set([
  "version", "requestId", "method", "rootRunId", "workspaceId",
  "delegationTtlMs", "maxLeaseTtlMs", "maxChildIssues", "intentSources",
]);
const SINGULAR_RUNNER_DELEGATE_EVENT_KEYS = new Set([
  "version", "requestId", "method", "rootRunId", "workspaceId",
  "delegationTtlMs", "maxLeaseTtlMs", "maxChildIssues", "intentSource",
]);
const LEGACY_RUNNER_DELEGATE_EVENT_KEYS = new Set([
  "version", "requestId", "method", "rootRunId", "workspaceId",
  "delegationTtlMs", "maxLeaseTtlMs", "maxChildIssues",
]);
const BROKER_ISSUE_REQUEST_KEYS = new Set(["type", "binding", "ttlMs"]);
const BROKER_PROMOTE_REQUEST_KEYS = new Set(["type", "binding", "ttlMs"]);
const BROKER_ACTIVATION_REQUEST_KEYS = new Set(["type", "capability", "runId", "mode"]);
const BROKER_RENEW_REQUEST_KEYS = new Set(["type", "relayExposureLeaseId", "renewalId", "binding", "ttlMs"]);
const BROKER_REVOKE_REQUEST_KEYS = new Set(["type", "relayExposureLeaseId", "binding"]);
const BROKER_CLOSE_REQUEST_KEYS = new Set(["type", "relayExposureLeaseId", "binding", "reason"]);
const CLOSED_NOTICE_KEYS = new Set(["type", "version", "relayExposureLeaseId", "binding", "reason"]);
const CLOSED_NORMAL_NOTICE_KEYS = new Set([...CLOSED_NOTICE_KEYS, "closeReason"]);
const RENEWED_NOTICE_KEYS = new Set(["type", "version", "relayExposureLeaseId", "binding", "expiresAt"]);
const PROMOTED_NOTICE_KEYS = new Set(["type", "version", "lease"]);
const ISSUE_SUCCESS_KEYS = new Set(["type", "ok", "capability", "lease"]);
const ISSUE_FAILURE_KEYS = new Set(["type", "ok", "reason"]);
const ISSUE_EXISTING_KEYS = new Set(["type", "ok", "reason", "lease"]);
const ACTIVATION_SUCCESS_KEYS = new Set(["type", "ok", "state", "lease"]);
const PROMOTE_SUCCESS_KEYS = new Set(["type", "ok", "state", "lease"]);
const PROMOTE_FAILURE_KEYS = new Set(["type", "ok", "reason"]);
const PROMOTE_EXISTING_KEYS = new Set(["type", "ok", "reason", "lease"]);
const ACTIVATION_FAILURE_KEYS = new Set(["type", "ok", "reason"]);
const ACTIVATION_MISMATCH_KEYS = new Set(["type", "ok", "reason", "field"]);
const LIFECYCLE_SUCCESS_KEYS = new Set(["type", "ok", "state", "lease"]);
const LIFECYCLE_FAILURE_KEYS = new Set(["type", "ok", "reason"]);
const LIFECYCLE_MISMATCH_KEYS = new Set(["type", "ok", "reason", "field"]);
const ISSUE_FAILURE_REASONS = new Set([
  "unauthorized_parent",
  "delegation_expired",
  "invalid_binding",
  "invalid_ttl",
  "ttl_exceeds_maximum",
  "ttl_exceeds_delegation",
  "parent_capacity_exceeded",
  "authority_capacity_exceeded",
]);
const LIFECYCLE_FAILURE_REASONS = new Set([
  "unauthorized_parent",
  "delegation_expired",
  "lease_not_found",
  "lease_not_active",
  "invalid_binding",
  "invalid_ttl",
  "invalid_renewal_id",
  "renewal_capacity_exceeded",
  "ttl_exceeds_maximum",
  "ttl_exceeds_delegation",
  "invalid_close_reason",
  "stale_child_connection",
  "invalid_request",
]);
const ACTIVATION_FAILURE_REASONS = new Set([
  "missing_capability",
  "forged_capability",
  "expired_capability",
  "revoked_capability",
  "replayed_capability",
]);
const BINDING_FIELDS = new Set<keyof RelayExposureBinding>([
  "runId",
  "workspaceId",
  "agentId",
  "processEpoch",
  "mode",
]);

export type RelayExposureIntentSource = "run" | "agent" | "fallback";

export interface RelayExposureIssueRequestV1 {
  version: 1;
  requestId: string;
  method: "issue";
  binding: RelayExposureBinding;
  ttlMs: number;
  intentSource: RelayExposureIntentSource;
}

export interface RelayExposurePromoteRequestV1 {
  version: 1;
  requestId: string;
  method: "promote";
  binding: RelayExposureBinding;
  ttlMs: number;
}

export interface RelayExposureRenewRequestV1 {
  version: 1;
  requestId: string;
  method: "renew";
  relayExposureLeaseId: string;
  renewalId: string;
  binding: RelayExposureBinding;
  ttlMs: number;
}

export interface RelayExposureRevokeRequestV1 {
  version: 1;
  requestId: string;
  method: "revoke";
  relayExposureLeaseId: string;
  binding: RelayExposureBinding;
}

export interface RelayExposureCloseRequestV1 {
  version: 1;
  requestId: string;
  method: "close";
  relayExposureLeaseId: string;
  binding: RelayExposureBinding;
  reason: RelayExposureNormalCloseReason;
}

export interface RelayRunnerDelegateEventRequestV1 {
  version: 1;
  requestId: string;
  method: "delegate_runner";
  rootRunId: string;
  workspaceId: string;
  delegationTtlMs: number;
  maxLeaseTtlMs: number;
  maxChildIssues: number;
  intentSources: RelayExposureIntentSource[];
}

export type RelayExposureRequestV1 =
  | RelayExposureIssueRequestV1
  | RelayExposurePromoteRequestV1
  | RelayExposureRenewRequestV1
  | RelayExposureRevokeRequestV1
  | RelayExposureCloseRequestV1
  | RelayRunnerDelegateEventRequestV1;

export type RelayExposureIssueReplyV1 = {
  version: 1;
  requestId: string;
} & (
  | ({ success: true } & Extract<RelayExposureIssueResult, { ok: true }>)
  | { success: false; reason: string }
);

export interface RelayExposureIssueBrokerRequest {
  type: "relay_lease_issue";
  binding: RelayExposureBinding;
  ttlMs: number;
}

export interface RelayExposurePromoteBrokerRequest {
  type: "relay_lease_promote";
  binding: RelayExposureBinding;
  ttlMs: number;
}

export interface RelayExposureActivationBrokerRequest {
  type: "relay_lease_activate";
  capability: string;
  runId: string;
  mode: "relay";
}

export interface RelayExposureRenewBrokerRequest {
  type: "relay_lease_renew";
  relayExposureLeaseId: string;
  renewalId: string;
  binding: RelayExposureBinding;
  ttlMs: number;
}

export interface RelayExposureRevokeBrokerRequest {
  type: "relay_lease_revoke";
  relayExposureLeaseId: string;
  binding: RelayExposureBinding;
}

export interface RelayExposureCloseBrokerRequest {
  type: "relay_lease_close";
  relayExposureLeaseId: string;
  binding: RelayExposureBinding;
  reason: RelayExposureNormalCloseReason;
}

export interface RelayExposurePromotedNotice {
  type: "relay_lease_promoted";
  version: 1;
  lease: RelayExposureLease;
}

export interface RelayExposureRenewedNotice {
  type: "relay_lease_renewed";
  version: 1;
  relayExposureLeaseId: string;
  binding: RelayExposureBinding;
  expiresAt: number;
}

export type RelayExposureClosedNotice =
  | {
      type: "relay_lease_closed";
      version: 1;
      relayExposureLeaseId: string;
      binding: RelayExposureBinding;
      reason: "parent_revoked" | "parent_disconnected" | "expired" | "child_disconnected";
    }
  | {
      type: "relay_lease_closed";
      version: 1;
      relayExposureLeaseId: string;
      binding: RelayExposureBinding;
      reason: "child_closed";
      closeReason: RelayExposureNormalCloseReason;
    };

export type RelayExposureLifecycleRequestV1 =
  | RelayExposureRenewRequestV1
  | RelayExposureRevokeRequestV1
  | RelayExposureCloseRequestV1;

export type RelayExposureLifecycleBrokerReply =
  | { type: "relay_lease_renew_result" | "relay_lease_revoke_result" | "relay_lease_close_result"; ok: true; state: "renewed" | "revoked" | "closed" | "idempotent"; lease: RelayExposureLease }
  | { type: "relay_lease_renew_result" | "relay_lease_revoke_result" | "relay_lease_close_result"; ok: false; reason: string; field?: keyof RelayExposureBinding };

export type RelayExposureIssueBrokerReply =
  | { type: "relay_lease_issue_result"; ok: true; capability: string; lease: RelayExposureLease }
  | { type: "relay_lease_issue_result"; ok: false; reason: "lease_already_exists"; lease: RelayExposureLease }
  | { type: "relay_lease_issue_result"; ok: false; reason: Exclude<Extract<RelayExposureIssueResult, { ok: false }>['reason'], "lease_already_exists"> };

export type RelayExposurePromoteBrokerReply =
  | { type: "relay_lease_promote_result"; ok: true; state: "promoted" | "idempotent"; lease: RelayExposureLease }
  | { type: "relay_lease_promote_result"; ok: false; reason: string; lease?: RelayExposureLease };

export type RelayExposureActivationBrokerReply =
  | { type: "relay_lease_activate_result"; ok: true; state: "activated" | "idempotent"; lease: RelayExposureLease }
  | { type: "relay_lease_activate_result"; ok: false; reason: "binding_mismatch"; field: keyof RelayExposureBinding }
  | { type: "relay_lease_activate_result"; ok: false; reason: "missing_capability" | "forged_capability" | "expired_capability" | "revoked_capability" | "replayed_capability" };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function sameBinding(left: RelayExposureBinding, right: RelayExposureBinding): boolean {
  return left.runId === right.runId
    && left.workspaceId.toLowerCase() === right.workspaceId.toLowerCase()
    && left.agentId.toLowerCase() === right.agentId.toLowerCase()
    && left.processEpoch.toLowerCase() === right.processEpoch.toLowerCase()
    && left.mode === right.mode;
}

export function relayExposureReplyEvent(requestId: string): string {
  if (!UUID_PATTERN.test(requestId)) throw new Error("Relay exposure RPC requestId must be a UUID.");
  return `${RELAY_EXPOSURE_REPLY_EVENT_PREFIX}${requestId.toLowerCase()}`;
}

export function parseRelayExposureIssueRequest(value: unknown): RelayExposureIssueRequestV1 | undefined {
  const input = record(value);
  if (!input || (!hasExactKeys(input, ISSUE_REQUEST_KEYS) && !hasExactKeys(input, LEGACY_ISSUE_REQUEST_KEYS))) return undefined;
  if (input["version"] !== RELAY_EXPOSURE_RPC_VERSION || input["method"] !== "issue") return undefined;
  if (typeof input["requestId"] !== "string" || !UUID_PATTERN.test(input["requestId"])) return undefined;
  if (!isRelayExposureBinding(input["binding"])) return undefined;
  if (input["intentSource"] !== undefined
    && input["intentSource"] !== "run"
    && input["intentSource"] !== "agent"
    && input["intentSource"] !== "fallback") return undefined;
  if (typeof input["ttlMs"] !== "number" || !Number.isSafeInteger(input["ttlMs"]) || input["ttlMs"] <= 0) return undefined;
  return {
    version: 1,
    requestId: input["requestId"].toLowerCase(),
    method: "issue",
    binding: { ...input["binding"] },
    ttlMs: input["ttlMs"],
    // Source-less v1 came from pre-D8 launchers that could request relay only
    // through explicit launcher/agent configuration (never policy fallback).
    // Preserve compatibility at the least-privileged explicit layer rather
    // than upgrading an unknown source to highest-precedence `run`.
    intentSource: input["intentSource"] ?? "agent",
  };
}

export function parseRelayExposurePromoteRequest(value: unknown): RelayExposurePromoteRequestV1 | undefined {
  const input = record(value);
  if (!input || !hasExactKeys(input, PROMOTE_REQUEST_KEYS)
    || input["version"] !== 1
    || input["method"] !== "promote"
    || typeof input["requestId"] !== "string"
    || !UUID_PATTERN.test(input["requestId"])
    || !isRelayExposureBinding(input["binding"])
    || typeof input["ttlMs"] !== "number"
    || !Number.isSafeInteger(input["ttlMs"])
    || input["ttlMs"] <= 0) return undefined;
  return input as unknown as RelayExposurePromoteRequestV1;
}

export function parseRelayExposureRenewRequest(value: unknown): RelayExposureRenewRequestV1 | undefined {
  const input = record(value);
  if (!input || !hasExactKeys(input, RENEW_REQUEST_KEYS)
    || input["version"] !== 1
    || input["method"] !== "renew"
    || typeof input["requestId"] !== "string"
    || !UUID_PATTERN.test(input["requestId"])
    || typeof input["relayExposureLeaseId"] !== "string"
    || !UUID_PATTERN.test(input["relayExposureLeaseId"])
    || typeof input["renewalId"] !== "string"
    || !UUID_PATTERN.test(input["renewalId"])
    || !isRelayExposureBinding(input["binding"])
    || typeof input["ttlMs"] !== "number"
    || !Number.isSafeInteger(input["ttlMs"])
    || input["ttlMs"] <= 0) return undefined;
  return input as unknown as RelayExposureRenewRequestV1;
}

export function parseRelayExposureRevokeRequest(value: unknown): RelayExposureRevokeRequestV1 | undefined {
  const input = record(value);
  if (!input || !hasExactKeys(input, REVOKE_REQUEST_KEYS)
    || input["version"] !== 1
    || input["method"] !== "revoke"
    || typeof input["requestId"] !== "string"
    || !UUID_PATTERN.test(input["requestId"])
    || typeof input["relayExposureLeaseId"] !== "string"
    || !UUID_PATTERN.test(input["relayExposureLeaseId"])
    || !isRelayExposureBinding(input["binding"])) return undefined;
  return input as unknown as RelayExposureRevokeRequestV1;
}

export function parseRelayExposureCloseRequest(value: unknown): RelayExposureCloseRequestV1 | undefined {
  const input = record(value);
  if (!input || !hasExactKeys(input, CLOSE_REQUEST_KEYS)
    || input["version"] !== 1
    || input["method"] !== "close"
    || typeof input["requestId"] !== "string"
    || !UUID_PATTERN.test(input["requestId"])
    || typeof input["relayExposureLeaseId"] !== "string"
    || !UUID_PATTERN.test(input["relayExposureLeaseId"])
    || !isRelayExposureBinding(input["binding"])
    || (input["reason"] !== "completed"
      && input["reason"] !== "interrupted"
      && input["reason"] !== "timeout"
      && input["reason"] !== "controlled_shutdown")) return undefined;
  return input as unknown as RelayExposureCloseRequestV1;
}

export function parseRelayRunnerDelegateEventRequest(value: unknown): RelayRunnerDelegateEventRequestV1 | undefined {
  const input = record(value);
  if (!input || (!hasExactKeys(input, RUNNER_DELEGATE_EVENT_KEYS)
    && !hasExactKeys(input, SINGULAR_RUNNER_DELEGATE_EVENT_KEYS)
    && !hasExactKeys(input, LEGACY_RUNNER_DELEGATE_EVENT_KEYS))
    || input["version"] !== 1
    || input["method"] !== "delegate_runner"
    || typeof input["requestId"] !== "string"
    || !UUID_PATTERN.test(input["requestId"])
    || typeof input["rootRunId"] !== "string"
    || !input["rootRunId"].trim()
    || Buffer.byteLength(input["rootRunId"], "utf8") > 512
    || typeof input["workspaceId"] !== "string"
    || !UUID_PATTERN.test(input["workspaceId"])
    || typeof input["delegationTtlMs"] !== "number"
    || !Number.isSafeInteger(input["delegationTtlMs"])
    || input["delegationTtlMs"] <= 0
    || typeof input["maxLeaseTtlMs"] !== "number"
    || !Number.isSafeInteger(input["maxLeaseTtlMs"])
    || input["maxLeaseTtlMs"] <= 0
    || typeof input["maxChildIssues"] !== "number"
    || !Number.isSafeInteger(input["maxChildIssues"])
    || input["maxChildIssues"] <= 0) return undefined;
  const singular = input["intentSource"];
  if (singular !== undefined && singular !== "run" && singular !== "agent" && singular !== "fallback") return undefined;
  const plural = input["intentSources"];
  if (plural !== undefined && (!Array.isArray(plural)
    || plural.length === 0
    || plural.length > 3
    || plural.some((source) => source !== "run" && source !== "agent" && source !== "fallback")
    || new Set(plural).size !== plural.length)) return undefined;
  // See issue parsing above: an omitted legacy source is explicit but
  // unknowable, so normalize it to the lower-precedence `agent` layer.
  const sources = plural ?? (singular === undefined ? ["agent"] : [singular]);
  const { intentSource: _singular, ...normalized } = input;
  return { ...normalized, intentSources: [...sources] } as unknown as RelayRunnerDelegateEventRequestV1;
}

export function parseRelayExposureRequest(value: unknown): RelayExposureRequestV1 | undefined {
  const input = record(value);
  if (!input || typeof input["method"] !== "string") return undefined;
  if (input["method"] === "issue") return parseRelayExposureIssueRequest(input);
  if (input["method"] === "promote") return parseRelayExposurePromoteRequest(input);
  if (input["method"] === "renew") return parseRelayExposureRenewRequest(input);
  if (input["method"] === "revoke") return parseRelayExposureRevokeRequest(input);
  if (input["method"] === "close") return parseRelayExposureCloseRequest(input);
  if (input["method"] === "delegate_runner") return parseRelayRunnerDelegateEventRequest(input);
  return undefined;
}

export function parseRelayExposureIssueBrokerRequest(value: unknown): RelayExposureIssueBrokerRequest | undefined {
  const input = record(value);
  if (!input || !hasExactKeys(input, BROKER_ISSUE_REQUEST_KEYS)
    || input["type"] !== "relay_lease_issue"
    || !isRelayExposureBinding(input["binding"])
    || typeof input["ttlMs"] !== "number"
    || !Number.isSafeInteger(input["ttlMs"])
    || input["ttlMs"] <= 0) return undefined;
  return input as unknown as RelayExposureIssueBrokerRequest;
}

export function parseRelayExposurePromoteBrokerRequest(value: unknown): RelayExposurePromoteBrokerRequest | undefined {
  const input = record(value);
  if (!input || !hasExactKeys(input, BROKER_PROMOTE_REQUEST_KEYS)
    || input["type"] !== "relay_lease_promote"
    || !isRelayExposureBinding(input["binding"])
    || typeof input["ttlMs"] !== "number"
    || !Number.isSafeInteger(input["ttlMs"])
    || input["ttlMs"] <= 0) return undefined;
  return input as unknown as RelayExposurePromoteBrokerRequest;
}

export function parseRelayExposureActivationBrokerRequest(value: unknown): RelayExposureActivationBrokerRequest | undefined {
  const input = record(value);
  if (!input || !hasExactKeys(input, BROKER_ACTIVATION_REQUEST_KEYS)
    || input["type"] !== "relay_lease_activate"
    || !isRelayExposureCapability(input["capability"])
    || typeof input["runId"] !== "string"
    || input["runId"].trim().length === 0
    || Buffer.byteLength(input["runId"], "utf8") > 512
    || input["mode"] !== "relay") return undefined;
  return input as unknown as RelayExposureActivationBrokerRequest;
}

export function parseRelayExposureRenewBrokerRequest(value: unknown): RelayExposureRenewBrokerRequest | undefined {
  const input = record(value);
  if (!input || !hasExactKeys(input, BROKER_RENEW_REQUEST_KEYS)
    || input["type"] !== "relay_lease_renew"
    || typeof input["relayExposureLeaseId"] !== "string"
    || !UUID_PATTERN.test(input["relayExposureLeaseId"])
    || typeof input["renewalId"] !== "string"
    || !UUID_PATTERN.test(input["renewalId"])
    || !isRelayExposureBinding(input["binding"])
    || typeof input["ttlMs"] !== "number"
    || !Number.isSafeInteger(input["ttlMs"])
    || input["ttlMs"] <= 0) return undefined;
  return input as unknown as RelayExposureRenewBrokerRequest;
}

export function parseRelayExposureRevokeBrokerRequest(value: unknown): RelayExposureRevokeBrokerRequest | undefined {
  const input = record(value);
  if (!input || !hasExactKeys(input, BROKER_REVOKE_REQUEST_KEYS)
    || input["type"] !== "relay_lease_revoke"
    || typeof input["relayExposureLeaseId"] !== "string"
    || !UUID_PATTERN.test(input["relayExposureLeaseId"])
    || !isRelayExposureBinding(input["binding"])) return undefined;
  return input as unknown as RelayExposureRevokeBrokerRequest;
}

export function parseRelayExposureCloseBrokerRequest(value: unknown): RelayExposureCloseBrokerRequest | undefined {
  const input = record(value);
  if (!input || !hasExactKeys(input, BROKER_CLOSE_REQUEST_KEYS)
    || input["type"] !== "relay_lease_close"
    || typeof input["relayExposureLeaseId"] !== "string"
    || !UUID_PATTERN.test(input["relayExposureLeaseId"])
    || !isRelayExposureBinding(input["binding"])
    || (input["reason"] !== "completed"
      && input["reason"] !== "interrupted"
      && input["reason"] !== "timeout"
      && input["reason"] !== "controlled_shutdown")) return undefined;
  return input as unknown as RelayExposureCloseBrokerRequest;
}

export function parseRelayExposurePromotedNotice(
  value: unknown,
  now = Date.now(),
): RelayExposurePromotedNotice | undefined {
  const input = record(value);
  if (!input
    || !hasExactKeys(input, PROMOTED_NOTICE_KEYS)
    || input["type"] !== "relay_lease_promoted"
    || input["version"] !== 1
    || !isRelayExposureLease(input["lease"])
    || input["lease"].expiresAt <= now) return undefined;
  return input as unknown as RelayExposurePromotedNotice;
}

export function parseRelayExposureRenewedNotice(
  value: unknown,
  now = Date.now(),
): RelayExposureRenewedNotice | undefined {
  const input = record(value);
  if (!input
    || !hasExactKeys(input, RENEWED_NOTICE_KEYS)
    || input["type"] !== "relay_lease_renewed"
    || input["version"] !== 1
    || typeof input["relayExposureLeaseId"] !== "string"
    || !UUID_PATTERN.test(input["relayExposureLeaseId"])
    || !isRelayExposureBinding(input["binding"])
    || typeof input["expiresAt"] !== "number"
    || !Number.isSafeInteger(input["expiresAt"])
    || input["expiresAt"] <= now) return undefined;
  return input as unknown as RelayExposureRenewedNotice;
}

export function parseRelayExposureClosedNotice(value: unknown): RelayExposureClosedNotice | undefined {
  const input = record(value);
  if (!input
    || input["type"] !== "relay_lease_closed"
    || input["version"] !== 1
    || typeof input["relayExposureLeaseId"] !== "string"
    || !UUID_PATTERN.test(input["relayExposureLeaseId"])
    || !isRelayExposureBinding(input["binding"])
    || typeof input["reason"] !== "string") return undefined;
  if (input["reason"] === "child_closed") {
    if (!hasExactKeys(input, CLOSED_NORMAL_NOTICE_KEYS)
      || (input["closeReason"] !== "completed"
        && input["closeReason"] !== "interrupted"
        && input["closeReason"] !== "timeout"
        && input["closeReason"] !== "controlled_shutdown")) return undefined;
    return input as unknown as RelayExposureClosedNotice;
  }
  if (!hasExactKeys(input, CLOSED_NOTICE_KEYS)
    || (input["reason"] !== "parent_revoked"
      && input["reason"] !== "parent_disconnected"
      && input["reason"] !== "expired"
      && input["reason"] !== "child_disconnected")) return undefined;
  return input as unknown as RelayExposureClosedNotice;
}

export function parseRelayExposureLifecycleBrokerReply(
  value: unknown,
  request: RelayExposureLifecycleRequestV1,
  now = Date.now(),
): RelayExposureLifecycleBrokerReply | undefined {
  const input = record(value);
  const expectedType = request.method === "renew"
    ? "relay_lease_renew_result"
    : request.method === "revoke"
      ? "relay_lease_revoke_result"
      : "relay_lease_close_result";
  if (!input || input["type"] !== expectedType) return undefined;
  if (input["ok"] === true) {
    const allowedStates = request.method === "renew"
      ? new Set(["renewed", "idempotent"])
      : request.method === "revoke"
        ? new Set(["revoked", "idempotent"])
        : new Set(["closed", "idempotent"]);
    if (!hasExactKeys(input, LIFECYCLE_SUCCESS_KEYS)
      || typeof input["state"] !== "string"
      || !allowedStates.has(input["state"])
      || !isRelayExposureLease(input["lease"])
      || input["lease"].relayExposureLeaseId.toLowerCase() !== request.relayExposureLeaseId.toLowerCase()
      || !sameBinding(input["lease"].binding, request.binding)
      || (request.method === "renew" && input["lease"].expiresAt <= now)) return undefined;
    return input as unknown as RelayExposureLifecycleBrokerReply;
  }
  if (input["ok"] !== false || typeof input["reason"] !== "string") return undefined;
  if (input["reason"] === "binding_mismatch") {
    if (!hasExactKeys(input, LIFECYCLE_MISMATCH_KEYS)
      || typeof input["field"] !== "string"
      || !BINDING_FIELDS.has(input["field"] as keyof RelayExposureBinding)) return undefined;
    return input as unknown as RelayExposureLifecycleBrokerReply;
  }
  if (!hasExactKeys(input, LIFECYCLE_FAILURE_KEYS) || !LIFECYCLE_FAILURE_REASONS.has(input["reason"])) return undefined;
  return input as unknown as RelayExposureLifecycleBrokerReply;
}

export function parseRelayExposureIssueBrokerReply(
  value: unknown,
  now = Date.now(),
): RelayExposureIssueBrokerReply | undefined {
  const input = record(value);
  if (!input || input["type"] !== "relay_lease_issue_result") return undefined;
  if (input["ok"] === true) {
    if (!hasExactKeys(input, ISSUE_SUCCESS_KEYS)
      || !isRelayExposureCapability(input["capability"])
      || !isRelayExposureLease(input["lease"])
      || input["lease"].expiresAt <= now
      || relayExposureCapabilityLeaseId(input["capability"]) !== input["lease"].relayExposureLeaseId.toLowerCase()) return undefined;
    return input as RelayExposureIssueBrokerReply;
  }
  if (input["ok"] !== false || typeof input["reason"] !== "string") return undefined;
  if (input["reason"] === "lease_already_exists") {
    if (!hasExactKeys(input, ISSUE_EXISTING_KEYS) || !isRelayExposureLease(input["lease"])) return undefined;
    return input as RelayExposureIssueBrokerReply;
  }
  if (!hasExactKeys(input, ISSUE_FAILURE_KEYS) || !ISSUE_FAILURE_REASONS.has(input["reason"])) return undefined;
  return input as RelayExposureIssueBrokerReply;
}

export function parseRelayExposurePromoteBrokerReply(
  value: unknown,
  binding: RelayExposureBinding,
  now = Date.now(),
): RelayExposurePromoteBrokerReply | undefined {
  const input = record(value);
  if (!input || input["type"] !== "relay_lease_promote_result") return undefined;
  if (input["ok"] === true) {
    if (!hasExactKeys(input, PROMOTE_SUCCESS_KEYS)
      || (input["state"] !== "promoted" && input["state"] !== "idempotent")
      || !isRelayExposureLease(input["lease"])
      || !sameBinding(input["lease"].binding, binding)
      || input["lease"].expiresAt <= now) return undefined;
    return input as unknown as RelayExposurePromoteBrokerReply;
  }
  if (input["ok"] !== false || typeof input["reason"] !== "string") return undefined;
  if (input["reason"] === "lease_already_exists") {
    if (!hasExactKeys(input, PROMOTE_EXISTING_KEYS)
      || !isRelayExposureLease(input["lease"])
      || !sameBinding(input["lease"].binding, binding)) return undefined;
    return input as unknown as RelayExposurePromoteBrokerReply;
  }
  if (!hasExactKeys(input, PROMOTE_FAILURE_KEYS)
    || (!ISSUE_FAILURE_REASONS.has(input["reason"]) && input["reason"] !== "activation_failed" && input["reason"] !== "target_not_found" && input["reason"] !== "target_epoch_mismatch")) return undefined;
  return input as unknown as RelayExposurePromoteBrokerReply;
}

export function parseRelayExposureActivationBrokerReply(
  value: unknown,
  capability: string,
  now = Date.now(),
): RelayExposureActivationBrokerReply | undefined {
  if (!isRelayExposureCapability(capability)) return undefined;
  const input = record(value);
  if (!input || input["type"] !== "relay_lease_activate_result") return undefined;
  if (input["ok"] === true) {
    if (!hasExactKeys(input, ACTIVATION_SUCCESS_KEYS)
      || (input["state"] !== "activated" && input["state"] !== "idempotent")
      || !isRelayExposureLease(input["lease"])
      || input["lease"].expiresAt <= now
      || relayExposureCapabilityLeaseId(capability) !== input["lease"].relayExposureLeaseId.toLowerCase()) return undefined;
    return input as RelayExposureActivationBrokerReply;
  }
  if (input["ok"] !== false || typeof input["reason"] !== "string") return undefined;
  if (input["reason"] === "binding_mismatch") {
    if (!hasExactKeys(input, ACTIVATION_MISMATCH_KEYS)
      || typeof input["field"] !== "string"
      || !BINDING_FIELDS.has(input["field"] as keyof RelayExposureBinding)) return undefined;
    return input as RelayExposureActivationBrokerReply;
  }
  if (!hasExactKeys(input, ACTIVATION_FAILURE_KEYS) || !ACTIVATION_FAILURE_REASONS.has(input["reason"])) return undefined;
  return input as RelayExposureActivationBrokerReply;
}
