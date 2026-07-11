import { isRelayExposureBinding, type RelayExposureBinding, type RelayExposureIntentSource, type RelayExposureNormalCloseReason } from "./relay_exposure_lease.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNNER_TOKEN_PATTERN = /^rprd1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const MAX_RUN_ID_BYTES = 512;
const DELEGATE_KEYS = new Set(["type", "version", "rootRunId", "workspaceId", "delegationTtlMs", "maxLeaseTtlMs", "maxChildIssues", "intentSources"]);
const LEGACY_DELEGATE_KEYS = new Set(["type", "version", "rootRunId", "workspaceId", "delegationTtlMs", "maxLeaseTtlMs", "maxChildIssues"]);
const DELEGATE_SUCCESS_KEYS = new Set(["type", "version", "ok", "token", "expiresAt", "maxLeaseTtlMs", "maxChildIssues"]);
const DELEGATE_FAILURE_KEYS = new Set(["type", "version", "ok", "reason"]);
const ISSUE_KEYS = new Set(["type", "version", "requestId", "token", "binding", "ttlMs", "intentSource"]);
const LEGACY_ISSUE_KEYS = new Set(["type", "version", "requestId", "token", "binding", "ttlMs"]);
const RENEW_KEYS = new Set(["type", "version", "requestId", "token", "relayExposureLeaseId", "renewalId", "binding", "ttlMs"]);
const REVOKE_KEYS = new Set(["type", "version", "requestId", "token", "relayExposureLeaseId", "binding"]);
const CLOSE_KEYS = new Set(["type", "version", "requestId", "token", "relayExposureLeaseId", "binding", "reason"]);
const RELEASE_KEYS = new Set(["type", "version", "requestId", "token"]);
const DELEGATE_FAILURE_REASONS = new Set([
  "unauthorized_parent", "delegation_expired", "invalid_runner_scope", "invalid_ttl",
  "ttl_exceeds_delegation", "ttl_exceeds_maximum", "invalid_child_issue_limit",
  "runner_delegation_capacity_exceeded", "invalid_request",
]);

function exact(value: object, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function intentSource(value: unknown): value is RelayExposureIntentSource {
  return value === "run" || value === "agent" || value === "fallback";
}

function intentSources(value: unknown): RelayExposureIntentSource[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3 || !value.every(intentSource)) return undefined;
  const unique = [...new Set(value)];
  return unique.length === value.length ? unique : undefined;
}

export function isRelayRunnerDelegationToken(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RUNNER_TOKEN_PATTERN.exec(value);
  return match !== null && UUID_PATTERN.test(match[1]!);
}

export interface RelayRunnerDelegateRequest {
  type: "relay_runner_delegate";
  version: 1;
  rootRunId: string;
  workspaceId: string;
  delegationTtlMs: number;
  maxLeaseTtlMs: number;
  maxChildIssues: number;
  intentSources: RelayExposureIntentSource[];
}

export type RelayRunnerDelegateResult =
  | { type: "relay_runner_delegate_result"; version: 1; ok: true; token: string; expiresAt: number; maxLeaseTtlMs: number; maxChildIssues: number }
  | { type: "relay_runner_delegate_result"; version: 1; ok: false; reason: string };

interface RunnerBase {
  version: 1;
  requestId: string;
  token: string;
}

export type RelayRunnerRequest =
  | (RunnerBase & { type: "relay_runner_issue"; binding: RelayExposureBinding; ttlMs: number; intentSource: RelayExposureIntentSource })
  | (RunnerBase & { type: "relay_runner_renew"; relayExposureLeaseId: string; renewalId: string; binding: RelayExposureBinding; ttlMs: number })
  | (RunnerBase & { type: "relay_runner_revoke"; relayExposureLeaseId: string; binding: RelayExposureBinding })
  | (RunnerBase & { type: "relay_runner_close"; relayExposureLeaseId: string; binding: RelayExposureBinding; reason: RelayExposureNormalCloseReason })
  | (RunnerBase & { type: "relay_runner_release" });

