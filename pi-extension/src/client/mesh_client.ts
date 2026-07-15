import type { Envelope } from "../session/envelope.js";
import {
  MeshNode,
  type MeshNodeOptions,
} from "../session/mesh_node.js";
import { isRuntimeIdentity } from "../session/runtime_identity.js";

/** Stable identity used by current mesh peers and opaque broker routes. */
export interface MeshRuntimeIdentity {
  workspaceId: string;
  agentId: string;
  processEpoch: string;
}

/** Optional self-managed cross-PC relay bridge. */
export interface MeshBridgeOptions {
  relayUrl: string;
  cwd: string;
  sessionName?: string;
}

/** Acknowledged-send terminal status. Only `received` is positive delivery. */
export type MeshAckStatus = "received" | "busy" | "denied" | "timeout";

export interface MeshClientOptions {
  /** Local Remote Pi broker socket or Windows named-pipe address. */
  sockPath: string;
  /** Human-readable presentation label. It is not routing authority. */
  name: string;
  /** Working directory metadata used only for presentation/legacy aliases. */
  cwd: string;
  /** Immutable logical identity plus fresh process epoch. */
  identity: MeshRuntimeIdentity;
  /** Optional append-only broker audit path. */
  auditPath?: string;
  /** Optional cross-PC relay bridge, active only when this process leads. */
  bridge?: MeshBridgeOptions;
  /** Redacted diagnostic logger. */
  log?: (message: string) => void;
}

export interface MeshIdentity {
  workspaceId: string;
  agentId: string;
}

export interface MeshIdentityResolutionOptions {
  /** Broker roster request timeout. Defaults to Remote Pi's 2 seconds. */
  timeoutMs?: number;
}

export type MeshIdentityResolutionCode =
  | "zero-match"
  | "multiple-match"
  | "missing-identity-address"
  | "disconnected"
  | "timeout";

/** Typed fail-closed outcome from {@link MeshClient.resolveIdentityTarget}. */
export class MeshIdentityResolutionError extends Error {
  constructor(
    public readonly code: MeshIdentityResolutionCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MeshIdentityResolutionError";
  }
}

/**
 * Runtime handle with no public data surface. Its private route binding lives in
 * a module-owned WeakMap; serialization is rejected rather than losing custody.
 */
class MeshIdentityTargetHandle {
  readonly #opaque = true;

  toJSON(): never {
    void this.#opaque;
    throw new TypeError("MeshIdentityTarget is opaque and non-serializable");
  }
}

/**
 * Opaque, client-owned authority target returned only by
 * {@link MeshClient.resolveIdentityTarget}. It has no route/address getter.
 */
export type MeshIdentityTarget = MeshIdentityTargetHandle;

interface TargetBinding {
  owner: MeshClient;
  generation: number;
  identityAddress: string;
}

const targetBindings = new WeakMap<MeshIdentityTargetHandle, TargetBinding>();

export interface MeshAgentSendOptions {
  /** Correlates this envelope as a reply to a previously received id. */
  re?: string | null;
  /** Target-retention receipt timeout. Defaults to Remote Pi's 5 seconds. */
  timeoutMs?: number;
}

export interface MeshAckResult {
  status: MeshAckStatus;
  /** The outbound envelope id. No target route is exposed. */
  id: string;
}

/**
 * Supported non-Pi Node facade for an outbound authority-bearing participant.
 *
 * The v1 contract is deliberately narrow: connect, resolve exactly one current
 * peer by immutable identity into an opaque handle, send one acknowledged
 * unicast through that handle, and close. It exposes no peer list, routes,
 * addresses, Broker, SessionPeer, inbound callback, or reconnect callback.
 */
export class MeshClient {
  readonly #node: MeshNode;
  readonly #log: (message: string) => void;
  #connectPromise: Promise<void> | null = null;
  #connected = false;
  #closed = false;
  #connectionGeneration = 0;

