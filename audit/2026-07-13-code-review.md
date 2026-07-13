# Remote Pi — pi-extension code review

**Date:** 2026-07-13
**Commit reviewed:** v0.5.5 (`6cc2f28`)
**Scope:** `pi-extension/src` (~18k LoC of source), reviewed across four subsystems — command surface (`index.ts`), session/mesh lifecycle (`session/`), daemon/cron (`daemon/`), and crypto/transport/pairing (`mesh/`, `pairing/`, `transport/`, `mcp/`, `protocol/`).

**Baseline gates:** `pnpm typecheck` (`tsc --noEmit`) clean; `pnpm vitest run` — 712 passed, 3 skipped, 40 files.

**Filed issues:** critical/high findings tracked as [#4](https://github.com/yourdigitaltoolbox/remote_pi/issues/4)–[#10](https://github.com/yourdigitaltoolbox/remote_pi/issues/10).

---

## Overall assessment

The code is careful in most places. The config CAS-under-lock writer, the daemon registry hardening (O_NOFOLLOW + fd `fstat` + dev/ino recheck + tar-safe atomic writes), the relay reconnect epoch-fencing, and the relay-exposure lease state machine (capability token never stored in plaintext) are all well built. Problems cluster in two themes:

1. **The relay is trusted to assert identity fields it should not be trusted for** (the `peer` on inbound app frames, `from_pc`/`from` on mesh envelopes, the owner id at pairing time, the owner of a fetched mesh blob).
2. **Several fire-and-forget async paths can take down the whole process** (missing stream error handlers, unguarded `relay.send`/`_pi.sendMessage` inside async callbacks, throwing tails on cron persistence).

---

## Critical — relay trusted to assert identity

The trust model (`PROTOCOL.md`) says the relay observes plaintext but cannot forge authenticated actions. Three paths break that; they share a root cause and should be fixed together.

### C1 — Inbound app→Pi messages authenticated only by relay-supplied `peer` — [#4](https://github.com/yourdigitaltoolbox/remote_pi/issues/4)
`index.ts:1493-1553`, `transport/peer_channel.ts:92-126`. Inner payload is `base64(JSON)` — no cipher, no MAC (`peer_channel.ts:14-18`; `PROTOCOL.md:338` concedes "Não há E2E"). A malicious relay sets `outer.peer` to a paired owner's pubkey and injects any `ClientMessage` — most dangerously `{type:"approve_tool", decision:"allow"}` (auto-approve a pending tool call → RCE), or `user_message`, `session_new`, `model_set`.

### C2 — `pair_request` carries no owner signature — [#5](https://github.com/yourdigitaltoolbox/remote_pi/issues/5)
`protocol/types.ts:10`, `index.ts:1579-1618`. `_handlePairRequest` validates only the QR token, then persists the owner identity as the relay-supplied `appPeerId`. Nothing binds the QR secret to an owner keypair. Contradicts `PROTOCOL.md:327`. Spoofing a paired owner needs only the one-time token.

### C3 — Relay can forge `from:"broker"` mesh envelopes — [#6](https://github.com/yourdigitaltoolbox/remote_pi/issues/6)
`session/broker_remote.ts:404-407, 529-543` (verified). The `fromPc === "_relay"` branch injects the envelope verbatim via `broker.injectFromRemote` with no check that `body.type === "transport_error"` and no forcing of `env.from`. A relay sends `{from_pc:"_relay", envelope:{from:"broker", body:{type:"relay_lease_promoted", lease:{…}}}}` and the child activates a relay-exposure lease; also enables arbitrary spoofed agent-to-agent messages with a trusted local `from`.

**Fix theme:** authenticate the inner payload (owner-signed frames + owner-signed `pair_request`); never let the `_relay`/`from_pc` path carry `from: "broker"` or an un-prefixed local route.

---

## High

### H1 — `siblings.ts` skips the mandatory owner-slot check — [#7](https://github.com/yourdigitaltoolbox/remote_pi/issues/7)
`mesh/siblings.ts:95-134` (verified). `verify.ts:6-14` documents that the caller MUST check `sha256(header.ownerPk) === queried hash`; `self_revoke.ts:228-234` does, `discoverSiblings`/`discoverSelfLabel` don't. A relay serves an attacker-signed blob at owner A's hash slot listing attacker pubkeys as members → seeds `BrokerRemote`'s "authoritative for anti-spoof" sibling set → forged cross-PC envelopes pass. Bounded by the ~60s SelfRevoke sweep; a fresh window opens on every bridge attach. One-line fix.

### H2 — Lease `issue()` doesn't scope binding to parent workspace — [#8](https://github.com/yourdigitaltoolbox/remote_pi/issues/8)
`session/relay_exposure_lease.ts:614-668` (verified). Validates binding shape/TTL/capacity but never checks `binding.workspaceId === delegation.parent.workspaceId` — while the runner path does (`delegateRunner` → `invalid_runner_scope`). Since `revokeWorkspace` enumerates by parent workspace only, workspace A's `relay-parent authorize` can issue a lease to a workspace-B child, and B's `child-policy local` won't revoke it. Violates the README invariant.

### H3 — Child stdin has no error handler; async EPIPE crashes the supervisor — [#9](https://github.com/yourdigitaltoolbox/remote_pi/issues/9)
`daemon/rpc_child.ts:324, 394`. Writes guarded only by synchronous try/catch; a broken-pipe error arrives asynchronously as an unhandled `'error'` event. A cron fire or `get_state` landing as a daemon child dies → supervisord exits → entire fleet down.

### H4 — Windows control pipe unauthenticated and squattable — [#10](https://github.com/yourdigitaltoolbox/remote_pi/issues/10)
`session/ipc.ts:45-49`, `supervisor.ts:195-199`, `bin/supervisord.ts:89-92`. `\\.\pipe\remote-pi-supervisor-<user>` is first-creator-wins with no ACL/server-identity check. A squatter → real supervisor treats "already running" as exit 0 → Task Scheduler never retries (permanent silent DoS), and the squatter receives every `send`/`cron_add` prompt. POSIX is safe (0700 dir gate).

---

## Medium — process-liveness / correctness

- **M1 — Fire-and-forget async paths can crash the Pi process** (no `unhandledRejection` handler). `void _cmdRoot(ctx)` auto-init rethrowing non-keyring errors (`index.ts:2098, 2138, 2807`); unguarded `relay.send`/`_pi.sendMessage` in `_handlePairRequest` (`index.ts:1548, 1584-1649`) — the exact crash `peer_channel.ts:78-82` wraps but this path missed; cron fires whose `saveCronRegistry` tail throws (`cron_registry.ts:82-85`, `supervisor.ts:484, 507`).
- **M2 — App-peer disconnects never detected** — `peer_channel.ts:52-57` does `void _onDisconnect` (verified dead code); `_onPeerDisconnect` (`index.ts:1411`) only runs in tests. A dropped phone stays "online" in `_activePeers` and `/remote-pi status` forever, retaining `_currentTurnId`.
- **M3 — Leader-election & identity-lock stale-socket unlink races** — `session/leader_election.ts:28-38, 101-108`; `session/cwd_lock.ts:101-126`. Between a failed probe and `_removeStaleSock`, a second contender can unlink a live leader's socket and bind a second broker (split-brain) / double-acquire the identity lock. The `cwd_lock` "no race window" header claim is false for the unlink-retry path.
- **M4 — `Broker.close()` hangs forever with any unregistered connection open** — `session/broker.ts:433-438, 587-610`. `close()` destroys only registered peers; `_tryObserverProbe` leaves its socket open, so `net.Server.close()`'s callback never fires. A stray `remote-pi peers` CLI wedges `leave()`/`rename()` teardown.
- **M5 — `MeshNode._maybeBridge` re-entrancy** — `session/mesh_node.ts:177-240`. The `if (this.brokerRemote) return` guard isn't re-checked after its awaits; a relay reconnect racing a UDS failover builds two `BrokerRemote`s on one relay → every inbound cross-PC envelope processed and ACKed twice, plus a leaked still-subscribed instance.
- **M6 — No reentrancy guard on `_cmdJoin`/`_cmdStart`** — `index.ts:3932-4115, 2749-2993`. Concurrent entry points (auto-init + user `/remote-pi` + Cockpit `relay:on`) double-connect and leak the loser (`MeshNode` or `RelayClient` + auto-listener never closed).
- **M7 — Supervisor state-machine gaps** — `supervisor.ts`: `stop`/`stop_all` don't cancel a pending crash-backoff timer, so a stopped daemon resurrects (`:316-341`); restart budget never resets on healthy uptime, so 4 lifetime crashes brick a daemon forever (`:617-632`); `EXIT_DAEMON_FRESH_SESSION` respawns with zero delay/budget → unthrottled loop (`:606-614`); control-socket `data` handler never truncates its buffer past the newline, so a trailing byte re-runs the request twice (`:215-224`).
- **M8 — Cron guards bypassable / lossy** — `cron_registry.ts:176-188` samples only the next two runs from "now", so a 6-field schedule can defeat the 60s minimum; non-atomic persistence silently drops all jobs on a mid-write crash (`:82-85`); catchup fires for slots predating job creation (`supervisor.ts:506-507`).
- **M9 — Service-template substitution has no per-format escaping** — `install.ts:172-181`. `&`/`<` in `PATH`/`HOME` breaks launchd/Task XML; unquoted `ExecStart` splits on spaces, `%` is a systemd specifier, a newline injects arbitrary unit directives. Values are the installing user's own env (correctness, not privilege) except the systemd-directive-injection variant. Linux reinstall also never `daemon-reload`s (`:246-248`), so the "idempotent refresh" claim is false there.

---

## Low / hygiene

- **Anti-rollback floor in-memory only** (`mesh/self_revoke.ts:96`) — restart lets a relay replay a stale-but-signed membership blob and keep a revoked Pi alive.
- **No replay protection on cross-PC envelopes** (`broker_remote.ts:398-492`) — `env.id` carried but never deduped; relay can re-deliver a command N times.
- **Relay challenge-response is a signing oracle** (`transport/relay_client.ts:226-236`) — Pi-sk signs a raw relay-chosen nonce with no domain separation; harmless today, dangerous once Pi-key-signed payloads land.
- **`peers.json` written 0644, non-atomic** (`pairing/storage.ts:321-354`) — a crash mid-write can drop all pairings.
- **NUL control channel accepts app-sourced input** (`index.ts:1894`) — a paired device can send `\x00remote-pi-ctrl:rename:…` and write durable cwd config; gate the CTRL check on non-`extension` sources.
- **Relay URL with userinfo echoed to logs/status** (`index.ts:2501-2509`, `config.ts:68-73`) — basic-auth creds leak into transcript/journal; redact before display.
- **Predictable temp file for the ephemeral MCP config** (`index.ts:5062-5067`) — `remote-pi-mesh-mcp-<pid>.json` in shared `/tmp`; use `mkdtempSync`. Similar TOCTOU on the Windows elevate `.cmd` (`install.ts:395-408`).
- **`_messageBuffer` grows unbounded** including inline image bytes (`index.ts:1980`) — only cleared on new-session; a long-lived daemon accumulates over days.
- **`PI_SUBAGENT_CHILD=""` classifies as a normal relay session** (`session/child_policy.ts:246-267`) — every other malformed marker fails closed to local; the empty string should too.
- **Fail-closed-but-annoying:** stale writer lock bricking first-migration boot (`registry.ts:452`), single-shot failover with no retry (`peer.ts:432`), stuck-pre-ack listener on register timeout (`peer.ts:286-360`), no log rotation on `supervisord.log`/`cron.jsonl`, `stop()` not killing the child's process tree (`rpc_child.ts:336`), self-send-to-alias timing out instead of refusing (`tools.ts:111`), `uuidv7()` doc overclaims intra-ms monotonicity (`envelope.ts:19-41`), lease activation-path clone skips case normalization (`index.ts:2736`), consumed pairing token burned on `addPeer` failure (`index.ts:1593`), `_renameAgent` failures print to stderr invisibly in the TUI (`index.ts:1314`).

---

## Areas verified clean

- **`config.ts` / `rooms.ts`** — scheme canonicalization consistent; NUL separator in `roomIdFor` prevents cwd/name ambiguity; legacy-room preservation matches its invariant.
- **Relay reconnect state machine** — epoch fencing (`_onRelayClose`, `_attemptReconnect`) and stop-vs-reconnect race handling in `_goIdle` are correct.
- **`mesh/verify.ts`** — verifies Ed25519 over raw received bytes (no re-canonicalization), so canonicalization signature-confusion is structurally impossible on the verify path.
- **`mesh/encoding.ts` / `self_revoke.ts`** — base64-decode-before-compare avoids the standard-vs-urlsafe trap; owner-slot binding and in-run anti-rollback are correct.
- **`pairing/storage.ts` identity resolution** — file-identity-wins, keyring-lock retry, fail-loud `KeyringUnavailableError` instead of silently minting a new key; secret key never logged; identity-file fallback is 0600 in a 0700 dir.
- **`session/local_config.ts`** — CAS-under-exclusive-lock is a real CAS; lock removal nonce+inode-guarded, fails closed. Residual TOCTOU is exactly the documented same-user caveat.
- **`session/relay_exposure_lease.ts` state machine** (aside from H2) — terminal transitions, tombstone pruning, renewal receipts, capability digests (token never stored plaintext), parent/child-disconnect revocation all consistent.
- **`session/child_policy.ts` resolution order** (aside from the empty-string case) matches the documented chain; `auto_start_relay` never promotes a child.
- **POSIX control-socket auth & daemon registry hardening** — 0700 dir gate, O_NOFOLLOW opens, fd-based fstat validation, dev/ino recheck, revision+hash CAS, O_EXCL nonce-verified lock, tmp+fsync+rename+dir-fsync, no path traversal in cwd handling.

---

## Method

Reviewed by four parallel subsystem readers plus a dedicated crypto/transport/pairing pass, each quoting and verifying source. The sharpest structural findings (H1 owner-slot check, C3 `_propagateTransportError`, H2 lease workspace scope, M2 dead disconnect callback) were independently re-verified against source before filing.
