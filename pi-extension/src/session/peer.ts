import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { type Envelope, envelope, parse, serialize, EnvelopeError } from "./envelope.js";
import { joinOrLead, type ElectionResult } from "./leader_election.js";
import { Broker } from "./broker.js";
import type { RuntimeIdentity } from "./runtime_identity.js";

/**
 * Symmetric peer-in-session API. Hides whether you are leader or follower;
 * `send`, `request`, `onMessage`, `rename`, `leave` all work the same.
 *
 * Pending map demuxes parallel `request()` calls by message `id` → `re`.
 *
 * Failover: when the leader dies, follower socket emits `close`. Remaining
 * peers re-run `joinOrLead`. One becomes the new leader; others reconnect.
 */
export type MessageHandler = (env: Envelope) => void;
export type ReconnectHandler = () => void;

export interface SessionPeerOptions {
  sockPath: string;
  name: string;
  /** Working directory used for presentation and the legacy compatibility
   * alias. Current ownership/routing uses `identity`; old peers use cwd/name. */
  cwd?: string;
  /** Legacy-only same-(cwd,name) takeover. Current identity registrations
   *  reject duplicate live owners instead of taking them over. */
  takeoverExisting?: boolean;
  /** Immutable canonical runtime identity. When present, broker registration,
   * duplicate detection, and presentation updates are ID-keyed. */
  identity?: RuntimeIdentity;
  auditPath?: string;
  /** Per-request default timeout (ms). Override per call if needed. */
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const ACK_TIMEOUT_MS = 5_000;
const FAILOVER_RETRY_MS = 100;

export type AckStatus = "received" | "busy" | "denied" | "timeout";

export interface AckResult {
  status: AckStatus;
  /** The original envelope id that was awaiting ACK. */
  id: string;
  /** Target name reported by broker (when ACK arrived). Undefined on timeout. */
  target?: string;
}

interface AckBody {
  type: "ack";
  status: "received" | "busy" | "denied";
  target: string;
}

export class SessionPeer {
  private readonly opts: SessionPeerOptions;
  /** Clean leaf name actually assigned by the broker (may carry a `#N`
   *  collision suffix). Used for display + self-filtering. */
  private assignedName: string;
  /** Primary route assigned by the broker. Current peers receive immutable
   *  `~identity/<workspaceId>/<agentId>`; legacy peers receive cwd/name. */
  private assignedAddress: string;
  private role: "leader" | "follower" = "follower";
  private broker: Broker | null = null;
  private socket: Socket | null = null;
  private buf = "";
  /** Map of in-flight request ids → resolver. Used by `request()`. */
  private readonly pending = new Map<string, {
    resolve: (env: Envelope) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** Map of in-flight send ids → ACK resolver. Used by `sendWithAck()`. */
  private readonly ackPending = new Map<string, {
    resolve: (result: AckResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly handlers = new Set<MessageHandler>();
  private readonly reconnectHandlers = new Set<ReconnectHandler>();
  private leftFlag = false;

  constructor(opts: SessionPeerOptions) {
    this.opts = opts;
    this.assignedName = opts.name;
    this.assignedAddress = opts.name;
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Joins or leads the session at `sockPath`. Resolves with the assigned name. */
  async start(): Promise<string> {
    return this._joinOrLead();
  }

  /** Returns the clean leaf name as assigned by the broker (after any `#N`). */
  name(): string {
    return this.assignedName;
  }

  /** Returns the broker-assigned primary route. Echo it; never compose it. */
  address(): string {
    return this.assignedAddress;
  }

  /** Immutable runtime identity for current-protocol peers; null for legacy. */
  identity(): RuntimeIdentity | null {
    return this.opts.identity ? { ...this.opts.identity } : null;
  }

  /** Returns "leader" or "follower" — current role. */
  currentRole(): "leader" | "follower" {
    return this.role;
  }

  /** Returns the locally-hosted Broker when this peer is the leader, or
   *  null when it's a follower. Wave 25C uses this to attach the
   *  cross-PC router. */
  localBroker(): Broker | null {
    return this.broker;
  }

  /**
   * Fire-and-forget send. Doesn't await a reply.
   *
   * `re` (optional) lets the caller correlate this message as a reply to a
   * previous request — when an LLM peer is *answering* a question from
   * another agent, it must echo the original `id` here so the requester's
   * pending map can resolve. Without `re`, the requester treats this as a
   * new unsolicited message and its `request()` call times out.
   */
  async send(
    to: string | string[],
    body: unknown,
    re: string | null = null,
  ): Promise<void> {
    const env = envelope(this.assignedAddress, to, body, re);
    await this._writeEnvelope(env);
  }

  /**
   * Unicast send + await broker ACK. Returns the ACK status:
   *   - `received` — peer was idle, envelope delivered, will be processed soon
   *   - `busy`     — peer mid-turn, envelope dropped; sender is owner of retry
   *   - `denied`   — peer explicitly refused (reserved; no producer in MVP)
   *   - `timeout`  — no ACK within `timeoutMs`; treat as transport error
   *
   * Only meaningful for unicast non-broadcast addresses. The peer's body-level
   * reply (if any) is asynchronous and arrives as a normal inbound envelope
   * carrying `re=<this-send-id>` in a future turn — handled by `onMessage`.
   */
  async sendWithAck(
    to: string,
    body: unknown,
    re: string | null = null,
    timeoutMs: number = ACK_TIMEOUT_MS,
  ): Promise<AckResult> {
    const env = envelope(this.assignedAddress, to, body, re);
    return new Promise<AckResult>((resolve) => {
      const timer = setTimeout(() => {
        this.ackPending.delete(env.id);
        resolve({ status: "timeout", id: env.id });
      }, timeoutMs);
      this.ackPending.set(env.id, { resolve, timer });
      this._writeEnvelope(env).catch(() => {
        const slot = this.ackPending.get(env.id);
        if (!slot) return;
        clearTimeout(slot.timer);
        this.ackPending.delete(env.id);
        resolve({ status: "timeout", id: env.id });
      });
    });
  }

  /**
   * Send + await reply. Resolves with the first inbound envelope whose `re`
   * matches the outbound `id`. Rejects on timeout.
   */
  async request(
    to: string,
    body: unknown,
    timeoutMs: number = this.opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  ): Promise<Envelope> {
    const env = envelope(this.assignedAddress, to, body, null);
    return new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(env.id);
        reject(new Error(`request to ${to} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(env.id, { resolve, reject, timer });
      this._writeEnvelope(env).catch((err) => {
        const slot = this.pending.get(env.id);
        if (!slot) return;
        clearTimeout(slot.timer);
        this.pending.delete(env.id);
        reject(err);
      });
    });
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Fires after the peer successfully (re)joins following a failover —
   * leader died and we re-elected. NOT called for the initial `start()`,
   * only for post-drop reconnects. Consumers use this to re-query state
   * the broker may have lost in the transition (e.g., peer list).
   */
  onReconnect(handler: ReconnectHandler): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }

  /**
   * Requests a different display name. Current peers update presentation in
   * place and retain their ID route; legacy peers use the historical rejoin.
   */
  async rename(newName: string): Promise<string> {
    if (this.opts.identity) {
      const reply = await this.request("broker", { type: "update_presentation", name: newName });
      const body = reply.body as { type?: string; name?: string } | null;
      if (!body || body.type !== "presentation_updated" || typeof body.name !== "string") {
        throw new Error("broker rejected presentation update");
      }
      this.opts.name = body.name;
      this.assignedName = body.name;
      return body.name;
    }
    await this._teardownConn();
    this.opts.name = newName;
    this.assignedName = newName;
    return this._joinOrLead();
  }

  async leave(): Promise<void> {
    this.leftFlag = true;
    await this._teardownConn();
  }

  // ── join / failover loop ──────────────────────────────────────────────────

  private async _joinOrLead(): Promise<string> {
    const result: ElectionResult = await joinOrLead(this.opts.sockPath);
    if (result.role === "leader") {
      this.role = "leader";
      this.broker = new Broker({
        server: result.server,
        auditPath: this.opts.auditPath,
      });
      // Leader also registers itself as a peer so other followers see it +
      // can address it. We create a self-loopback socket via the broker's
      // internal API: easiest is to open a real client connection back to
      // our own server.
      return this._registerAsClient();
    } else {
      this.role = "follower";
      this._wireSocket(result.socket);
      return this._registerOver(result.socket);
    }
  }

  private async _registerAsClient(): Promise<string> {
    const { createConnection } = await import("node:net");
    const sock = createConnection(this.opts.sockPath);
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", reject);
    });
    this._wireSocket(sock);
    return this._registerOver(sock);
  }

  private _wireSocket(sock: Socket): void {
    this.socket = sock;
    this.buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this._onData(chunk));
    sock.on("close", () => this._onSocketClose(sock));
    sock.on("error", () => { /* close will follow */ });
  }

  private _registerOver(sock: Socket): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // The first inbound line MUST be the register_ack. Buffer-aware.
      const wait = setTimeout(() => reject(new Error("register_ack timeout")), 5_000);
      const onceListener = (raw: unknown) => {
        clearTimeout(wait);
        // Current brokers return an ID-first `address_assigned` plus a clean
        // presentation `name_assigned`. Cross-fallback preserves old brokers
        // where address and name were the same alias.
        const ack = raw as { type?: string; code?: string; name_assigned?: string; address_assigned?: string };
        if (ack?.type === "register_rejected") {
          this._preAckListener = null;
          const message = ack.code === "duplicate_identity"
            ? "duplicate runtime identity is already active"
            : ack.code === "workspace_cwd_conflict"
              ? "workspace identity is already active from a different cwd"
              : `broker rejected registration: ${ack.code ?? "unknown"}`;
          reject(new Error(message));
          return;
        }
        const name = typeof ack?.name_assigned === "string" ? ack.name_assigned : ack?.address_assigned;
        const address = typeof ack?.address_assigned === "string" ? ack.address_assigned : ack?.name_assigned;
        if (ack && ack.type === "register_ack" && typeof name === "string" && typeof address === "string") {
          this.assignedName = name;
          this.assignedAddress = address;
          this._preAckListener = null;
          resolve(name);
        } else {
          reject(new Error(`expected register_ack, got: ${JSON.stringify(raw)}`));
        }
      };
      this._preAckListener = onceListener;
      const req = JSON.stringify({
        type: "register",
        name: this.opts.name,
        // Only include cwd when set — keeps the wire identical to the legacy
        // payload for callers that don't supply it (broker treats absent cwd
        // as "no take-over", i.e. the old #N behavior).
        ...(this.opts.cwd !== undefined ? { cwd: this.opts.cwd } : {}),
        ...(this.opts.takeoverExisting === true ? { takeover: true } : {}),
        ...(this.opts.identity ? { identity: this.opts.identity } : {}),
      }) + "\n";
      try {
        sock.write(req);
      } catch (e) {
        clearTimeout(wait);
        reject(e as Error);
      }
    });
  }

  private _preAckListener: ((raw: unknown) => void) | null = null;

  private _onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      this._handleLine(line);
    }
  }

  private _handleLine(line: string): void {
    // Before register_ack: parse loosely as an ack control message.
    if (this._preAckListener) {
      try {
        const parsed = JSON.parse(line) as unknown;
        this._preAckListener(parsed);
      } catch {
        // Garbage during register window — ignore.
      }
      return;
    }

    // Regular envelope.
    let env: Envelope;
    try {
      env = parse(line);
    } catch (e) {
      if (e instanceof EnvelopeError) return;
      throw e;
    }

    // Intercept broker ACKs first. Body shape `{type:"ack", status, target}`
    // from broker correlates by `re` against pending `sendWithAck` ids. Even
    // when no `sendWithAck` is waiting (e.g. message was sent via plain
    // `send()` or legacy `request()`), the ACK envelope must be swallowed
    // here — otherwise it would match `request()`'s pending map by `re` and
    // resolve the request with the ACK body instead of the peer's real reply.
    //
    // Plan/25 Wave D: cross-PC ACKs arrive with prefixed sender
    // (`<pcLabel>:broker`) since broker_remote rewrites `from` to include
    // the source PC label. Accept both forms here so cross-PC senders
    // resolve their `sendWithAck` Promise instead of timing out.
    if (env.re && (env.from === "broker" || env.from.endsWith(":broker"))) {
      const ackBody = env.body as { type?: string; status?: string; target?: string } | null;
      if (ackBody && ackBody.type === "ack" && typeof ackBody.status === "string") {
        const slot = this.ackPending.get(env.re);
        if (slot) {
          clearTimeout(slot.timer);
          this.ackPending.delete(env.re);
          const status = ackBody.status as AckBody["status"];
          slot.resolve({ status, id: env.re, target: ackBody.target });
        }
        return;
      }
    }

    // Correlate replies for `request()`.
    if (env.re) {
      const slot = this.pending.get(env.re);
      if (slot) {
        clearTimeout(slot.timer);
        this.pending.delete(env.re);
        slot.resolve(env);
        return;
      }
    }

    // Otherwise dispatch to subscribers.
    for (const h of this.handlers) {
      try { h(env); } catch { /* handler errors don't break peer */ }
    }
  }

  private async _writeEnvelope(env: Envelope): Promise<void> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("session peer not connected");
    }
    this.socket.write(serialize(env));
  }

  private async _onSocketClose(closedSock: Socket): Promise<void> {
    if (this.leftFlag) return;  // intentional leave
    // Only the CURRENT socket dying is a real failover. A close from a socket
    // we've already replaced — `rename()` (teardown + rejoin) or a prior
    // reconnect — must NOT trigger another `_joinOrLead`, or we'd double-
    // register (the broker suffixes the second as `#N`) and leave an orphaned
    // still-open socket as a ghost peer. `this.socket` is null mid-rename
    // (teardown done, rejoin in flight) or already the new socket — either way
    // `!== closedSock`, so we skip. Genuine leader death: `this.socket` is still
    // the (now-closed) follower socket → identity matches → we re-elect.
    if (this.socket !== closedSock) return;
    // Attempt to re-elect once. New leader will bind sockPath; we either
    // become leader ourselves or rejoin as follower.
    await delay(FAILOVER_RETRY_MS);
    if (this.leftFlag || this.socket !== closedSock) return;
    try {
      await this._joinOrLead();
      // The new broker's peers map starts fresh — consumers must re-query
      // any cached state (peer count, etc.) that depended on the old broker.
      for (const h of this.reconnectHandlers) {
        try { h(); } catch { /* handler errors don't break peer */ }
      }
    } catch { /* election failed; peer stuck in disconnected state */ }
  }

  private async _teardownConn(): Promise<void> {
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ignored */ }
      this.socket = null;
    }
    if (this.broker) {
      try { await this.broker.close(); } catch { /* ignored */ }
      this.broker = null;
    }
    for (const slot of this.pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(new Error("peer leaving"));
    }
    this.pending.clear();
    for (const slot of this.ackPending.values()) {
      clearTimeout(slot.timer);
      slot.resolve({ status: "timeout", id: "" });
    }
    this.ackPending.clear();
  }
}
