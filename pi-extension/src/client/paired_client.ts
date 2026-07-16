import { randomUUID } from "node:crypto";
import type {
  ClientMessage,
  LifecycleRepairAction,
  LifecycleRepairEvidenceClass,
  LifecycleLane,
  ServerMessage,
} from "../protocol/types.js";
import { decodeServer } from "../protocol/codec.js";
import { generateEd25519Keypair, type Ed25519Keypair } from "../pairing/crypto.js";
import { RelayClient } from "../transport/relay_client.js";

/** A reply correlated to a lifecycle status request. */
export type LifecycleStatusReply = Extract<ServerMessage, { type: "lifecycle_status" }>;
/** A reply correlated to a lifecycle repair request. */
export type LifecycleRepairReply = Extract<ServerMessage, { type: "lifecycle_repair" }>;
/** A reply correlated to a compact request. */
export type CompactReply = Extract<ServerMessage, { type: "action_ok" | "action_error" }>;
/** A terminal outcome pushed after a lifecycle-owned compact operation. */
export type LifecycleOutcome = Extract<ServerMessage, { type: "lifecycle_outcome" }>;
/** A correlated relay rejection, including an unpaired-owner rejection. */
export type ClientErrorReply = Extract<ServerMessage, { type: "error" }>;
/** The only replies exposed by paired action calls. */
export type PairedActionReply = LifecycleStatusReply | LifecycleRepairReply | CompactReply | ClientErrorReply;

/**
 * An in-memory Ed25519 identity for one public paired-client connection.
 * It is deliberately ephemeral: this facade never reads or writes a profile,
 * keychain, pairing store, or test injection point.
 */
const identityKeys = new WeakMap<EphemeralClientIdentity, Ed25519Keypair>();

export class EphemeralClientIdentity {
  private constructor() {}

  /** Relay peer id, useful only for redacted connection observability. */
  get peerId(): string {
    return Buffer.from(identityKey(this).publicKey).toString("base64");
  }

  /** Creates a new identity which is discarded when its process exits. */
  static create(): EphemeralClientIdentity {
    const identity = new EphemeralClientIdentity();
    identityKeys.set(identity, generateEd25519Keypair());
    return identity;
  }
}

function identityKey(identity: EphemeralClientIdentity): Ed25519Keypair {
  const keypair = identityKeys.get(identity);
  if (!keypair) throw new Error("identity was not created by remote-pi/client");
  return keypair;
}

/** Creates a new in-memory identity for {@link PairedClient.connect}. */
export function createEphemeralClientIdentity(): EphemeralClientIdentity {
  return EphemeralClientIdentity.create();
}

export interface PairedClientConnectOptions {
  /** Self-hosted or hosted relay URL (`http(s)` and `ws(s)` are accepted). */
  relayUrl: string;
  /** `remotepi://pair?...` URI emitted by `/remote-pi pair`; do not log it. */
  pairingUri: string;
  /** Human-readable device label persisted by the Pi only after successful pairing. */
  deviceName: string;
  /** Optional caller-created in-memory identity; defaults to a fresh identity. */
  identity?: EphemeralClientIdentity;
  /** Per-request timeout. Defaults to 5 seconds. */
  requestTimeoutMs?: number;
}

export interface LifecycleRepairRequest {
  action: LifecycleRepairAction;
  operationId: string;
  sessionId: string;
  generationId: string;
  expectedPhase: "blocked-unknown";
  expectedSequence: number;
  evidenceClass: LifecycleRepairEvidenceClass;
  consumerId?: string;
  laneId?: LifecycleLane;
  evidenceEntryId?: string;
}

interface PairingTarget {
  peerId: string;
  roomId: string;
}

interface ParsedPairingTarget extends PairingTarget {
  token: string;
}

