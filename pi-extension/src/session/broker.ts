import type { Server, Socket } from "node:net";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type Envelope, parse, serialize, uuidv7, EnvelopeError } from "./envelope.js";
import { sanitizeSegment } from "./local_config.js";
import { isRuntimeIdentity, type RuntimeIdentity } from "./runtime_identity.js";
import {
  RelayExposureLeaseAuthority,
  type ParentDelegationOptions,
  type RelayExposureBinding,
  type RelayExposureLease,
} from "./relay_exposure_lease.js";
import {
  parseRelayExposureActivationBrokerRequest,
  parseRelayExposureCloseBrokerRequest,
  parseRelayExposureIssueBrokerRequest,
  parseRelayExposurePromoteBrokerRequest,
  parseRelayExposureRenewBrokerRequest,
  parseRelayExposureRevokeBrokerRequest,
} from "./relay_exposure_rpc.js";
import {
  parseRelayRunnerDelegateRequest,
  parseRelayRunnerRequest,
  type RelayRunnerRequest,
} from "./relay_runner_rpc.js";

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
  /** Unregistered runner IPC is exactly one request and never becomes a peer. */
  oneShotComplete: boolean;
}

const BROKER_NAME = "broker";
const RUNNER_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNNER_REQUEST_TYPES = new Set([
  "relay_runner_issue",
  "relay_runner_renew",
  "relay_runner_revoke",
  "relay_runner_close",
  "relay_runner_release",
]);

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
  /** Broker-memory authority: restart loses every grant/lease and fails closed. */
  private readonly relayExposureLeases = new RelayExposureLeaseAuthority();
  private readonly relayExposureExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Plan/25 Wave C: optional handoff for cross-PC routing. Null = local only. */
  private remoteRouter: RemoteRouter | null = null;

  constructor(opts: BrokerOptions) {
    this.server = opts.server;
    this.auditPath = opts.auditPath;
    this.onRouted = opts.onRouted;
    this.server.on("connection", (socket) => this._handleConnection(socket));
    this.server.on("close", () => {
      for (const timer of this.relayExposureExpiryTimers.values()) clearTimeout(timer);
      this.relayExposureExpiryTimers.clear();
    });
  }

  /** Attach (or detach with null) a cross-PC router. Idempotent. */
  setRemoteRouter(router: RemoteRouter | null): void {
    this.remoteRouter = router;
  }

  /**
   * Privileged, broker-leader-local operator seam. This deliberately has no
   * wire message equivalent: it resolves a displayed route to the actual live
   * connection object, then delegates that exact object in broker memory.
   */
  authorizeRelayParent(
    route: string,
    options: ParentDelegationOptions = {},
    policyWorkspaceId?: string,
  ): { ok: true; parent: RuntimeIdentity } | { ok: false; reason: "peer_not_found" | "legacy_peer" | "workspace_mismatch" } {
    const peer = this._peerAt(route);
    if (!peer) return { ok: false, reason: "peer_not_found" };
    if (!peer.identity) return { ok: false, reason: "legacy_peer" };
    if (policyWorkspaceId && peer.identity.workspaceId.toLowerCase() !== policyWorkspaceId.toLowerCase()) {
      return { ok: false, reason: "workspace_mismatch" };
    }
    this.relayExposureLeases.authorizeParent(peer, peer.identity, options);
    return { ok: true, parent: { ...peer.identity } };
  }

  /** Privileged leader-local withdrawal for one exact displayed parent route. */
  deauthorizeRelayParent(
    route: string,
  ): { ok: true; parent: RuntimeIdentity } | { ok: false; reason: "peer_not_found" | "legacy_peer" } {
    const peer = this._peerAt(route);
    if (!peer) return { ok: false, reason: "peer_not_found" };
    if (!peer.identity) return { ok: false, reason: "legacy_peer" };
    this.relayExposureLeases.revokeParent(peer, "parent_revoked");
    this._reconcileRelayExposureTransitions();
    return { ok: true, parent: { ...peer.identity } };
  }

  /** Privileged policy withdrawal for every delegated parent in one workspace. */
  deauthorizeRelayWorkspace(workspaceId: string): { ok: true; revokedParents: number } {
    const revokedParents = this.relayExposureLeases.revokeWorkspace(workspaceId, "parent_revoked");
    this._reconcileRelayExposureTransitions();
    return { ok: true, revokedParents };
  }

  private _scheduleRelayExposureExpiry(lease: RelayExposureLease): void {
    const leaseId = lease.relayExposureLeaseId;
    const existing = this.relayExposureExpiryTimers.get(leaseId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      // A cleared timer can already be queued. Never let a stale callback
      // delete/reconcile the replacement timer installed by renewal.
      if (this.relayExposureExpiryTimers.get(leaseId) !== timer) return;
      this.relayExposureExpiryTimers.delete(leaseId);
      this.relayExposureLeases.expireDue();
      this._reconcileRelayExposureTransitions();
    }, Math.max(0, lease.expiresAt - Date.now()));
    timer.unref?.();
    this.relayExposureExpiryTimers.set(leaseId, timer);
  }

  private _sendRelayExposurePromoted(child: PeerConn, lease: RelayExposureLease): void {
    if (!child.address) return;
    const notice: Envelope = {
      from: BROKER_NAME,
      to: primaryRoute(child),
      id: uuidv7(),
      re: null,
      body: { type: "relay_lease_promoted", version: 1, lease },
    };
    try { child.socket.write(serialize(notice)); } catch { /* child hung up */ }
  }

  private _reconcileRelayExposureTransitions(): void {
    for (const renewal of this.relayExposureLeases.drainRenewals()) {
      const child = renewal.childConnection as PeerConn;
      if (!child.address) continue;
      const route = primaryRoute(child);
      const notice: Envelope = {
        from: BROKER_NAME,
        to: route,
        id: uuidv7(),
        re: null,
        body: {
          type: "relay_lease_renewed",
          version: 1,
          relayExposureLeaseId: renewal.lease.relayExposureLeaseId,
          binding: renewal.lease.binding,
          expiresAt: renewal.lease.expiresAt,
        },
      };
      try { child.socket.write(serialize(notice)); } catch { /* child hung up */ }
    }
    for (const transition of this.relayExposureLeases.drainTransitions()) {
      const leaseId = transition.lease.relayExposureLeaseId;
      const timer = this.relayExposureExpiryTimers.get(leaseId);
      if (timer) clearTimeout(timer);
      this.relayExposureExpiryTimers.delete(leaseId);
      const child = transition.childConnection as PeerConn | undefined;
      if (!child?.address) continue;
      const route = primaryRoute(child);
      const notice: Envelope = {
        from: BROKER_NAME,
        to: route,
        id: uuidv7(),
        re: null,
        body: {
          type: "relay_lease_closed",
          version: 1,
          relayExposureLeaseId: leaseId,
          binding: transition.lease.binding,
          reason: transition.reason,
          ...(transition.closeReason ? { closeReason: transition.closeReason } : {}),
        },
      };
      try { child.socket.write(serialize(notice)); } catch { /* child hung up */ }
    }
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
    const conn: PeerConn = { name: "", cwd: "", address: "", identity: null, socket, buf: "", oneShotComplete: false };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this._onData(conn, chunk));
    socket.on("close", () => this._onClose(conn));
    socket.on("error", () => { /* ignored — close will follow */ });
  }

  private _onData(conn: PeerConn, chunk: string): void {
    if (conn.oneShotComplete) return;
    conn.buf += chunk;
    let nl: number;
    while ((nl = conn.buf.indexOf("\n")) >= 0) {
      const line = conn.buf.slice(0, nl);
      conn.buf = conn.buf.slice(nl + 1);
      if (!line) continue;
      void this._handleLine(conn, line);
      if (conn.oneShotComplete) {
        conn.buf = "";
        break;
      }
    }
  }

  private async _handleLine(conn: PeerConn, line: string): Promise<void> {
    if (conn.oneShotComplete) return;
    // Unregistered conn: a read-only `list_peers` probe (the `remote-pi peers`
    // CLI — answered without registering, so it leaves no trace on the mesh) or
    // the mandatory `register` handshake. Anything else `_handleRegister` drops.
    if (!conn.name) {
      if (this._tryObserverProbe(conn, line)) return;
      if (this._tryRelayRunnerRequest(conn, line)) return;
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
    await this._route(env, conn);
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

  /**
   * Consume one strict runner lifecycle request without mesh registration.
   * The opaque token is parsed only in memory and is never used as a route,
   * identity, audit field, or log field. Recognized malformed requests receive
   * only a correlation UUID and `invalid_request`; all sockets end after one
   * reply so they cannot change protocol roles.
   */
  private _tryRelayRunnerRequest(conn: PeerConn, line: string): boolean {
    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      raw = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    if (typeof raw.type !== "string" || !RUNNER_REQUEST_TYPES.has(raw.type)) return false;

    conn.oneShotComplete = true;
    const requestId = typeof raw.requestId === "string" && RUNNER_REQUEST_ID_PATTERN.test(raw.requestId)
      ? raw.requestId
      : undefined;
    const request = parseRelayRunnerRequest(raw);
    if (!request || !requestId) {
      if (requestId) {
        conn.socket.end(JSON.stringify({
          type: "relay_runner_result",
          version: 1,
          requestId,
          ok: false,
          reason: "invalid_request",
        }) + "\n");
      } else {
        conn.socket.end();
      }
      return true;
    }

    const result = this._applyRelayRunnerRequest(request);
    conn.socket.end(JSON.stringify({
      type: "relay_runner_result",
      version: 1,
      requestId: request.requestId,
      ...result,
    }) + "\n");
    if (request.type === "relay_runner_renew" && result.ok && result.state === "renewed") {
      this._scheduleRelayExposureExpiry(result.lease);
    }
    this._reconcileRelayExposureTransitions();
    return true;
  }

  private _applyRelayRunnerRequest(request: RelayRunnerRequest):
    | (ReturnType<RelayExposureLeaseAuthority["issueForRunner"]> & { state?: "issued" })
    | ReturnType<RelayExposureLeaseAuthority["renewForRunner"]>
    | ReturnType<RelayExposureLeaseAuthority["revokeForRunner"]>
    | ReturnType<RelayExposureLeaseAuthority["closeForRunner"]>
    | ReturnType<RelayExposureLeaseAuthority["releaseRunner"]> {
    switch (request.type) {
      case "relay_runner_issue": {
        const issued = this.relayExposureLeases.issueForRunner(request.token, request.binding, {
          ttlMs: request.ttlMs,
          intentSource: request.intentSource,
        });
        return issued.ok ? { ...issued, state: "issued" } : issued;
      }
      case "relay_runner_renew":
        return this.relayExposureLeases.renewForRunner(
          request.token,
          request.relayExposureLeaseId,
          request.binding,
          { ttlMs: request.ttlMs, renewalId: request.renewalId },
        );
      case "relay_runner_revoke":
        return this.relayExposureLeases.revokeForRunner(
          request.token,
          request.relayExposureLeaseId,
          request.binding,
        );
      case "relay_runner_close":
        return this.relayExposureLeases.closeForRunner(
          request.token,
          request.relayExposureLeaseId,
          request.binding,
          request.reason,
        );
      case "relay_runner_release":
        return this.relayExposureLeases.releaseRunner(request.token);
    }
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
    // A connection may be a delegated parent, an active child, or both. Revoke
    // and reconcile by exact object identity before roster ownership moves.
    this.relayExposureLeases.revokeParent(conn);
    this.relayExposureLeases.disconnectChild(conn);
    this._reconcileRelayExposureTransitions();
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

  private async _route(env: Envelope, senderConnection: PeerConn): Promise<void> {
    // Special handling for messages addressed to the broker itself. Pass the
    // actual socket-owned connection object so lease authority never depends
    // on re-resolving self-assertable route metadata.
    if (env.to === BROKER_NAME) {
      this._handleBrokerMessage(env, senderConnection);
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

  private _handleBrokerMessage(env: Envelope, peer: PeerConn): void {
    const body = env.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    if (body["type"] === "relay_parent_deauthorize") {
      if (Object.keys(body).length !== 1) {
        this._sendBrokerReply(peer, env, { type: "relay_parent_deauthorize_result", ok: false, reason: "invalid_request" });
        return;
      }
      this.relayExposureLeases.revokeParent(peer, "parent_revoked");
      this._sendBrokerReply(peer, env, { type: "relay_parent_deauthorize_result", ok: true });
      this._reconcileRelayExposureTransitions();
      return;
    }
    if (body["type"] === "relay_policy_withdraw") {
      if (Object.keys(body).length !== 1 || !peer.identity) {
        this._sendBrokerReply(peer, env, { type: "relay_policy_withdraw_result", ok: false, reason: "invalid_request" });
        return;
      }
      const revokedParents = this.relayExposureLeases.revokeWorkspace(peer.identity.workspaceId, "parent_revoked");
      this._sendBrokerReply(peer, env, { type: "relay_policy_withdraw_result", ok: true, revokedParents });
      this._reconcileRelayExposureTransitions();
      return;
    }
    if (body["type"] === "relay_runner_delegate") {
      const request = parseRelayRunnerDelegateRequest(body);
      const result = request
        ? this.relayExposureLeases.delegateRunner(peer, request)
        : { ok: false as const, reason: "invalid_request" as const };
      this._sendBrokerReply(peer, env, { type: "relay_runner_delegate_result", version: 1, ...result });
      this._reconcileRelayExposureTransitions();
      return;
    }
    if (body["type"] === "relay_lease_promote") {
      const request = parseRelayExposurePromoteBrokerRequest(body);
      let target: PeerConn | undefined;
      let result: ReturnType<RelayExposureLeaseAuthority["promote"]> | { ok: false; reason: "invalid_request" | "target_not_found" | "target_epoch_mismatch" };
      if (!request) {
        result = { ok: false, reason: "invalid_request" };
      } else {
        target = this.peersByIdentity.get(runtimeIdentityKey(request.binding));
        if (!target?.identity) {
          result = { ok: false, reason: "target_not_found" };
        } else if (target.identity.processEpoch.toLowerCase() !== request.binding.processEpoch.toLowerCase()) {
          result = { ok: false, reason: "target_epoch_mismatch" };
        } else {
          result = this.relayExposureLeases.promote(peer, request.binding, target, { ttlMs: request.ttlMs });
        }
      }
      this._sendBrokerReply(peer, env, { type: "relay_lease_promote_result", ...result });
      if (result.ok && result.state === "promoted" && target) {
        this._scheduleRelayExposureExpiry(result.lease);
        this._sendRelayExposurePromoted(target, result.lease);
      }
      this._reconcileRelayExposureTransitions();
      return;
    }
    if (body["type"] === "relay_lease_issue") {
      const request = parseRelayExposureIssueBrokerRequest(body);
      const result = request
        ? this.relayExposureLeases.issue(peer, request.binding, { ttlMs: request.ttlMs })
        : { ok: false as const, reason: "invalid_binding" as const };
      this._sendBrokerReply(peer, env, { type: "relay_lease_issue_result", ...result });
      this._reconcileRelayExposureTransitions();
      return;
    }
    if (body["type"] === "relay_lease_activate") {
      const request = parseRelayExposureActivationBrokerRequest(body);
      let binding: RelayExposureBinding | undefined;
      if (peer.identity && request) {
        binding = {
          runId: request.runId,
          workspaceId: peer.identity.workspaceId,
          agentId: peer.identity.agentId,
          processEpoch: peer.identity.processEpoch,
          mode: "relay",
        };
      }
      const result = binding && request
        ? this.relayExposureLeases.activate(request.capability, binding, peer)
        : { ok: false as const, reason: "forged_capability" as const };
      this._sendBrokerReply(peer, env, { type: "relay_lease_activate_result", ...result });
      if (result.ok) this._scheduleRelayExposureExpiry(result.lease);
      this._reconcileRelayExposureTransitions();
      return;
    }
    if (body["type"] === "relay_lease_renew") {
      const request = parseRelayExposureRenewBrokerRequest(body);
      const result = request
        ? this.relayExposureLeases.renew(peer, request.relayExposureLeaseId, request.binding, {
            ttlMs: request.ttlMs,
            renewalId: request.renewalId,
          })
        : { ok: false as const, reason: "invalid_request" as const };
      this._sendBrokerReply(peer, env, { type: "relay_lease_renew_result", ...result });
      // An idempotent reply may be an older A receipt replayed after a newer
      // B renewal. Only a state-changing renewal owns expiry rescheduling.
      if (result.ok && result.state === "renewed") this._scheduleRelayExposureExpiry(result.lease);
      this._reconcileRelayExposureTransitions();
      return;
    }
    if (body["type"] === "relay_lease_revoke") {
      const request = parseRelayExposureRevokeBrokerRequest(body);
      const result = request
        ? this.relayExposureLeases.revoke(peer, request.relayExposureLeaseId, request.binding)
        : { ok: false as const, reason: "invalid_request" as const };
      this._sendBrokerReply(peer, env, { type: "relay_lease_revoke_result", ...result });
      this._reconcileRelayExposureTransitions();
      return;
    }
    if (body["type"] === "relay_lease_close") {
      const request = parseRelayExposureCloseBrokerRequest(body);
      let result = request
        ? this.relayExposureLeases.close(
            peer,
            request.relayExposureLeaseId,
            request.binding,
            request.reason,
          )
        : { ok: false as const, reason: "invalid_request" as const };
      // The same strict close shape is valid from either exact live endpoint:
      // children reconcile apply failure/exit, while delegated parents reconcile
      // ordinary completion and shutdown. Never fall back after a child-bound
      // result; only a non-child connection may be considered as the parent.
      if (request && !result.ok && result.reason === "stale_child_connection") {
        result = this.relayExposureLeases.closeByParent(
          peer,
          request.relayExposureLeaseId,
          request.binding,
          request.reason,
        );
      }
      this._sendBrokerReply(peer, env, { type: "relay_lease_close_result", ...result });
      this._reconcileRelayExposureTransitions();
      return;
    }
    // No wire-level parent-authorization operation exists. Unknown messages,
    // including a forged `relay_parent_authorize`, are intentionally ignored.
    if (body.type === "update_presentation") {
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

  private _sendBrokerReply(peer: PeerConn, request: Envelope, body: unknown): void {
    const reply: Envelope = {
      from: BROKER_NAME,
      to: request.from,
      id: uuidv7(),
      re: request.id,
      body,
    };
    try { peer.socket.write(serialize(reply)); } catch { /* peer hung up */ }
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
