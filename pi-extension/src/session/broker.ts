import type { Server, Socket } from "node:net";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type Envelope, parse, serialize, uuidv7, EnvelopeError } from "./envelope.js";
import { sanitizeSegment } from "./local_config.js";
import { isRuntimeIdentity, type RuntimeIdentity } from "./runtime_identity.js";

/**
 * Structured view of one mesh peer (plan/38). Current peers route canonically
 * through `identityAddress`; `address` is their cwd/name compatibility alias.
 * Legacy peers have only `address`. The remaining fields let clients group and
 * label peers without parsing route strings. `pc` is undefined locally.
 */
export interface PeerInfo {
  /** Cross-PC label; undefined for a local peer. */
  pc?: string;
  /** Working directory (realpath). Empty string for a legacy peer (no cwd). */
  cwd: string;
  /** Clean leaf name (carries a `#N` only on a same-(cwd,name) collision). */
  name: string;
  /** Backward-compatible cwd/name alias; canonical only for legacy peers. */
  address: string;
  /** Immutable canonical runtime identity fields (current peers only). */
  workspaceId?: string;
  agentId?: string;
  processEpoch?: string;
  /** Stable ID-keyed route; cwd/name `address` remains a presentation alias. */
  identityAddress?: string;
}

/**
 * The sole encoder of a cwd/name compatibility alias: `[<pc>:]<cwd>@<nome>`.
 *
 * - `cwd` present → `<cwd>@<nome>` (the `@` separates name from path so a `/`
 *   in the path never confuses lookup, which is exact-match anyway).
 * - `cwd` empty (legacy peer that sent no cwd) → `address == name`, preserving
 *   pre-plan/38 behavior so a mixed mesh keeps routing.
 * - `pc` present (cross-PC, Fase 2) → prefixed `<pc>:`.
 *
 * Does NOT sanitize — callers sanitize the `name` once (see `sanitizeMeshName`)
 * before composing, so an already-appended `#N` collision suffix survives.
 * Current clients prefer the broker-supplied immutable identity route; mixed
 * and legacy clients may still echo this alias verbatim.
 */
export function composeAddress(parts: { pc?: string; cwd: string; name: string }): string {
  const base = parts.cwd ? `${parts.cwd}@${parts.name}` : parts.name;
  return parts.pc ? `${parts.pc}:${base}` : base;
}

/**
 * Sanitize a requested mesh name to a safe leaf while PRESERVING a trailing
 * `#N` collision suffix (which the cwd-lock or a prior assignment may have
 * added — `sanitizeSegment` alone would mangle `#`→`-`). The base is run through
 * `sanitizeSegment` (af66d04); an unusable base (empty / reserved keyword) falls
 * back to `"agent"`.
 */
