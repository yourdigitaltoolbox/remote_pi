import { createHash, randomUUID } from "node:crypto";
import type { SessionExposurePolicy } from "./child_policy.js";
import type { LocalConfigInspection } from "./local_config.js";

export interface RuntimeIdentity {
  workspaceId: string;
  agentId: string;
  processEpoch: string;
}

export interface RuntimePresentation {
  displayName: string;
  runtimeAlias?: string;
}

export type RuntimeIdentityResolution =
  | {
      status: "ready";
      identity: RuntimeIdentity;
      presentation: RuntimePresentation;
      source: {
        workspaceId: "config" | "descriptor" | "config+descriptor" | "injected" | "config+injected" | "ephemeral";
        agentId: "descriptor" | "session-state" | "ephemeral";
        processEpoch: "descriptor" | "generated";
      };
    }
  | {
      status: "repair_required";
      reason: "config_repair_required" | "workspace_identity_missing" | "workspace_identity_mismatch" | "invalid_runtime_identity";
      diagnostic: string;
    };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function uuidFromStableText(domain: string, value: string): string {
  const bytes = createHash("sha256").update(domain).update("\0").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function agentIdFromSessionId(sessionId: string): string {
  if (!sessionId.trim()) throw new Error("Pi session id must not be empty.");
  return uuidFromStableText("remote-pi-session-agent-v1", sessionId.trim());
}

export function isRuntimeIdentity(identity: unknown): identity is RuntimeIdentity {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return false;
  const value = identity as Partial<RuntimeIdentity>;
  return typeof value.workspaceId === "string"
    && typeof value.agentId === "string"
    && typeof value.processEpoch === "string"
    && UUID_PATTERN.test(value.workspaceId)
    && UUID_PATTERN.test(value.agentId)
    && UUID_PATTERN.test(value.processEpoch);
}

export function resolveRuntimeIdentity(input: {
  config: LocalConfigInspection;
  exposure: SessionExposurePolicy;
  sessionId?: string;
  injectedWorkspaceId?: string;
  processEpoch?: string;
  displayName: string;
  generateUuid?: () => string;
}): RuntimeIdentityResolution {
  const generateUuid = input.generateUuid ?? randomUUID;
  if (input.config.state === "repair_required") {
    return { status: "repair_required", reason: "config_repair_required", diagnostic: input.config.diagnostic };
  }

  const injectedWorkspaceId = input.injectedWorkspaceId?.toLowerCase();
  if (injectedWorkspaceId && !UUID_PATTERN.test(injectedWorkspaceId)) {
    return { status: "repair_required", reason: "invalid_runtime_identity", diagnostic: "injected workspace identity is invalid" };
  }

  const descriptor = input.exposure.descriptor;
  if (descriptor) {
    if ((input.config.state === "loaded" && input.config.workspaceId.toLowerCase() !== descriptor.workspaceId.toLowerCase())
      || (injectedWorkspaceId && injectedWorkspaceId !== descriptor.workspaceId.toLowerCase())) {
      return {
        status: "repair_required",
        reason: "workspace_identity_mismatch",
        diagnostic: "child descriptor workspaceId does not match protected local workspace identity",
      };
    }
    const identity: RuntimeIdentity = {
      workspaceId: descriptor.workspaceId.toLowerCase(),
      agentId: descriptor.agentId.toLowerCase(),
      processEpoch: descriptor.processEpoch.toLowerCase(),
    };
    if (!isRuntimeIdentity(identity)) {
      return { status: "repair_required", reason: "invalid_runtime_identity", diagnostic: "child descriptor runtime identity is invalid" };
    }
    return {
      status: "ready",
      identity,
      presentation: { displayName: input.displayName },
      source: {
        workspaceId: input.config.state === "loaded" ? "config+descriptor" : "descriptor",
        agentId: "descriptor",
        processEpoch: "descriptor",
      },
    };
  }

  if (input.exposure.classification === "normal") {
    if (input.config.state === "loaded" && injectedWorkspaceId && input.config.workspaceId.toLowerCase() !== injectedWorkspaceId) {
      return {
        status: "repair_required",
        reason: "workspace_identity_mismatch",
        diagnostic: "injected workspaceId does not match protected local workspace identity",
      };
    }
    const workspaceId = input.config.state === "loaded" ? input.config.workspaceId : injectedWorkspaceId;
    if (!workspaceId) {
      return {
        status: "repair_required",
        reason: "workspace_identity_missing",
        diagnostic: "normal session requires a protected or supervisor-injected workspace identity",
      };
    }
    if (!input.sessionId?.trim()) {
      return { status: "repair_required", reason: "invalid_runtime_identity", diagnostic: "normal session is missing a stable Pi session id" };
    }
    const identity: RuntimeIdentity = {
      workspaceId,
      agentId: agentIdFromSessionId(input.sessionId),
      processEpoch: (input.processEpoch ?? generateUuid()).toLowerCase(),
    };
    if (!isRuntimeIdentity(identity)) {
      return { status: "repair_required", reason: "invalid_runtime_identity", diagnostic: "normal session runtime identity is invalid" };
    }
    return {
      status: "ready",
      identity,
      presentation: { displayName: input.displayName },
      source: {
        workspaceId: input.config.state === "loaded"
          ? injectedWorkspaceId ? "config+injected" : "config"
          : "injected",
        agentId: "session-state",
        processEpoch: "generated",
      },
    };
  }

  // Legacy/invalid child claims cannot mutate shared config. They receive
  // process-local correlation IDs only until upgraded launcher state exists.
  const identity: RuntimeIdentity = {
    workspaceId: input.config.state === "loaded" ? input.config.workspaceId : generateUuid(),
    agentId: generateUuid(),
    processEpoch: (input.processEpoch ?? generateUuid()).toLowerCase(),
  };
  if (!isRuntimeIdentity(identity)) {
    return { status: "repair_required", reason: "invalid_runtime_identity", diagnostic: "ephemeral child runtime identity is invalid" };
  }
  return {
    status: "ready",
    identity,
    presentation: { displayName: input.displayName },
    source: {
      workspaceId: input.config.state === "loaded" ? "config" : "ephemeral",
      agentId: "ephemeral",
      processEpoch: "generated",
    },
  };
}

export class EpochFence {
  private readonly current = new Map<string, string>();

  private key(identity: Pick<RuntimeIdentity, "workspaceId" | "agentId">): string {
    return `${identity.workspaceId.toLowerCase()}\0${identity.agentId.toLowerCase()}`;
  }

  activate(identity: RuntimeIdentity): "activated" | "idempotent" | "replaced" {
    if (!isRuntimeIdentity(identity)) throw new Error("Cannot activate invalid runtime identity.");
    const key = this.key(identity);
    const existing = this.current.get(key);
    if (existing === identity.processEpoch.toLowerCase()) return "idempotent";
    this.current.set(key, identity.processEpoch.toLowerCase());
    return existing === undefined ? "activated" : "replaced";
  }

  isCurrent(identity: RuntimeIdentity): boolean {
    return this.current.get(this.key(identity)) === identity.processEpoch.toLowerCase();
  }

  retire(identity: RuntimeIdentity): boolean {
    if (!this.isCurrent(identity)) return false;
    return this.current.delete(this.key(identity));
  }
}