  constructor(options: MeshClientOptions) {
    requireNonEmpty(options.sockPath, "sockPath");
    requireNonEmpty(options.name, "name");
    requireNonEmpty(options.cwd, "cwd");
    if (!isRuntimeIdentity(options.identity)) {
      throw new Error("identity must contain valid workspaceId, agentId, and processEpoch UUIDs");
    }

    this.#log = options.log ?? (() => undefined);
    const nodeOptions: MeshNodeOptions = {
      sockPath: options.sockPath,
      name: options.name,
      cwd: options.cwd,
      identity: { ...options.identity },
      ...(options.auditPath === undefined ? {} : { auditPath: options.auditPath }),
      ...(options.bridge === undefined ? {} : { bridge: options.bridge }),
      log: this.#log,
    };
    this.#node = new MeshNode(nodeOptions);
    this.#node.onMessage((envelope) => this.#handleInbound(envelope));
    this.#node.onReconnect(() => {
      if (this.#connected && !this.#closed) this.#connectionGeneration += 1;
    });
  }

  /** Joins or leads the mesh. Concurrent calls share one registration attempt. */
  connect(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("mesh client is closed"));
    if (this.#connected) return Promise.resolve();
    if (this.#connectPromise) return this.#connectPromise;

    const attempt = this.#node.connect().then(() => {
      if (this.#closed) throw new Error("mesh client closed while connecting");
      this.#connected = true;
      this.#connectionGeneration += 1;
    });
    this.#connectPromise = attempt.catch((error) => {
      this.#connectPromise = null;
      throw error;
    });
    return this.#connectPromise;
  }

  /**
   * Resolves exactly one broker record by immutable workspace + agent identity.
   * The broker's non-empty `identityAddress` remains private in the returned
   * client-owned handle; no legacy field can be substituted.
   */
  async resolveIdentityTarget(
    identity: MeshIdentity,
    options: MeshIdentityResolutionOptions = {},
  ): Promise<MeshIdentityTarget> {
    this.#requireResolutionConnected();
    const generation = this.#connectionGeneration;

    let detailed: Awaited<ReturnType<MeshNode["listPeersDetailed"]>>["detailed"];
    try {
      const roster = options.timeoutMs === undefined
        ? await this.#node.listPeersDetailed()
        : await this.#node.listPeersDetailed(options.timeoutMs);
      detailed = roster.detailed;
    } catch (error) {
      throw resolutionTransportError(error);
    }

    if (this.#closed || !this.#connected || generation !== this.#connectionGeneration) {
      throw new MeshIdentityResolutionError(
        "disconnected",
        "mesh connection changed while resolving the identity target",
      );
    }

    const workspaceId = typeof identity?.workspaceId === "string"
      ? identity.workspaceId.toLowerCase()
      : "";
    const agentId = typeof identity?.agentId === "string"
      ? identity.agentId.toLowerCase()
      : "";
    const matches = detailed.filter((peer) =>
      typeof peer.workspaceId === "string"
      && typeof peer.agentId === "string"
      && peer.workspaceId.toLowerCase() === workspaceId
      && peer.agentId.toLowerCase() === agentId
    );

    if (matches.length === 0) {
      throw new MeshIdentityResolutionError("zero-match", "no mesh peer matched workspaceId + agentId");
    }
    if (matches.length > 1) {
      throw new MeshIdentityResolutionError("multiple-match", "multiple mesh peers matched workspaceId + agentId");
    }

    const identityAddress = matches[0]!.identityAddress;
    if (typeof identityAddress !== "string" || identityAddress.trim().length === 0) {
      throw new MeshIdentityResolutionError(
        "missing-identity-address",
        "matched mesh peer did not provide a broker identityAddress",
      );
    }

    const target = new MeshIdentityTargetHandle();
    Object.freeze(target);
    targetBindings.set(target, { owner: this, generation, identityAddress });
    return target;
  }

  /**
   * Sends one acknowledged unicast to a target resolved by this exact client.
   * Forged, serialized, foreign-client, stale-generation, and closed handles
   * are rejected before any route leaves private module custody.
   */
  agentSend(
    target: MeshIdentityTarget,
    body: unknown,
    options: MeshAgentSendOptions = {},
  ): Promise<MeshAckResult> {
    if (this.#closed) throw new Error("mesh client is closed");
    if (!this.#connected) throw new Error("mesh client is not connected");

    const binding = targetBindings.get(target);
    if (!binding) throw new Error("mesh identity target is invalid or forged");
    if (binding.owner !== this) throw new Error("mesh identity target belongs to another client");
    if (binding.generation !== this.#connectionGeneration) {
      throw new Error("mesh identity target is stale after reconnect");
    }

    const re = options.re ?? null;
    const send = options.timeoutMs === undefined
      ? this.#node.sendWithAck(binding.identityAddress, body, re)
      : this.#node.sendWithAck(binding.identityAddress, body, re, options.timeoutMs);
    return send.then(({ status, id }) => ({ status, id }));
  }

  /** Tears down relay ownership (if any) and leaves the local broker. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#connected = false;
    this.#connectionGeneration += 1;
    if (this.#connectPromise) {
      try { await this.#connectPromise; } catch { /* failed/closed connect still needs teardown */ }
    }
    await this.#node.close();
  }

  #requireResolutionConnected(): void {
    if (this.#closed || !this.#connected) {
      throw new MeshIdentityResolutionError("disconnected", "mesh client is not connected");
    }
  }

  #handleInbound(envelope: Envelope): void {
    if (envelope.from === "broker") {
      const body = envelope.body as { type?: unknown } | null;
      if (body && (body.type === "peer_joined" || body.type === "peer_left" || body.type === "peer_updated")) {
        void this.#refreshLocalPeers();
      }
      return;
    }

    if (!envelope.deliveryReceipt?.required) return;
    void this.#node.send("broker", {
      type: "mesh_delivery_receipt",
      envelopeId: envelope.id,
      status: "denied",
      code: "mesh-client-inbound-unsupported",
    }).catch((error) => {
      this.#log(`mesh client: could not deny unsupported inbound envelope: ${String(error)}`);
    });
  }

  async #refreshLocalPeers(): Promise<void> {
    if (!this.#connected || this.#closed) return;
    try {
      const { routes, detailed } = await this.#node.listPeersDetailed();
      const localRoutes = routes.filter((route) => {
        const info = detailed.find((peer) => peer.identityAddress === route);
        return info?.pc === undefined;
      });
      this.#node.onLocalPeersChanged(localRoutes);
    } catch (error) {
      this.#log(`mesh client: could not refresh local peer inventory: ${String(error)}`);
    }
  }
}

function resolutionTransportError(error: unknown): MeshIdentityResolutionError {
  if (error instanceof MeshIdentityResolutionError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  const code: MeshIdentityResolutionCode = /timed?\s*out|timeout/i.test(detail)
    ? "timeout"
    : "disconnected";
  return new MeshIdentityResolutionError(code, `could not resolve mesh identity target: ${detail}`, {
    cause: error,
  });
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must be a non-empty string`);
}
