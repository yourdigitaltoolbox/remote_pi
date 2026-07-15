import type { Envelope } from "../session/envelope.js";
import type { PeerInfo } from "../session/broker.js";
import {
  MeshNode,
  type MeshNodeOptions,
  type MeshSelfRelayBridge,
} from "../session/mesh_node.js";
import {
  isRuntimeIdentity,
  type RuntimeIdentity,
} from "../session/runtime_identity.js";
import type { AckResult, AckStatus } from "../session/peer.js";

/** Stable identity used by current mesh peers and opaque broker routes. */
export type MeshRuntimeIdentity = RuntimeIdentity;
/** Structured broker-owned peer metadata; consumers must not parse routes. */
export type MeshPeerInfo = PeerInfo;
/** Acknowledged-send terminal status. Only `received` is positive delivery. */
export type MeshAckStatus = AckStatus;
/** Result of one acknowledged unicast send. */
export type MeshAckResult = AckResult;
/** Optional self-managed cross-PC relay bridge. */
export type MeshBridgeOptions = MeshSelfRelayBridge;

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

export interface MeshConnection {
  /** Broker-assigned presentation label. */
  name: string;
  /** Broker-assigned opaque primary route. Echo it verbatim. */
  address: string;
}

export interface MeshPeerRoster {
  /** Authoritative, echo-safe routes with this client excluded. */
  routes: string[];
  /** Structured metadata for current peers and capable legacy peers. */
  detailed: MeshPeerInfo[];
}

export interface MeshAgentSendOptions {
  /** Correlates this envelope as a reply to a previously received id. */
  re?: string | null;
  /** Target-retention receipt timeout. Defaults to Remote Pi's 5 seconds. */
  timeoutMs?: number;
}

/**
 * Supported non-Pi Node facade for an outbound Remote Pi mesh participant.
 *
 * The v1 contract is deliberately narrow: connect, discover structured peers,
 * send one acknowledged unicast, and close. It does not expose Broker,
 * SessionPeer, private storage, route composition, or an inbound consumer.
 * Incoming acknowledged agent envelopes are therefore honestly denied rather
 * than accepted without a durable application inbox.
 */
export class MeshClient {
  private readonly node: MeshNode;
  private readonly log: (message: string) => void;
  private connectPromise: Promise<MeshConnection> | null = null;
  private connection: MeshConnection | null = null;
  private closed = false;

  constructor(options: MeshClientOptions) {
    requireNonEmpty(options.sockPath, "sockPath");
    requireNonEmpty(options.name, "name");
    requireNonEmpty(options.cwd, "cwd");
    if (!isRuntimeIdentity(options.identity)) {
      throw new Error("identity must contain valid workspaceId, agentId, and processEpoch UUIDs");
    }

    this.log = options.log ?? (() => undefined);
    const nodeOptions: MeshNodeOptions = {
      sockPath: options.sockPath,
      name: options.name,
      cwd: options.cwd,
      identity: { ...options.identity },
      ...(options.auditPath === undefined ? {} : { auditPath: options.auditPath }),
      ...(options.bridge === undefined ? {} : { bridge: options.bridge }),
      log: this.log,
    };
    this.node = new MeshNode(nodeOptions);
    this.node.onMessage((envelope) => this.handleInbound(envelope));
  }

  /** Joins or leads the mesh. Concurrent calls share one registration attempt. */
  connect(): Promise<MeshConnection> {
    if (this.closed) return Promise.reject(new Error("mesh client is closed"));
    if (this.connection) return Promise.resolve({ ...this.connection });
    if (this.connectPromise) return this.connectPromise;

    const attempt = this.node.connect().then((name) => {
      if (this.closed) throw new Error("mesh client closed while connecting");
      const connection = { name, address: this.node.address() };
      this.connection = connection;
      return { ...connection };
    });
    this.connectPromise = attempt.catch((error) => {
      this.connectPromise = null;
      throw error;
    });
    return this.connectPromise;
  }

  /** Returns broker-owned routes plus structured identity/presentation fields. */
  listPeersDetailed(timeoutMs?: number): Promise<MeshPeerRoster> {
    this.requireConnected();
    return timeoutMs === undefined
      ? this.node.listPeersDetailed()
      : this.node.listPeersDetailed(timeoutMs);
  }

  /**
   * Sends one unicast and waits for the target-retention ACK.
   * Only `status === "received"` is positive delivery.
   */
  agentSend(to: string, body: unknown, options: MeshAgentSendOptions = {}): Promise<MeshAckResult> {
    this.requireConnected();
    requireNonEmpty(to, "to");
    if (to === "broadcast") throw new Error("agentSend requires one unicast route");
    const re = options.re ?? null;
    return options.timeoutMs === undefined
      ? this.node.sendWithAck(to, body, re)
      : this.node.sendWithAck(to, body, re, options.timeoutMs);
  }

  /** Tears down relay ownership (if any) and leaves the local broker. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.connectPromise) {
      try { await this.connectPromise; } catch { /* failed/closed connect still needs teardown */ }
    }
    await this.node.close();
    this.connection = null;
  }

  private requireConnected(): void {
    if (this.closed) throw new Error("mesh client is closed");
    if (!this.connection) throw new Error("mesh client is not connected");
  }

  private handleInbound(envelope: Envelope): void {
    if (envelope.from === "broker") {
      const body = envelope.body as { type?: unknown } | null;
      if (body && (body.type === "peer_joined" || body.type === "peer_left" || body.type === "peer_updated")) {
        void this.refreshLocalPeers();
      }
      return;
    }

    if (!envelope.deliveryReceipt?.required) return;
    void this.node.send("broker", {
      type: "mesh_delivery_receipt",
      envelopeId: envelope.id,
      status: "denied",
      code: "mesh-client-inbound-unsupported",
    }).catch((error) => {
      this.log(`mesh client: could not deny unsupported inbound envelope: ${String(error)}`);
    });
  }

  private async refreshLocalPeers(): Promise<void> {
    if (!this.connection || this.closed) return;
    try {
      const { routes, detailed } = await this.node.listPeersDetailed();
      const localRoutes = routes.filter((route) => {
        const info = detailed.find((peer) => (peer.identityAddress ?? peer.address) === route);
        return info?.pc === undefined;
      });
      this.node.onLocalPeersChanged(localRoutes);
    } catch (error) {
      this.log(`mesh client: could not refresh local peer inventory: ${String(error)}`);
    }
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must be a non-empty string`);
}
