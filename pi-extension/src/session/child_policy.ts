import type { RemotePiPackageIdentity } from "./package_identity.js";

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
  | "run-request"
  | "agent-default"
  | "remote-child-policy"
  | "built-in-local"
  | "descriptor"
  | "legacy-marker"
  | "invalid-descriptor"
  | "invalid-legacy-marker";

export interface ChildSessionDescriptorV1 {
  version: 1;
  kind: "pi-subagent-child";
  sessionClass: "child";
  runId: string;
  workspaceId: string;
  agentId: string;
  processEpoch: string;
  parentSessionId?: string;
  parentAgentId?: string;
  index: number;
  requestedExposure: ExposureMode;
  /** Additive v1 source metadata; absent means a legacy v1 launcher. */
  intentSource?: "run" | "agent" | "fallback";
  producer: {
    name: "pi-subagents";
    version: string;
    protocolVersion: 1;
    manifestSha256: string;
  };
  compatibility: {
    remotePi:
      | { state: "absent" }
      | {
        state: "compatible";
        version: string;
        protocolVersion: 1;
        manifestSha256: string;
      };
  };
}

export interface SessionExposurePolicy {
  classification: SessionClassification;
  mode: ExposureMode;
  source: ExposurePolicySource;
  diagnostic?: string;
  descriptor?: ChildSessionDescriptorV1;
  /** Desired child mode before the separate relay capability/lease gate. */
  requestedMode?: ExposureMode;
}

type Environment = Record<string, string | undefined>;
type RelayConfig = { auto_start_relay?: boolean; child_exposure?: ExposureMode };

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalNonEmpty(value: unknown): boolean {
  return value === undefined || nonEmpty(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isManifestHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function parseDescriptor(raw: string, loadedRemotePi?: RemotePiPackageIdentity):
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
  if (!nonEmpty(value["runId"]) || !isUuid(value["workspaceId"]) || !isUuid(value["agentId"]) || !isUuid(value["processEpoch"])) {
    return { ok: false, diagnostic: "child descriptor requires runId plus UUID workspaceId, agentId, and processEpoch" };
  }
  if (!optionalNonEmpty(value["parentSessionId"]) || (value["parentAgentId"] !== undefined && !isUuid(value["parentAgentId"]))) {
    return { ok: false, diagnostic: "child descriptor parent identifiers are invalid" };
  }
  if (!Number.isInteger(value["index"]) || (value["index"] as number) < 0) {
    return { ok: false, diagnostic: "child descriptor index must be a non-negative integer" };
  }
  const requested = value["requestedExposure"];
  if (requested !== "off" && requested !== "local" && requested !== "relay") {
    return { ok: false, diagnostic: "child descriptor requestedExposure is invalid" };
  }
  const intentSource = value["intentSource"];
  if (intentSource !== undefined && intentSource !== "run" && intentSource !== "agent" && intentSource !== "fallback") {
    return { ok: false, diagnostic: "child descriptor intentSource is invalid" };
  }
  const producer = value["producer"];
  if (!producer || typeof producer !== "object" || Array.isArray(producer)) {
    return { ok: false, diagnostic: "child descriptor producer metadata is required" };
  }
  const producerValue = producer as Record<string, unknown>;
  if (producerValue["name"] !== "pi-subagents" || !nonEmpty(producerValue["version"])
    || producerValue["protocolVersion"] !== 1 || !isManifestHash(producerValue["manifestSha256"])) {
    return { ok: false, diagnostic: "child descriptor producer metadata is invalid" };
  }
  const compatibility = value["compatibility"];
  const remotePi = compatibility && typeof compatibility === "object" && !Array.isArray(compatibility)
    ? (compatibility as Record<string, unknown>)["remotePi"]
    : undefined;
  if (!remotePi || typeof remotePi !== "object" || Array.isArray(remotePi)) {
    return { ok: false, diagnostic: "child descriptor remote-pi compatibility metadata is required" };
  }
  const remotePiValue = remotePi as Record<string, unknown>;
  if (remotePiValue["state"] !== "compatible") {
    return { ok: false, diagnostic: "loaded remote-pi was not compatibility-preflighted by the launcher" };
  }
  if (!nonEmpty(remotePiValue["version"]) || remotePiValue["protocolVersion"] !== 1 || !isManifestHash(remotePiValue["manifestSha256"])) {
    return { ok: false, diagnostic: "child descriptor compatible remote-pi metadata is invalid" };
  }
  if (loadedRemotePi
    && (remotePiValue["version"] !== loadedRemotePi.version
      || (remotePiValue["manifestSha256"] as string).toLowerCase() !== loadedRemotePi.manifestSha256.toLowerCase())) {
    return {
      ok: false,
      diagnostic: `preflight remote-pi identity does not match loaded remote-pi@${loadedRemotePi.version} (${loadedRemotePi.manifestSha256.slice(0, 12)})`,
    };
  }

  const descriptor: ChildSessionDescriptorV1 = {
    version: 1,
    kind: "pi-subagent-child",
    sessionClass: "child",
    runId: value["runId"],
    workspaceId: value["workspaceId"],
    agentId: value["agentId"],
    processEpoch: value["processEpoch"],
    index: value["index"] as number,
    requestedExposure: requested,
    ...(intentSource !== undefined ? { intentSource } : {}),
    producer: {
      name: "pi-subagents",
      version: producerValue["version"] as string,
      protocolVersion: 1,
      manifestSha256: (producerValue["manifestSha256"] as string).toLowerCase(),
    },
    compatibility: {
      remotePi: {
        state: "compatible",
        version: remotePiValue["version"] as string,
        protocolVersion: 1,
        manifestSha256: (remotePiValue["manifestSha256"] as string).toLowerCase(),
      },
    },
  };
  if (value["parentSessionId"] !== undefined) descriptor.parentSessionId = value["parentSessionId"] as string;
  if (value["parentAgentId"] !== undefined) descriptor.parentAgentId = value["parentAgentId"] as string;
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
  loadedRemotePi?: RemotePiPackageIdentity,
): SessionExposurePolicy {
  const rawDescriptor = env[CHILD_DESCRIPTOR_ENV];
  const legacyMarker = env[LEGACY_CHILD_ENV];

  if (rawDescriptor !== undefined) {
    const parsed = parseDescriptor(rawDescriptor, loadedRemotePi);
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
    const intentSource = parsed.descriptor.intentSource;
    const configuredChildMode = config.child_exposure;
    const requested = intentSource === "fallback"
      ? (configuredChildMode ?? "local")
      : parsed.descriptor.requestedExposure;
    const source: ExposurePolicySource = intentSource === "run"
      ? "run-request"
      : intentSource === "agent"
        ? "agent-default"
        : intentSource === "fallback"
          ? (configuredChildMode === undefined ? "built-in-local" : "remote-child-policy")
          : "descriptor";
    return {
      classification: "child_current",
      mode: requested === "off" ? "off" : "local",
      requestedMode: requested,
      source,
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

/**
 * Report actual transport exposure, not merely requested policy. Current child
 * sessions require both a live relay transport and the exact current
 * lease/epoch; normal sessions retain their historical global relay status.
 */
export function effectiveExposureForStatus(
  policy: SessionExposurePolicy,
  relayStarted: boolean,
  hasCurrentChildLease: boolean,
): ExposureMode {
  if (policy.mode === "off") return "off";
  if (!isChildSession(policy)) return relayStarted ? "relay" : "local";
  return policy.classification === "child_current" && relayStarted && hasCurrentChildLease
    ? "relay"
    : "local";
}
