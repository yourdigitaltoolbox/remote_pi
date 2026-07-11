export const CHILD_DESCRIPTOR_ENV = "PI_SUBAGENT_DESCRIPTOR";
export const LEGACY_CHILD_ENV = "PI_SUBAGENT_CHILD";

export type SessionClassification =
  | "normal"
  | "child_current"
  | "child_legacy"
  | "child_invalid";

export type ExposureMode = "off" | "local" | "relay";

export type ExposurePolicySource =
  | "normal-config"
  | "descriptor"
  | "legacy-marker"
  | "invalid-descriptor"
  | "invalid-legacy-marker";

export interface ChildSessionDescriptorV1 {
  version: 1;
  kind: "pi-subagent-child";
  sessionClass: "child";
  runId: string;
  agentId: string;
  processEpoch: string;
  parentSessionId?: string;
  parentAgentId?: string;
  index?: number;
  requestedExposure?: ExposureMode;
}

export interface SessionExposurePolicy {
  classification: SessionClassification;
  mode: ExposureMode;
  source: ExposurePolicySource;
  diagnostic?: string;
  descriptor?: ChildSessionDescriptorV1;
}

type Environment = Record<string, string | undefined>;
type RelayConfig = { auto_start_relay?: boolean };

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalNonEmpty(value: unknown): boolean {
  return value === undefined || nonEmpty(value);
}

function parseDescriptor(raw: string):
  | { ok: true; descriptor: ChildSessionDescriptorV1 }
  | { ok: false; diagnostic: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, diagnostic: "child descriptor is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, diagnostic: "child descriptor must be an object" };
  }
  const value = parsed as Record<string, unknown>;
  if (value["version"] !== 1) {
    return { ok: false, diagnostic: "unsupported child descriptor version" };
  }
  if (value["kind"] !== "pi-subagent-child" || value["sessionClass"] !== "child") {
    return { ok: false, diagnostic: "invalid child descriptor kind or session class" };
  }
  if (!nonEmpty(value["runId"]) || !nonEmpty(value["agentId"]) || !nonEmpty(value["processEpoch"])) {
    return { ok: false, diagnostic: "child descriptor requires runId, agentId, and processEpoch" };
  }
  if (!optionalNonEmpty(value["parentSessionId"]) || !optionalNonEmpty(value["parentAgentId"])) {
    return { ok: false, diagnostic: "child descriptor parent identifiers must be non-empty strings" };
  }
  if (value["index"] !== undefined && (!Number.isInteger(value["index"]) || (value["index"] as number) < 0)) {
    return { ok: false, diagnostic: "child descriptor index must be a non-negative integer" };
  }
  const requested = value["requestedExposure"];
  if (requested !== undefined && requested !== "off" && requested !== "local" && requested !== "relay") {
    return { ok: false, diagnostic: "child descriptor requestedExposure is invalid" };
  }

  const descriptor: ChildSessionDescriptorV1 = {
    version: 1,
    kind: "pi-subagent-child",
    sessionClass: "child",
    runId: value["runId"],
    agentId: value["agentId"],
    processEpoch: value["processEpoch"],
  };
  if (value["parentSessionId"] !== undefined) descriptor.parentSessionId = value["parentSessionId"] as string;
  if (value["parentAgentId"] !== undefined) descriptor.parentAgentId = value["parentAgentId"] as string;
  if (value["index"] !== undefined) descriptor.index = value["index"] as number;
  if (requested !== undefined) descriptor.requestedExposure = requested;
  return { ok: true, descriptor };
}

/**
 * Resolve session classification separately from normal cwd relay consent.
 *
 * A descriptor or legacy marker is non-secret classification data. During the
 * legacy-safe rollout, it can only make behavior safer: `off` is honored and
 * every other child request is capped at local until a distinct relay
 * authorization capability is implemented and verified.
 */
export function resolveSessionExposure(
  env: Environment = process.env,
  config: RelayConfig = {},
): SessionExposurePolicy {
  const rawDescriptor = env[CHILD_DESCRIPTOR_ENV];
  const legacyMarker = env[LEGACY_CHILD_ENV];

  if (rawDescriptor !== undefined) {
    const parsed = parseDescriptor(rawDescriptor);
    if (!parsed.ok) {
      return {
        classification: "child_invalid",
        mode: "local",
        source: "invalid-descriptor",
        diagnostic: parsed.diagnostic,
      };
    }
    if (legacyMarker !== undefined && legacyMarker !== "1") {
      return {
        classification: "child_invalid",
        mode: "local",
        source: "invalid-legacy-marker",
        diagnostic: "current descriptor conflicts with legacy child marker",
      };
    }
    const requested = parsed.descriptor.requestedExposure;
    return {
      classification: "child_current",
      mode: requested === "off" ? "off" : "local",
      source: "descriptor",
      ...(requested === "relay"
        ? { diagnostic: "relay authorization capability is required; request capped at local" }
        : {}),
      descriptor: parsed.descriptor,
    };
  }

  if (legacyMarker === "1") {
    return {
      classification: "child_legacy",
      mode: "local",
      source: "legacy-marker",
      diagnostic: "legacy child marker is local-only",
    };
  }
  if (legacyMarker !== undefined && legacyMarker.length > 0) {
    return {
      classification: "child_invalid",
      mode: "local",
      source: "invalid-legacy-marker",
      diagnostic: "legacy child marker must equal 1",
    };
  }

  return {
    classification: "normal",
    mode: config.auto_start_relay === false ? "local" : "relay",
    source: "normal-config",
  };
}

export function isChildSession(policy: SessionExposurePolicy): boolean {
  return policy.classification !== "normal";
}