export function parseRelayRunnerDelegateRequest(value: unknown): RelayRunnerDelegateRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (!exact(value, DELEGATE_KEYS) && !exact(value, LEGACY_DELEGATE_KEYS))) return undefined;
  const input = value as Partial<RelayRunnerDelegateRequest>;
  if (input.type !== "relay_runner_delegate" || input.version !== 1) return undefined;
  if (typeof input.rootRunId !== "string" || !input.rootRunId.trim() || Buffer.byteLength(input.rootRunId, "utf8") > MAX_RUN_ID_BYTES) return undefined;
  if (!uuid(input.workspaceId) || !positiveInteger(input.delegationTtlMs) || !positiveInteger(input.maxLeaseTtlMs) || !positiveInteger(input.maxChildIssues)) return undefined;
  // Pre-D8 runners omitted source metadata. They could not request protected
  // policy fallback, so retain compatibility at the least-privileged explicit
  // layer instead of upgrading the unknown source to `run`.
  const sources = input.intentSources === undefined ? ["agent" as const] : intentSources(input.intentSources);
  if (!sources) return undefined;
  return { ...input, intentSources: sources } as RelayRunnerDelegateRequest;
}

export function parseRelayRunnerDelegateResult(value: unknown): RelayRunnerDelegateResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Partial<RelayRunnerDelegateResult>;
  if (input.type !== "relay_runner_delegate_result" || input.version !== 1 || typeof input.ok !== "boolean") return undefined;
  if (input.ok) {
    if (!exact(value, DELEGATE_SUCCESS_KEYS)
      || !isRelayRunnerDelegationToken((input as { token?: unknown }).token)
      || !positiveInteger((input as { expiresAt?: unknown }).expiresAt)
      || !positiveInteger((input as { maxLeaseTtlMs?: unknown }).maxLeaseTtlMs)
      || !positiveInteger((input as { maxChildIssues?: unknown }).maxChildIssues)) return undefined;
  } else {
    if (!exact(value, DELEGATE_FAILURE_KEYS)
      || typeof (input as { reason?: unknown }).reason !== "string"
      || !DELEGATE_FAILURE_REASONS.has((input as { reason: string }).reason)) return undefined;
  }
  return input as RelayRunnerDelegateResult;
}

function validReason(value: unknown): value is RelayExposureNormalCloseReason {
  return value === "completed" || value === "interrupted" || value === "timeout" || value === "controlled_shutdown";
}

export function parseRelayRunnerRequest(value: unknown): RelayRunnerRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || !uuid(input.requestId) || !isRelayRunnerDelegationToken(input.token)) return undefined;
  if (input.type === "relay_runner_release") return exact(value, RELEASE_KEYS) ? input as unknown as RelayRunnerRequest : undefined;
  if (!isRelayExposureBinding(input.binding)) return undefined;
  if (input.type === "relay_runner_issue") {
    if ((!exact(value, ISSUE_KEYS) && !exact(value, LEGACY_ISSUE_KEYS)) || !positiveInteger(input.ttlMs)) return undefined;
    if (input.intentSource !== undefined && !intentSource(input.intentSource)) return undefined;
    return { ...input, intentSource: input.intentSource ?? "agent" } as unknown as RelayRunnerRequest;
  }
  if (input.type === "relay_runner_renew") {
    return exact(value, RENEW_KEYS) && uuid(input.relayExposureLeaseId) && uuid(input.renewalId) && positiveInteger(input.ttlMs)
      ? input as unknown as RelayRunnerRequest : undefined;
  }
  if (input.type === "relay_runner_revoke") {
    return exact(value, REVOKE_KEYS) && uuid(input.relayExposureLeaseId) ? input as unknown as RelayRunnerRequest : undefined;
  }
  if (input.type === "relay_runner_close") {
    return exact(value, CLOSE_KEYS) && uuid(input.relayExposureLeaseId) && validReason(input.reason)
      ? input as unknown as RelayRunnerRequest : undefined;
  }
  return undefined;
}