interface PendingReply {
  resolve: (reply: PairedActionReply | Extract<ServerMessage, { type: "pair_ok" | "pair_error" }>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Authenticated, ephemeral Node client for the documented paired-owner actions.
 *
 * Construct it with {@link PairedClient.connect}, call {@link pair} once, then
 * use the typed action methods. The relay authenticates this client with a new
 * Ed25519 identity; the pairing URI token grants owner admission exactly once.
 */
export class PairedClient {
  private readonly pending = new Map<string, PendingReply>();
  private readonly outcomeListeners = new Set<(outcome: LifecycleOutcome) => void>();
  private paired = false;

  private constructor(
    private readonly relay: RelayClient,
    private readonly target: PairingTarget,
    private pairingToken: string | null,
    private readonly deviceName: string,
    private readonly requestTimeoutMs: number,
  ) {
    relay.on("message", (line) => this.onRelayMessage(line));
    relay.on("close", () => this.rejectPending(new Error("relay connection closed")));
    relay.on("error", (error) => this.rejectPending(error));
  }

  /** Opens the relay and completes relay challenge-response authentication. */
  static async connect(options: PairedClientConnectOptions): Promise<PairedClient> {
    const parsedTarget = parsePairingUri(options.pairingUri);
    const relay = new RelayClient(normalizeRelayUrl(options.relayUrl), identityKey(options.identity ?? EphemeralClientIdentity.create()));
    const timeout = options.requestTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new Error("requestTimeoutMs must be a positive integer");
    }
    const client = new PairedClient(
      relay,
      { peerId: parsedTarget.peerId, roomId: parsedTarget.roomId },
      parsedTarget.token,
      options.deviceName,
      timeout,
    );
    await relay.connect();
    return client;
  }

  /** Whether this instance has received a correlated `pair_ok`. */
  get isPaired(): boolean {
    return this.paired;
  }

  /**
   * Consumes the pairing URI token and requires its correlated `pair_ok`.
   * A `pair_error` is returned as a typed result; no pairing token is retained.
   */
  async pair(): Promise<Extract<ServerMessage, { type: "pair_ok" | "pair_error" }>> {
    const token = this.pairingToken;
    if (!token) throw new Error("pairing token has already been consumed by this client");
    // Consume locally before I/O so concurrent callers cannot replay this
    // single-use capability while the first request is in flight.
    this.pairingToken = null;
    const reply = await this.request({ type: "pair_request", token, device_name: this.deviceName });
    if (reply.type === "pair_ok") this.paired = true;
    if (reply.type !== "pair_ok" && reply.type !== "pair_error") {
      throw new Error(`unexpected pairing reply: ${reply.type}`);
    }
    return reply;
  }

  /** Requests redacted lifecycle metadata from the paired owner. */
  lifecycleStatus(): Promise<LifecycleStatusReply | ClientErrorReply> {
    return this.request({ type: "lifecycle_status" }).then((reply) => {
      if (reply.type === "lifecycle_status" || reply.type === "error") return reply;
      throw new Error(`unexpected lifecycle status reply: ${reply.type}`);
    });
  }

  /** Requests lifecycle-owned context compaction. Observe `onLifecycleOutcome` for terminal state. */
  compact(): Promise<CompactReply | ClientErrorReply> {
    return this.request({ type: "session_compact" }).then((reply) => {
      if (reply.type === "action_ok" || reply.type === "action_error" || reply.type === "error") return reply;
      throw new Error(`unexpected compact reply: ${reply.type}`);
    });
  }

  /** Sends all mandatory lifecycle CAS predicates without client-side bypasses. */
  lifecycleRepair(request: LifecycleRepairRequest): Promise<LifecycleRepairReply | ClientErrorReply> {
    return this.request({
      type: "lifecycle_repair",
      action: request.action,
      operation_id: request.operationId,
      session_id: request.sessionId,
      generation_id: request.generationId,
      expected_phase: request.expectedPhase,
      expected_sequence: request.expectedSequence,
      evidence_class: request.evidenceClass,
      ...(request.consumerId ? { consumer_id: request.consumerId } : {}),
      ...(request.laneId ? { lane_id: request.laneId } : {}),
      ...(request.evidenceEntryId ? { evidence_entry_id: request.evidenceEntryId } : {}),
    }).then((reply) => {
      if (reply.type === "lifecycle_repair" || reply.type === "error") return reply;
      throw new Error(`unexpected lifecycle repair reply: ${reply.type}`);
    });
  }

  /** Subscribes to unsolicited terminal lifecycle outcomes. Returns an unsubscribe function. */
  onLifecycleOutcome(listener: (outcome: LifecycleOutcome) => void): () => void {
    this.outcomeListeners.add(listener);
    return () => this.outcomeListeners.delete(listener);
  }

  /** Closes the relay connection and rejects any in-flight correlated calls. */
  close(): void {
    this.rejectPending(new Error("paired client closed"));
    this.relay.close();
  }

  private request(message: { type: ClientMessage["type"]; [field: string]: unknown }): Promise<PairedActionReply | Extract<ServerMessage, { type: "pair_ok" | "pair_error" }>> {
    const id = randomUUID();
    const inner = { ...message, id } as ClientMessage;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`paired client request timed out: ${inner.type}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const ct = Buffer.from(JSON.stringify(inner)).toString("base64");
        this.relay.send(JSON.stringify({ peer: this.target.peerId, room: this.target.roomId, ct }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onRelayMessage(line: string): void {
    let outer: { peer?: unknown; ct?: unknown };
    try {
      outer = JSON.parse(line) as { peer?: unknown; ct?: unknown };
    } catch {
      return;
    }
    if (outer.peer !== this.target.peerId || typeof outer.ct !== "string") return;
    let reply: ServerMessage;
    try {
      reply = decodeServer(Buffer.from(outer.ct, "base64").toString("utf8"));
    } catch {
      return;
    }
    if (reply.type === "lifecycle_outcome") {
      for (const listener of this.outcomeListeners) listener(reply);
      return;
    }
    const correlation = "in_reply_to" in reply ? reply.in_reply_to : undefined;
    if (!correlation) return;
    const pending = this.pending.get(correlation);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(correlation);
    pending.resolve(reply as PairedActionReply | Extract<ServerMessage, { type: "pair_ok" | "pair_error" }>);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function parsePairingUri(value: string): ParsedPairingTarget {
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error("invalid pairing URI");
  }
  if (uri.protocol !== "remotepi:" || uri.hostname !== "pair") {
    throw new Error("invalid pairing URI scheme");
  }
  const token = uri.searchParams.get("t");
  const encodedPeer = uri.searchParams.get("epk");
  const roomId = uri.searchParams.get("rm") ?? "main";
  if (!token || !encodedPeer || !roomId) throw new Error("pairing URI is missing t, epk, or rm");
  let peerBytes: Buffer;
  try {
    peerBytes = Buffer.from(encodedPeer, "base64url");
  } catch {
    throw new Error("pairing URI has invalid epk");
  }
  if (peerBytes.length !== 32) throw new Error("pairing URI has invalid epk");
  return { token, peerId: peerBytes.toString("base64"), roomId };
}

function normalizeRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid relay URL");
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("relay URL must use http(s) or ws(s)");
  return url.toString();
}