export function sanitizeMeshName(raw: string): string {
  const m = /^(.*?)(#\d+)?$/.exec(raw);
  const base = sanitizeSegment(m?.[1] ?? raw) ?? "agent";
  return m?.[2] ? base + m[2] : base;
}

/**
 * Broker hosted by the session leader. Accepts UDS connections, owns current
 * peers by immutable workspaceId+agentId, retains cwd/name compatibility
 * aliases, routes envelopes per `to`, and appends routed messages to audit.
 *
 * Auto-suffix on name collision: when a peer registers a name already taken,
 * the broker assigns `<name>#N` and returns it in the register ack.
 *
 * ## ACK protocol (plan/25 Wave 0; reliable delivery per plan/34)
 *
 * For **unicast non-broker** envelopes the broker synchronously emits an ACK
 * envelope back to the sender once it has delivered:
 *
 *   - target online → deliver envelope, ACK `received`
 *   - no such peer  → silent drop (sender times out)
 *
 * plan/34 removed the busy-drop: a message that arrives while the target is
 * mid-turn is **always delivered**, never dropped. The Pi harness
 * (`sendMessage(triggerTurn:true)`) enqueues mid-turn messages and processes
 * them in the upcoming turn, so the broker needs no busy gate or mailbox.
 * Consequently `busy` is no longer a possible ACK status for unicast new
 * work — the sender always gets `received`. (Turn-lifecycle / working
 * indicators live in `index.ts` via room_meta over the relay, not here.)
 *
 * Broadcast/multicast/broker-addressed envelopes are not ACKed (no single
 * authoritative recipient or no semantic match). The audit log carries the
 * ACK status (`received | denied | none`) per envelope.
 */
export interface BrokerOptions {
  server: Server;
  auditPath?: string;
  /** Optional callback invoked after each successful route (testing/observability). */
  onRouted?: (env: Envelope, deliveredTo: string[]) => void;
}

/**
 * Hook the broker calls before doing local routing, so cross-PC prefixes
 * (`<pc_label>:<peer_name>`) can be handed off to a remote forwarder
 * without baking transport knowledge into the broker. Wave C (plan/25)
 * wires `broker_remote.ts` here.
 */
export interface RemoteRouter {
  /**
   * Try to claim responsibility for routing this envelope cross-PC.
   * Returns true if claimed (broker MUST NOT also deliver locally). Returns
   * false if the envelope should fall through to local routing — e.g., the
   * prefix matches the local `pc_label`, the prefix is not a known remote
   * label (backward-compat for local names containing `:`), or there's no
   * prefix at all.
   */
  tryRouteOutbound(env: Envelope): boolean;
  /** Aggregated cross-PC primary routes for public `list_peers`. */
  listRemotePeers(): string[];
  /** Structured remote roster with prefixed identity route and compatibility
   *  alias metadata. Empty when nothing is known. */
  listRemotePeerInfos(): PeerInfo[];
}

/** Local outcome of a cross-PC envelope injection. broker_remote uses this
 *  to construct the ACK envelope it sends back via the relay. plan/34: `busy`
 *  is gone — injection always delivers when the peer exists. */
export type RemoteInjectStatus = "received" | "denied";

interface PeerConn {
  /** Presentation-only clean name. Current peers may share it. */
  name: string;
  /** Working directory used for presentation/alias metadata. */
  cwd: string;
  /** Cwd/name compatibility alias. Canonical only for a legacy registration. */
  address: string;
  /** Immutable identity; null for legacy registrations. */
  identity: RuntimeIdentity | null;
  socket: Socket;
  buf: string;
}

const BROKER_NAME = "broker";

function runtimeIdentityKey(identity: Pick<RuntimeIdentity, "workspaceId" | "agentId">): string {
  return `${identity.workspaceId.toLowerCase()}\0${identity.agentId.toLowerCase()}`;
}

function runtimeIdentityAddress(identity: Pick<RuntimeIdentity, "workspaceId" | "agentId">): string {
  return `~identity/${identity.workspaceId.toLowerCase()}/${identity.agentId.toLowerCase()}`;
}

function primaryRoute(peer: Pick<PeerConn, "identity" | "address">): string {
  return peer.identity ? runtimeIdentityAddress(peer.identity) : peer.address;
}

type AliasRoute =
  | { kind: "legacy"; peer: PeerConn }
  | { kind: "identity"; identityKey: string };

type AckStatus = "received" | "denied";

interface AckBody {
  type: "ack";
  status: "received" | "denied";
  target: string;
}

interface RegisterMsg {
  type: "register";
  name: string;
  /** Optional working directory — enables (cwd,name) take-over (see
   *  `_handleRegister`). Absent → legacy `#N`-on-collision behavior. */
  cwd?: string;
  /** Replace an existing same-(cwd,name) peer instead of suffixing `#N`.
   *  Used by stable identities such as supervised daemons and session
   *  replacement, where a second registration is the same logical agent. */
  takeover?: boolean;
  /** Current protocol: immutable canonical identity, separate from aliases. */
  identity?: RuntimeIdentity;
}

interface RegisterAck {
  type: "register_ack";
  /** Immutable identity route for current peers; cwd/name route for legacy. */
  address_assigned: string;
  /** Cwd/name compatibility alias when it differs from the primary route. */
  alias_address?: string;
  /** Presentation name actually assigned. */
  name_assigned: string;
}

interface SystemBody {
  type: "peer_joined" | "peer_left" | "peer_updated" | "list_peers_reply";
  /** Compatibility field carrying the peer's primary route, not display name. */
  name?: string;
  /** Primary immutable route for current peers; legacy route otherwise. */
  address?: string;
  /** Optional cwd/name compatibility alias for current peers. */
  alias_address?: string;
  /** Addresses (legacy clients route by these). */
  peers?: string[];
  /** Structured roster (plan/38) — clients group by `cwd`/`pc` without parsing. */
  peers_detailed?: PeerInfo[];
}

export class Broker {
  /** User-facing cwd/name aliases resolve through immutable identity keys. */
  private readonly routesByAlias = new Map<string, AliasRoute>();
  /** Canonical current-peer ownership and routing state. */
  private readonly peersByIdentity = new Map<string, PeerConn>();
  private readonly auditPath?: string;
  private readonly onRouted?: BrokerOptions["onRouted"];
  private readonly server: Server;
  /** Plan/25 Wave C: optional handoff for cross-PC routing. Null = local only. */
  private remoteRouter: RemoteRouter | null = null;

  constructor(opts: BrokerOptions) {
    this.server = opts.server;
    this.auditPath = opts.auditPath;
    this.onRouted = opts.onRouted;
    this.server.on("connection", (socket) => this._handleConnection(socket));
  }

  /** Attach (or detach with null) a cross-PC router. Idempotent. */
  setRemoteRouter(router: RemoteRouter | null): void {
    this.remoteRouter = router;
  }

  private _peerAt(route: string): PeerConn | undefined {
    if (route.startsWith("~identity/")) {
      const parts = route.split("/");
      if (parts.length !== 3) return undefined;
      return this.peersByIdentity.get(`${parts[1]!.toLowerCase()}\0${parts[2]!.toLowerCase()}`);
    }
    const alias = this.routesByAlias.get(route);
    if (!alias) return undefined;
    return alias.kind === "legacy" ? alias.peer : this.peersByIdentity.get(alias.identityKey);
  }

  private _allLocalPeers(): PeerConn[] {
    const peers = [...this.peersByIdentity.values()];
    for (const route of this.routesByAlias.values()) {
      if (route.kind === "legacy") peers.push(route.peer);
    }
    return peers;
  }

  /**
   * Plan/25 Wave C entry point: deliver an envelope that arrived from a
   * remote PC (via relay forward) into the local UDS mesh. Skips the
   * `force from = conn.name` rule (that defense is anti-spoof for local
   * peers; cross-PC has its own defense via the relay's verified `from_pc`).
   *
   * Returns the ACK status so the caller (broker_remote) can pack and
   * forward an ACK envelope back across the relay:
   *   - `received` — target exists, envelope delivered (plan/34: always
   *     delivered when the peer is online — the Pi harness enqueues mid-turn
   *     messages, so there is no busy-drop)
   *   - `denied` — no such local peer (or write failed) — caller maps to
   *     transport_error or denied ACK as it sees fit
   */
  injectFromRemote(env: Envelope): RemoteInjectStatus {
    if (typeof env.to !== "string" || env.to === "broadcast" || env.to === BROKER_NAME) {
      // Cross-PC is unicast-only at this protocol layer.
      return "denied";
    }
    const targetName = env.to;
    const peer = this._peerAt(targetName);
    if (!peer) return "denied";

    const line = serialize(env);
    try {
      peer.socket.write(line);
    } catch {
      return "denied";
    }
    void this._appendAudit(env, [targetName], "received", "relay");
    this.onRouted?.(env, [targetName]);
    return "received";
  }

  /** Primary routes currently registered. Current peers are ID-first. */
  peerNames(): string[] {
    return this._allLocalPeers().map((peer) => primaryRoute(peer));
  }

  async close(): Promise<void> {
    for (const p of this._allLocalPeers()) p.socket.destroy();
    this.routesByAlias.clear();
    this.peersByIdentity.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ── connection lifecycle ──────────────────────────────────────────────────

  private _handleConnection(socket: Socket): void {
    const conn: PeerConn = { name: "", cwd: "", address: "", identity: null, socket, buf: "" };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this._onData(conn, chunk));
    socket.on("close", () => this._onClose(conn));
    socket.on("error", () => { /* ignored — close will follow */ });
  }

  private _onData(conn: PeerConn, chunk: string): void {
    conn.buf += chunk;
    let nl: number;
    while ((nl = conn.buf.indexOf("\n")) >= 0) {
      const line = conn.buf.slice(0, nl);
      conn.buf = conn.buf.slice(nl + 1);
      if (!line) continue;
      void this._handleLine(conn, line);
    }
  }

  private async _handleLine(conn: PeerConn, line: string): Promise<void> {
    // Unregistered conn: a read-only `list_peers` probe (the `remote-pi peers`
    // CLI — answered without registering, so it leaves no trace on the mesh) or
    // the mandatory `register` handshake. Anything else `_handleRegister` drops.
    if (!conn.name) {
      if (this._tryObserverProbe(conn, line)) return;
      this._handleRegister(conn, line);
      return;
    }
    // Already registered — must be a regular envelope.
    let env: Envelope;
    try {
      env = parse(line);
    } catch (e) {
      if (e instanceof EnvelopeError) return;  // malformed; drop silently
      throw e;
    }
    // Force `from` to the broker-owned primary route (security: no spoofing).
    // Current peers therefore expose immutable IDs in ordinary send/reply;
    // legacy peers retain their historical cwd/name route.
    env.from = primaryRoute(conn);
    await this._route(env);
  }

  private _handleRegister(conn: PeerConn, line: string): void {
    let req: RegisterMsg;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as { type?: unknown }).type !== "register" ||
        typeof (parsed as { name?: unknown }).name !== "string"
      ) {
        conn.socket.destroy();
        return;
      }
      req = parsed as RegisterMsg;
    } catch {
      conn.socket.destroy();
      return;
    }

    // Current peers prove uniqueness with immutable workspaceId+agentId. The
    // process epoch is correlation/fencing metadata, never a license to evict
    // an already-live canonical owner: without an external authority ordering
    // epochs, duplicate registrations fail closed.
    if (req.identity !== undefined && !isRuntimeIdentity(req.identity)) {
      try { conn.socket.write(JSON.stringify({ type: "register_rejected", code: "invalid_identity" }) + "\n"); } catch { /* peer hung up */ }
      conn.socket.end();
      return;
    }
    conn.identity = req.identity ?? null;
    const requestedCwd = typeof req.cwd === "string" ? req.cwd : "";
    if (conn.identity) {
      const key = runtimeIdentityKey(conn.identity);
      if (this.peersByIdentity.has(key)) {
        try { conn.socket.write(JSON.stringify({ type: "register_rejected", code: "duplicate_identity" }) + "\n"); } catch { /* peer hung up */ }
        conn.socket.end();
        return;
      }
      // Multiple logical agents may share one workspace only while they agree
      // on its live location. A copied protected config presenting the same
      // workspaceId from another cwd fails closed until every old owner leaves;
      // after that, ordinary workspace relocation is accepted.
      const workspaceId = conn.identity.workspaceId.toLowerCase();
      const inconsistentOwner = [...this.peersByIdentity.values()].find((peer) =>
        peer.identity?.workspaceId.toLowerCase() === workspaceId && peer.cwd !== requestedCwd,
      );
      if (inconsistentOwner) {
        try { conn.socket.write(JSON.stringify({ type: "register_rejected", code: "workspace_cwd_conflict" }) + "\n"); } catch { /* peer hung up */ }
        conn.socket.end();
        return;
      }
    }

    // Cwd/name remains a routable presentation alias for old tools and mixed
    // meshes, but no longer owns current-peer identity. Alias collisions may
    // add #N while both peers retain the same display name.
    conn.cwd = requestedCwd;
    const requestedDisplayName = sanitizeMeshName(req.name);
    const { name: runtimeAlias, address } = this._identityForRegister(conn.cwd, req.name, conn.identity ? false : req.takeover === true);
    conn.name = conn.identity ? requestedDisplayName : runtimeAlias;
    conn.address = address;
    if (conn.identity) {
      const identityKey = runtimeIdentityKey(conn.identity);
      this.peersByIdentity.set(identityKey, conn);
      this.routesByAlias.set(address, { kind: "identity", identityKey });
    } else {
      this.routesByAlias.set(address, { kind: "legacy", peer: conn });
    }

    const route = primaryRoute(conn);
    const ack: RegisterAck = {
      type: "register_ack",
      address_assigned: route,
      name_assigned: conn.name,
      ...(route !== address ? { alias_address: address } : {}),
    };
    try {
      conn.socket.write(JSON.stringify(ack) + "\n");
    } catch { /* peer hung up */ }

    this._broadcastSystem({
      type: "peer_joined",
      name: route,
      address: route,
      ...(route !== address ? { alias_address: address } : {}),
    }, route);
  }

  /**
   * Answer a read-only `list_peers` request from an UNREGISTERED connection
   * (the `remote-pi peers` CLI probe). Returns true when the line was such a
   * probe — the reply is written and the connection stays unregistered: no
   * name assigned, no `peer_joined`/`peer_left` broadcast, no sibling push, so
   * querying the roster from the shell never perturbs the mesh. Returns false
   * (not a probe) so the caller falls through to the register handshake.
   */
  private _tryObserverProbe(conn: PeerConn, line: string): boolean {
    let parsed: { type?: unknown };
    try {
      parsed = JSON.parse(line) as { type?: unknown };
    } catch {
      return false;  // not JSON → let _handleRegister destroy it
    }
    if (!parsed || typeof parsed !== "object" || parsed.type !== "list_peers") {
      return false;
    }
    const reply: Envelope = {
      from: BROKER_NAME,
      to: "observer",  // synthetic: the conn has no registered name
      id: uuidv7(),
      re: null,
      body: {
        type: "list_peers_reply",
        peers: this._allPeerNames(),
        peers_detailed: this._allPeerInfos(),
      } as SystemBody,
    };
    try { conn.socket.write(serialize(reply)); } catch { /* probe hung up */ }
    return true;
  }

  /** Local primary routes plus cross-PC primary routes from the remote router. */
  private _allPeerNames(): string[] {
    const remote = this.remoteRouter ? this.remoteRouter.listRemotePeers() : [];
    return [...this.peerNames(), ...remote];
  }

  /** Structured roster of LOCAL UDS peers (plan/38): one `PeerInfo` each, no
   *  `pc` (they're on this machine). Public so the cross-PC router
   *  (`broker_remote`) can read the authoritative local inventory directly to
   *  push to siblings — no `list_peers` round-trip, no stale cache. */
  localPeerInfos(): PeerInfo[] {
    return this._allLocalPeers().map((p) => ({
      cwd: p.cwd,
      name: p.name,
      address: p.address,
      ...(p.identity ? {
        workspaceId: p.identity.workspaceId,
        agentId: p.identity.agentId,
        processEpoch: p.identity.processEpoch,
        identityAddress: primaryRoute(p),
      } : {}),
    }));
  }

  /** Structured roster (plan/38): local peers (no `pc`) + cross-PC peers with
   *  `pc`/`cwd`/`name` filled by the remote router (Fase 2). */
  private _allPeerInfos(): PeerInfo[] {
    const remote = this.remoteRouter?.listRemotePeerInfos() ?? [];
    return [...this.localPeerInfos(), ...remote];
  }

  /**
   * Resolve a free `(name, address)` for a register, keyed by **(cwd, name)**
   * (plan/38): the collision check is on the composed ADDRESS, so a name only
   * collides with another peer in the SAME cwd. `#N` is appended to this legacy
   * compatibility alias until the address is free; current peer ownership and
   * process locking remain keyed by immutable IDs. For a legacy peer (cwd "")
   * the address is the name, preserving global-name `#N`.
   */
  private _identityForRegister(cwd: string, requested: string, takeover: boolean): { name: string; address: string } {
    const sanitized = sanitizeMeshName(requested);
    let address = composeAddress({ cwd, name: sanitized });
    const existingAtAlias = this._peerAt(address);
    if (takeover && cwd && existingAtAlias && !existingAtAlias.identity) {
      this._dropPeerAt(address);
      return { name: sanitized, address };
    }
    if (!this.routesByAlias.has(address)) return { name: sanitized, address };
    // Collision: strip any client-provided `#N`, then re-suffix from #2.
    const base = sanitized.replace(/#\d+$/, "");
    for (let n = 2; n < 1000; n++) {
      const name = `${base}#${n}`;
      address = composeAddress({ cwd, name });
      if (!this.routesByAlias.has(address)) return { name, address };
    }
    throw new Error(`name space exhausted for ${base} in ${cwd || "(no cwd)"}`);
  }

  private _dropPeerAt(address: string): void {
    const existing = this._peerAt(address);
    if (!existing) return;
    this.routesByAlias.delete(address);
    if (existing.identity) {
      const key = runtimeIdentityKey(existing.identity);
      if (this.peersByIdentity.get(key) === existing) this.peersByIdentity.delete(key);
    }
    // The old socket's close event may arrive after the replacement has been
    // inserted. Clear its address so it cannot delete the replacement.
    existing.address = "";
    try { existing.socket.destroy(); } catch { /* ignored */ }
  }

  private _onClose(conn: PeerConn): void {
    if (!conn.address) return;
    if (conn.identity) {
      const key = runtimeIdentityKey(conn.identity);
      if (this.peersByIdentity.get(key) !== conn) return;
      this.peersByIdentity.delete(key);
      const route = this.routesByAlias.get(conn.address);
      if (route?.kind === "identity" && route.identityKey === key) this.routesByAlias.delete(conn.address);
    } else {
      const route = this.routesByAlias.get(conn.address);
      if (route?.kind !== "legacy" || route.peer !== conn) return;
      this.routesByAlias.delete(conn.address);
    }
    const route = primaryRoute(conn);
    this._broadcastSystem({
      type: "peer_left",
      name: route,
      address: route,
      ...(route !== conn.address ? { alias_address: conn.address } : {}),
    }, route);
  }

  // ── routing ───────────────────────────────────────────────────────────────

  private async _route(env: Envelope): Promise<void> {
    // Special handling for messages addressed to the broker itself.
    if (env.to === BROKER_NAME) {
      this._handleBrokerMessage(env);
      return;
    }

    // Plan/25 Wave C: give the cross-PC router a chance to claim this
    // envelope. It returns true when the `to` field carries a known remote
    // prefix and the envelope was packed onto the relay; on miss it falls
    // through so locally-named peers (including ones with literal `:` in
    // their names) still work.
    if (this.remoteRouter && typeof env.to === "string") {
      if (this.remoteRouter.tryRouteOutbound(env)) return;
    }

    const targets = this._resolveTargets(env);
    const delivered: string[] = [];
    const line = serialize(env);
    const isUnicast = typeof env.to === "string" && env.to !== "broadcast";

    // plan/34: reliable delivery — always write to the target's socket. The
    // Pi harness enqueues messages that arrive mid-turn, so there is no
    // busy-drop and `busy` is no longer a possible ACK status. Unicast sends
    // to an online peer always ACK `received`.
    let ackStatus: AckStatus | "none" = "none";
    const sender = this._peerAt(env.from);
    for (const targetName of targets) {
      const peer = this._peerAt(targetName);
      if (!peer || peer === sender) continue;  // unknown/self target: silent drop

      try {
        peer.socket.write(line);
        const deliveredRoute = primaryRoute(peer);
        delivered.push(deliveredRoute);
        if (isUnicast) {
          ackStatus = "received";
          this._sendAckToSender(env, "received", deliveredRoute);
        }
      } catch {
        // peer dropped mid-write — close handler will fire; treat as silent
      }
    }

    if (this.auditPath) await this._appendAudit(env, delivered, ackStatus);
    this.onRouted?.(env, delivered);
  }

  private _resolveTargets(env: Envelope): string[] {
    if (env.to === "broadcast") {
      // plan/38 decision C: broadcast is scoped to the sender's cwd (folder
      // colleagues), local-only. A peer in /a/b never hears /a/c. The sender is
      // resolved from the broker-forced primary `env.from`; legacy peers (cwd
      // "") still broadcast among other cwd-less peers.
      const sender = this._peerAt(env.from);
      const scope = sender?.cwd ?? "";
      return this._allLocalPeers()
        .filter((p) => p !== sender && p.cwd === scope)
        .map((p) => primaryRoute(p));
    }
    if (Array.isArray(env.to)) {
      return env.to.filter((n) => n !== env.from);
    }
    // Unicast: drop self-loops too. The skill warns "useless" but the LLM
    // might still try (especially with deceiving `re` reply chains). A
    // self-loop has no upside and risks unbounded message ↔ inject ↔ message
    // cycles when the inbound injector tells the LLM "reply with re=…".
    if (env.to === env.from) return [];
    return [env.to];
  }

  /**
   * Writes an ACK envelope to the original sender's socket. Synchronous —
   * the caller is inside `_route` and must keep busy-check/busy-set atomic.
   * Broker → sender: `from="broker"`, `to=env.from`, `re=env.id`,
   * `body={type:"ack", status, target}`.
   */
  private _sendAckToSender(env: Envelope, status: AckStatus, target: string): void {
    const sender = this._peerAt(env.from);
    if (!sender) return;  // sender vanished mid-write
    const body: AckBody = { type: "ack", status, target };
    const ackEnv: Envelope = {
      from: BROKER_NAME,
      to: env.from,
      id: uuidv7(),
      re: env.id,
      body,
    };
    try {
      sender.socket.write(serialize(ackEnv));
    } catch { /* sender dropped; close handler will fire */ }
  }

  private _handleBrokerMessage(env: Envelope): void {
    const body = env.body as { type?: string; peers?: unknown; name?: unknown } | null;
    if (!body || typeof body !== "object") return;
    if (body.type === "update_presentation") {
      const peer = this._peerAt(env.from);
      // Presentation mutation exists only for current ID-keyed peers. Legacy
      // clients keep their historical soft-rejoin rename behavior.
      if (!peer?.identity || typeof body.name !== "string") return;
      const name = sanitizeMeshName(body.name);
      peer.name = name;
      const reply: Envelope = {
        from: BROKER_NAME,
        to: env.from,
        id: uuidv7(),
        re: env.id,
        body: {
          type: "presentation_updated",
          name,
          address: primaryRoute(peer),
          alias_address: peer.address,
        },
      };
      try { peer.socket.write(serialize(reply)); } catch { /* peer hung up */ }
      const route = primaryRoute(peer);
      this._broadcastSystem({
        type: "peer_updated",
        name: route,
        address: route,
        alias_address: peer.address,
      }, route);
      return;
    }
    if (body.type === "list_peers") {
      const reply: Envelope = {
        from: BROKER_NAME,
        to: env.from,
        id: uuidv7(),
        re: env.id,
        body: {
          type: "list_peers_reply",
          peers: this._allPeerNames(),          // ID-first primary routes
          peers_detailed: this._allPeerInfos(), // aliases + typed identity metadata
        } as SystemBody,
      };
      const peer = this._peerAt(env.from);
      if (peer) {
        try { peer.socket.write(serialize(reply)); } catch { /* ignored */ }
      }
      return;
    }
    // plan/34: `turn_state` is no longer consumed — the broker doesn't gate
    // delivery on busy state. The Pi extension still publishes working state
    // as room_meta over the relay (index.ts), independent of the broker.
  }

  private _broadcastSystem(body: SystemBody, excludeRoute: string): void {
    for (const peer of this._allLocalPeers()) {
      const route = primaryRoute(peer);
      if (route === excludeRoute) continue;
      const env: Envelope = {
        from: BROKER_NAME,
        to: route,
        id: uuidv7(),
        re: null,
        body,
      };
      try {
        peer.socket.write(serialize(env));
      } catch { /* ignored */ }
    }
  }

  private async _appendAudit(
    env: Envelope,
    delivered: string[],
    ackStatus: AckStatus | "none",
    /**
     * Plan/25 Wave D: provenance hint for the audit reader. `"relay"` marks
     * envelopes injected via `injectFromRemote` (cross-PC). Local UDS
     * delivery keeps the default `"uds"` so existing audit consumers see
     * a uniform field rather than an undefined hole.
     */
    via: "uds" | "relay" = "uds",
  ): Promise<void> {
    if (!this.auditPath) return;
    const line = JSON.stringify({
      ts: Date.now(),
      from: env.from,
      to: env.to,
      id: env.id,
      re: env.re,
      delivered,
      ack_status: ackStatus,
      via,
    }) + "\n";
    try {
      await mkdir(dirname(this.auditPath), { recursive: true });
      await appendFile(this.auditPath, line, "utf8");
    } catch { /* audit best-effort */ }
  }
}
