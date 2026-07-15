<p align="center">
  <img src="https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/branding/logo-full.svg" width="160" alt="Remote Pi logo" />
</p>

<h1 align="center">Remote Pi</h1>

> Extend the [Pi coding agent](https://github.com/earendil-works/pi) with two
> superpowers: agents that talk to each other on the same machine, and a mobile
> app that drives Pi from your phone.

**Homepage:** <https://remote-pi.jacobmoura.work>

`/remote-pi` is a single slash command that wires both at once. Run it; the
first time it asks a couple of questions and you are done.

## Protocol & Security

For wire format, identity model, ACK protocol, cross-PC routing, mesh
membership, and the trust model (what the relay sees and doesn't see),
read the package-visible [`docs/PROTOCOL.md`](./docs/PROTOCOL.md). The repository root copy is canonical
document — this README only covers user-facing setup.

---

## Quick start

Install the extension (one-time):

```bash
pi install npm:remote-pi
```

Then in any Pi terminal:

```text
/remote-pi
```

The first run shows a short interactive wizard (agent name, default session,
whether to auto-start the relay). On every following run, `/remote-pi` joins
the local agent session and starts the relay automatically — no extra typing.

### Try the agent network in 30 seconds

Open **two** Pi terminals in the same directory and run `/remote-pi` in each.
Both join the same session. Now just talk to the LLM — it has the tools.

In terminal A (say it ended up named `agent-A`):

```text
Who else is connected in our agent session? List them.
```

The LLM calls `list_peers` and sees opaque routes. Current peers use immutable
`~identity/<workspaceId>/<agentId>` routes; legacy peers may still appear as
cwd/name aliases.

Then, still in terminal A:

```text
Send a ping to the listed route for agent-B and wait for a reply.
```

Pi passes that listed route verbatim to `agent_request`/`agent_send`. The
message arrives in terminal B as a user-facing turn; replies use the immutable
sender route carried in the envelope. Names remain display metadata only.

---

## What it does

Remote Pi adds two independent layers on top of Pi. You can use either, or
both:

### 1) Agent network (local, same machine)

Several Pi instances running side-by-side in different terminals can discover
each other and exchange messages. Each instance is a peer in a named
*session* and gets two tools the LLM can call directly:

- `agent_send` — fire-and-forget message to another agent
- `agent_request` — send and await a reply (correlated by message id)

This is purely local: the agents talk over a Unix domain socket at
`~/.pi/remote/sessions/<session-name>/broker.sock`. No network involved.
Useful for splitting work across roles (`backend`, `frontend`, `tests`,
`orchestrator`, …) and letting them coordinate.

#### Child-agent safety

Pi launchers may classify a process as a child with the legacy
`PI_SUBAGENT_CHILD=1` marker or the versioned `PI_SUBAGENT_DESCRIPTOR` JSON
contract. Classified children still load their ordinary Pi extensions and join
the local mesh, but remote-pi caps them at **local-only** exposure unless a
separate relay authorization is present. A cwd's `auto_start_relay: true` is
normal-session consent and never promotes a child by itself.

Descriptor v1 carries non-authoritative run, logical-agent, process-epoch,
parent/index, requested-exposure, the winning launcher intent source
(`run`, `agent`, or unresolved `fallback`), launcher version/manifest hash, and
remote-pi preflight version/manifest hash fields. Child mode resolves in strict
order: explicit run request → agent default → protected project
`child_exposure` policy → built-in `local`. Normal-session `auto_start_relay`
never participates in that chain. The package advertises accepted versions
under `pi.remotePi.childSessionProtocol`; compatible launchers verify that
metadata before child Pi wake. The initial previous-version contract is the
legacy marker, which is always local-only. Missing required v1 fields,
malformed metadata, and unknown/future versions fail closed to local. Authority
RPCs from the source-less pre-D8 v1 build remain compatible but normalize to
the lower-precedence explicit `agent` layer; omission never manufactures `run`
or protected `fallback` authority.

Child/Pi session names are runtime presentation only. They may label the live
mesh peer, but they never overwrite the shared cwd
`.pi/remote-pi/config.json`. `/remote-pi child-policy <off|local|relay>` is the
operator-only protected project policy surface; supervisor-injected direct
config cannot set it. `/remote-pi status` reports requested policy mode,
lease-backed effective exposure, classification, winning policy source, and
safe protocol/source diagnostics.

A relay request still needs a separate transient live-parent delegation from
`/remote-pi relay-parent authorize [route]`. `/remote-pi relay-parent revoke
[route]` withdraws one exact parent. Changing child policy away from `relay`
revokes every delegated parent, detached-runner token, and active child lease
in that workspace; disconnect and broker restart also fail closed. Lowering a
persisted relay child policy requires a joined local mesh so that workspace
withdrawal can be confirmed before the config CAS. Detached
runner delegation preserves per-child intent source, so an agent/run-authorized
sibling cannot elevate a fallback child when project policy denies fallback.
Claimed-child metadata never authorizes relay or privileged work and does not
disable other extensions.

The first agent to enter a session becomes the *leader* (hosts the broker);
the rest are *followers*. If the leader exits, a follower automatically takes
over — the failover is invisible to the LLMs.

### 2) Mobile app (over the relay)

The companion mobile app lets you send prompts to Pi and read its responses
from your phone. The phone and the Pi process find each other through a
**relay**: a small WebSocket server that ferries messages between them.
Pairing is one-time and per device, via QR code.

Communication: WebSocket over TLS to the relay (ciphertext in transit).
The relay sees plaintext envelopes at rest and in forwarding — see
[`docs/PROTOCOL.md`](./docs/PROTOCOL.md) for the paired-client protocol and trust model.

**Get the app** — all current download options (Google Play, App Store, and
direct builds while public releases roll out):

<https://remote-pi.jacobmoura.work/#get-the-app>

---

## Mobile app actions

Beyond the chat, the app surfaces a small set of typed actions you can run
on the paired Pi session. Tap the ⚙ button next to the message input (visible
when the input is empty) to open the Quick Actions sheet:

| Action | What it does |
|---|---|
| **Compact context** | Runs `ctx.compact()` — same as `/compact` in the TUI. |
| **New session** | Runs `ctx.newSession()` — equivalent to `/new`, asks for confirmation first. |
| **Model** | Opens a model picker fed by your authenticated providers (same source the TUI uses) and switches via `pi.setModel(model)`. |
| **Thinking** | Segmented control with the 6 SDK levels (`off` · `minimal` · `low` · `medium` · `high` · `xhigh`). Changes via `pi.setThinkingLevel(level)`. |

Each action gets a structured `action_ok` / `action_error` reply so the app
can show a SnackBar on failure. Visible side-effects (chat output, model
change broadcasts, compaction notice) still flow through the normal chat
channels. The wire schema is documented in [`docs/PROTOCOL.md`](./docs/PROTOCOL.md)
under "Lifecycle wire schema".

It is **not** a generic slash-command picker. The Pi SDK does not expose
programmatic invocation for most builtins (those live in the TUI's
interactive loop), so the app exposes only the actions that have a clean
SDK call. The [`pi-telegram`](https://github.com/llblab/pi-telegram) adapter
follows the same pattern.

### Public paired Node client

Automation that must traverse the real paired relay boundary can import only
`remote-pi/client` (never `dist/**`, the root router, or `remote-pi/testing`):

```ts
import { PairedClient } from "remote-pi/client";
const client = await PairedClient.connect({ relayUrl, pairingUri, deviceName: "ephemeral client" });
if ((await client.pair()).type !== "pair_ok") throw new Error("pairing rejected");
const status = await client.lifecycleStatus();
```

The client uses an ephemeral Ed25519 identity, authenticates to the relay, and
requires correlated `pair_ok` before owner actions. It exposes typed
`lifecycleStatus`, `compact`, `lifecycleRepair`, and `onLifecycleOutcome` only;
it does not read profiles or expose router, singleton, or test seams. See
[`docs/PROTOCOL.md`](./docs/PROTOCOL.md) for lifecycle schemas, CAS/rejection,
pairing authorization, and redaction requirements.

### Public outbound mesh client

A non-Pi Node service can submit an authority-bearing message through the real
local/cross-PC mesh without importing private `dist/session/**` files through
the supported `remote-pi/mesh` subpath:

```ts
import { MeshClient } from "remote-pi/mesh";

const mesh = new MeshClient({
  sockPath,
  name: "orchestration-dashboard",
  cwd,
  identity: { workspaceId, agentId, processEpoch },
  bridge: { relayUrl, cwd },
});
await mesh.connect();
const orchestrator = await mesh.resolveIdentityTarget({
  workspaceId: orchestratorWorkspaceId,
  agentId: orchestratorAgentId,
});
const result = await mesh.agentSend(orchestrator, { decisionId, response });
if (result.status !== "received") throw new Error(`decision not delivered: ${result.status}`);
```

`resolveIdentityTarget` requires exactly one broker record matching both stable
identity fields and a non-empty broker-returned `identityAddress`. It returns an
opaque, non-serializable handle with no route/address getter. The module keeps
the address private and `agentSend` accepts only a handle created by that exact
client and connection generation, so address/name/alias fallback and route
construction are structurally unavailable. Resolution fails with a typed
`MeshIdentityResolutionError` code: `zero-match`, `multiple-match`,
`missing-identity-address`, `disconnected`, or `timeout`.

Only `received` is a positive target-retention ACK; `busy`, `denied`, and
`timeout` are non-delivery. The public ACK contains only `status` and envelope
`id`, never the private target route.

The v1 facade is intentionally outbound-only. It exposes no peer list, routes,
addresses, `Broker`, `SessionPeer`, inbound callback, or reconnect callback,
and honestly denies inbound acknowledged agent envelopes rather than accepting
them without an application inbox. Transport reconnect remains internal and
invalidates previously resolved handles. The repository-root Git bridge mirrors
the same `./mesh` export so an exact-SHA dependency resolves the supported
facade after its prepare build.

### Archive candidate testing

Reviewed lifecycle candidates can import the package-only `remote-pi/testing`
subpath and call `createExactCandidateProbe({ session, seed, packageDirectory })`.
The seam accepts only opaque compact-action and mesh-arrival identifiers, drives
the production action/admission paths, and returns immutable opaque receipts.
It neither opens a relay nor reads or changes a live Pi profile.

### Images

The app can attach **one image** (camera or gallery) to a message. It's
compressed on the device and rides **inline** in the `user_message` — the
optional `images` field carries `{ data: <base64>, mime }`. The pi-extension
turns it into the SDK's multimodal content (an `ImageContent` followed by the
caption `TextContent`) and calls `sendUserMessage(content)`, so the model sees
the picture plus your text.

Whether a model accepts images is surfaced as a `vision` flag on each
`WireModel` (derived from the SDK's `Model.input` including `"image"`); the app
greys out the attach button when the active model is text-only.

The **relay is unchanged** — the image travels inside the same opaque `ct` blob
as the rest of the message, so there's no binary channel (large files are a
future track). Text-only messages are unaffected.

---

## Install

Requirements: Node 20+, Pi (the host coding agent).

```bash
pi install npm:remote-pi
```

The extension self-registers the `/remote-pi` slash command and deploys an
agent skill that teaches the LLM how to use `agent_send` / `agent_request`.

To verify:

```text
/remote-pi config
```

It should print the effective relay URL and where it came from
(`env` / `config` / `default`).

---

## Using `/remote-pi`

The bare command is the everyday entry point:

```text
/remote-pi
```

Behavior depends on whether there's a local config for this directory:

| State | What happens |
|---|---|
| First run (no `.pi/remote-pi/config.json`) | Interactive wizard → saves config → joins agent session → starts relay (if you opted in) |
| Returning user, auto-start enabled | Joins agent session + starts relay automatically, then prints status |
| Returning user, auto-start disabled | Prints status only; join/relay must be run manually |

The wizard asks three questions:

1. **Agent name** — the human-facing label shown for this runtime. Current
   routing uses immutable IDs; the label defaults to the directory name.
2. **Default session** — the name of the agent-network room for this
   directory. Multiple terminals in the same directory join the same session.
3. **Auto-start relay (for mobile app access)?** — `Yes` if you want
   `/remote-pi` to also connect to the relay so the mobile app can reach this
   Pi. `No` for local-only use (agent network without mobile access).

Re-run the wizard later with `/remote-pi setup`.

---

## Pairing a mobile device

Once the relay is up (`/remote-pi relay status` shows `started` or `paired`):

```text
/remote-pi pair
```

A QR code is printed in the terminal. Scan it with the Remote Pi mobile app.
Pairing is **per machine** — once a device is paired, every Pi process on
this machine accepts it (it lives in `~/.pi/remote/peers.json`).

To list paired devices:

```text
/remote-pi devices
```

To remove one:

```text
/remote-pi revoke <shortid>
```

The shortid is the first 8 chars shown by `devices`.

---

## The relay

The relay is the only network-touching piece of Remote Pi. It does **not**
read messages — payloads are end-to-end encrypted between the Pi and the
paired device — but it sees connection metadata: which keypair is online,
which room/cwd identifiers exist, message timing, sizes.

You have two options:

### Option A — Use the community relay

`https://relay-rp1.jacobmoura.work` (default). Zero setup. Good for trying
things out or for casual use. (The extension converts to `wss://…`
internally when opening the connection — both schemes point at the same
endpoint.)

Caveats:

- Shared infrastructure — availability is best-effort.
- The operator could observe connection metadata as described above.
- TLS + per-message encryption is the only protection; **there is no IP
  allow-listing or VPN gating**.

### Option B — Self-host (recommended for privacy)

Run the relay yourself in Docker and put it behind a VPN like
[Tailscale](https://tailscale.com), [WireGuard](https://www.wireguard.com),
or your own VPC. Because the relay's network-level protection is just TLS +
keypair authentication, layering a VPN on top means **only your devices** can
even reach the WebSocket port — defense in depth.

Quick Docker outline (see the
[relay README](https://github.com/jacobaraujo7/remote_pi/blob/main/relay/README.md#self-hosted-relay-recommended-for-privacy)
for the full setup, environment variables, and reverse-proxy guidance):

```bash
docker run -d \
  --name remote-pi-relay \
  -p 3000:3000 \
  --restart unless-stopped \
  ghcr.io/jacobaraujo7/remote-pi-relay:latest
```

Bind the container to your VPN interface, terminate TLS in a reverse proxy,
and point both your Pi and your phone at the resulting `https://…` URL.

### Pointing Pi at your own relay

Once your relay is reachable, tell the extension:

```text
/remote-pi relay url https://relay.yourdomain.tld
```

The URL **must** be `http://` or `https://` — `ws://` / `wss://` are
rejected at validation. The extension converts to WebSocket internally when
it opens the connection. Same canonical form for the mobile app and any
self-hosting docs: paste the URL your reverse proxy exposes.

This writes `~/.pi/remote/config.json` with `{ "relay": "..." }`. Resolution
order (highest precedence first):

1. `REMOTE_PI_RELAY` environment variable (CI / one-off overrides)
2. `~/.pi/remote/config.json`
3. The built-in default (`https://relay-rp1.jacobmoura.work`)

Verify the active URL and its source with:

```text
/remote-pi config
```

If you change the URL while connected, run `/remote-pi relay stop` then
`/remote-pi relay start` (or `/remote-pi relay` to toggle).

The mobile app has its own relay-URL setting in its preferences pane — keep
both pointing at the same relay.

---

## Agent network: deeper look

Each session is one Unix-domain-socket broker plus N peers. Current peer
ownership and public routing use immutable workspaceId+agentId. The broker
retains `<cwd>@<name>` only as a mixed-version compatibility alias and
broadcasts system lifecycle events.

Inside the LLM, call `list_peers` first and echo one returned route verbatim:

```jsonc
const { peers } = list_peers()
agent_send({
  to: peers[0],
  body: { task: "add /healthz endpoint" },
  re: "<id>" // set only when replying to a previous message
})
```

Current local routes have the form `~identity/<workspaceId>/<agentId>`;
cross-PC routes prefix that with `<pc>:`. Legacy aliases remain routable but
are not authoritative ownership keys. The wire format is a 5-field envelope
`{ from, to, id, re, body }` serialized
as one JSON line per message. The leader's broker writes an `audit.jsonl`
log at `~/.pi/remote/sessions/<name>/audit.jsonl` for postmortem inspection.

Useful commands:

| Command | What it does |
|---|---|
| `/remote-pi join [name]` | Join (or create) a session — only needed manually if `auto_start_relay=false` |
| `/remote-pi leave` | Leave the current session |
| `/remote-pi sessions` | List local sessions and which are live |
| `/remote-pi rename <new>` | Persist display metadata with revision/hash CAS; immutable route/room unchanged |

Legacy alias collisions may receive numeric suffixes (`backend#2`, …).
Current peers can share a display name because immutable IDs own their routes.

---

## Command reference

### Local session (one Pi, one terminal)

| Command | Description |
|---|---|
| `/remote-pi` | Connect (join local mesh + start relay), or run setup on first use |
| `/remote-pi setup` | Run the setup wizard and update local config |
| `/remote-pi status` | Show local mesh + relay status |
| `/remote-pi stop` | Stop everything for **this** terminal (mesh + relay) |
| `/remote-pi pair` | Show QR code + copy-paste pairing URI for a new mobile device |
| `/remote-pi devices` | List paired mobile devices (online/offline per device) |
| `/remote-pi revoke <shortid>` | Revoke a paired device by its shortid |
| `/remote-pi set-relay <url>` | Persist a new relay URL (http:// or https://) |
| `/remote-pi child-policy <off\|local\|relay>` | Set the protected project fallback for child sessions; moving away from relay withdraws workspace relay authority |
| `/remote-pi relay-parent authorize [route]` | Transiently delegate child relay issuance to one live parent in this workspace (broker leader only) |
| `/remote-pi relay-parent revoke [route]` | Revoke one exact parent delegation and its active child relay leases |

### Daemon fleet (one supervisor, N background Pis — see [Daemon mode](#daemon-mode))

| Command | Description |
|---|---|
| `/remote-pi create <cwd> [--name X]` | Register a folder as a daemon |
| `/remote-pi remove <id>` | Unregister a daemon (local config preserved) |
| `/remote-pi daemons` | List registered daemons + state |
| `/remote-pi daemon start` | Start every registered daemon |
| `/remote-pi daemon stop` | Stop every running daemon (`/remote-pi stop` stops only the local terminal) |
| `/remote-pi daemon restart` | Stop + start all daemons |
| `/remote-pi daemon status` | Detailed runtime status (pid, uptime, restart count) |
| `/remote-pi daemon send <id> "<text>"` | Send a prompt to a specific daemon |
| `/remote-pi cron add <id> "<expr>" "<prompt>"` | Schedule a recurring prompt (`--tz`, `--wake`, `--no-skip-busy`, `--catchup`) |
| `/remote-pi cron list` | List scheduled jobs (schedule, enabled, next run, last status) |
| `/remote-pi cron run <jobId>` | Fire a job now (ignores its schedule) |
| `/remote-pi cron enable\|disable <jobId>` | Toggle a job on/off |
| `/remote-pi cron remove <jobId>` | Delete a job |
| `/remote-pi cron log [<jobId>] [--tail N]` | Read the fire/skip audit log |
| `/remote-pi install` | Install `pi-supervisord` as a system service |
| `/remote-pi uninstall` | Remove the system service (registry preserved) |

All commands above work both as Pi slash commands (interactive) and as
shell-level `remote-pi <subcommand>` when the package is installed
globally (`npm install -g remote-pi`).

### Scheduled prompts (`cron`)

`remote-pi cron` schedules **recurring prompts** to daemons through the
supervisor — e.g. a daily "summarise new PRs". Output flows fire-and-forget to
the mesh/app like any prompt; the cron layer only audits the dispatch.

- **Schedule** is a cron expression (croner syntax; an optional 6th *seconds*
  field is supported), with an optional IANA timezone via `--tz`:

  ```sh
  remote-pi cron add a1b2c3d4 "0 9 * * *" "Summarise new PRs" --tz America/Sao_Paulo
  ```

- **Minimum interval is 60s** — more frequent schedules are rejected (guards
  token cost + pileup). A fire is **skipped when the daemon is mid-turn**
  (`--no-skip-busy` to override); `--wake` starts a stopped daemon first;
  `--catchup` runs once on supervisor start if the previous run was missed.
- **Prerequisite**: the supervisor must run as a service (`remote-pi install`).
  Without it there is no scheduler, and `cron` commands say so instead of
  silently pretending to schedule.
- **Audit**: every fire **and** every skip appends one line to
  `~/.pi/remote/cron.jsonl` with a `result` of `delivered`,
  `woke_and_delivered`, `deliver_failed`, `skipped_busy`, `skipped_down`, or
  `skipped_disabled` — read it with `remote-pi cron log`.

Step-by-step walkthrough: the [daemon tutorial](https://remote-pi.jacobmoura.work/tutorials/daemon).

### Footer + title

- `📡 local (N)` — current agent session and peer count (local mesh)
- `🟢 relay` — relay connected, at least one device paired (globally)
- `🟡 relay waiting for pairing` — relay connected, no device paired yet
- `📱 <shortid>` — a mobile device is actively connected right now

Window title: `<agent-name> · On` when relay is up, `<agent-name> · Off`
otherwise. Tells your terminals apart at a glance in `cmux`/`tmux`/iTerm
tabs.

---

## Daemon mode

When you want a Pi to keep running in the background (responding to
mobile prompts at 3am, processing cron jobs, monitoring a folder while
you're not at the keyboard), promote it to a **daemon** managed by a
single OS-level supervisor.

See [`docs/daemon.md`](./docs/daemon.md) for troubleshooting.

### One-time setup

```bash
# Install the package globally so `remote-pi` and `pi-supervisord`
# are on your PATH (`pi install npm:remote-pi` alone makes the Pi
# extension available but does NOT expose the CLI binaries — see
# https://docs.npmjs.com/cli/v10/configuring-npm/package-json#bin).
npm install -g remote-pi

# Install the supervisor as a user-level system service. Linux uses
# systemd --user; macOS uses launchd LaunchAgent. Both auto-start at
# login and survive reboots.
remote-pi install
```

The `install` command:
- Writes `~/.config/systemd/user/remote-pi-supervisord.service` (Linux)
  or `~/Library/LaunchAgents/dev.remotepi.supervisord.plist` (macOS)
- Activates it via `systemctl --user enable --now` or `launchctl bootstrap`
- The supervisor starts immediately and re-starts on every login

### Per-folder workflow

For each agent you want to keep alive 24/7:

```bash
# 1. Configure the agent interactively first (one time).
cd ~/Movies
pi                                 # /remote-pi → setup wizard, /remote-pi pair, etc

# 2. Promote to a daemon. The id is derived from the cwd
#    (sha256(realpath)[:8]), stable across machines.
remote-pi create ~/Movies --name "Video Editor"
# → Daemon registered: id=4e39152d name="Video Editor" cwd=/Users/x/Movies

# 3. Start it (supervisor spawns `pi --mode rpc` for this folder).
remote-pi daemon start
```

Now you can:

```bash
remote-pi daemons                  # list + state
remote-pi daemon status            # uptime, pid, restart count
remote-pi daemon send 4e39152d "Cut the first 30 seconds of latest clip"
remote-pi daemon stop              # stop all
remote-pi daemon restart           # restart all
```

The agent receives the prompt as if a user typed it; its response flows
back through the relay/mesh you configured during interactive setup —
mobile app sees it live, other agents on the same machine can see it
via the local UDS mesh.

### Removing or uninstalling

```bash
remote-pi remove <id>              # unregister one daemon (config preserved)
remote-pi uninstall                # remove the supervisor service (registry kept)
```

`uninstall` is reversible — re-running `install` later brings every
registered daemon back. To wipe the registry entirely, `rm
~/.pi/remote/daemons.json`.

### Where to find logs

| Platform | Command |
|---|---|
| Linux | `journalctl --user -u remote-pi-supervisord -f` |
| macOS | `tail -f ~/.pi/remote/supervisord.log` |

Each spawned daemon's stderr is forwarded into the supervisor's log
with a `[<cwd>]` prefix, so a single log stream shows every agent.

### Caveats (plan/26 trade-offs)

- **Tool approval is not gated.** Daemons inherit the same Pi config
  the interactive run uses — Bash, Edit, Write etc. all execute without
  prompting. Configure Pi's tool permissions to taste before promoting
  a folder to daemon.
- **Pairing still happens interactively.** Daemons don't show a QR
  themselves; the keypair + paired devices come from the prior `pi`
  session in the same folder.
- **Single supervisor.** If `pi-supervisord` crashes all daemons go
  down with it. systemd/launchd restarts it within seconds; daemons
  come back automatically.
- **One daemon registration per cwd.** Duplicate registrations for the same
  normalized cwd are rejected. The registry retains a stable `workspaceId`,
  while relay rooms use immutable workspace/logical-agent identity.

---

## Configuration files

| Path | Scope | What's in it |
|---|---|---|
| `<cwd>/.pi/remote-pi/config.json` | Per-directory | schema/revision, `workspace_id`, `agent_name`, `auto_start_relay` (private `0700/0600`) |
| `~/.pi/remote/daemons.json` | Per-machine | protected schema/revision, daemon cwd/name, stable generic `workspaceId` (`0700/0600`) |
| `~/.pi/remote/config.json` | Per-user | `relay` URL |
| `~/.pi/remote/peers.json` | Per-machine | Paired mobile devices |
| `~/.pi/remote/sessions/<name>/` | Per-session | Broker socket + `audit.jsonl` |
| `~/.pi/remote/skills/agent-network/SKILL.md` | Per-user | Agent skill the LLM reads |

The per-directory config and daemon-registry boundaries reject pre-existing
symlink components, read trusted bytes and protection metadata from the same
no-follow file descriptor, use private modes, and serialize cooperative
writers with exclusive revision/hash CAS locks. Portable Node does not expose contained `openat2` /
`unlinkat` or a cross-platform `flock`, so this boundary does not claim to
resist a malicious process already executing as the same OS user and racing
path replacement between syscalls. Such a process can already rewrite the
user's `0600` config and inspect the Pi process; treat that as local-user
compromise. Detected replacements fail closed, and these generic IDs never
convey relay authorization or privileged YDTB authority. Stale writer locks
are intentionally not auto-unlinked through a racy pathname; after confirming
that no writer is live, recovery requires deliberate removal of
`.pi/remote-pi/config.lock` (or `~/.pi/remote/daemons.lock` for the registry)
before retrying the revision-checked write.

Override the relay for a single run without persisting:

```bash
REMOTE_PI_RELAY=https://staging.example.tld pi
```

---

## Troubleshooting

**Footer says `🟡 relay waiting for pairing` even though I paired a device.**
The icon reflects whether *any* device has been paired on this machine, not
whether one is connected right now. If you really have a paired device in
`/remote-pi devices`, restart Pi — the cache may be stale (fixed in current
release; report a bug if it recurs).

**Mobile app times out connecting.** Verify the same relay URL is configured
on both sides. If you self-host behind a VPN, your phone must also be on the
VPN (Tailscale on iOS/Android works fine).

**`agent_request` keeps timing out.** Default timeout is 30 s. For tasks
that legitimately take longer, the receiver should reply with `agent_send`
including `re: "<original-id>"` so the requester can correlate. The skill
explains this to the LLM automatically.

**Multiple terminals in the same directory.** Supported. They share the same
agent-network session (UDS broker) and the relay handles each Pi process
independently. If the relay refuses with `RoomAlreadyOpenError`, stop the
other terminal first.

---

## Branding

Official brand assets live in
[`/branding`](https://github.com/jacobaraujo7/remote_pi/tree/main/branding) —
SVG sources for the logo (full, foreground, background, monochrome) plus a
banner. See the
[branding README](https://github.com/jacobaraujo7/remote_pi/blob/main/branding/README.md)
for palette and export sizes.

<table>
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/branding/logo-full.svg" width="96" alt="logo-full" /><br/>
      <sub><code>logo-full</code></sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/branding/logo-foreground.svg" width="96" alt="logo-foreground" /><br/>
      <sub><code>logo-foreground</code></sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/branding/logo-monochrome.svg" width="96" alt="logo-monochrome" /><br/>
      <sub><code>logo-monochrome</code></sub>
    </td>
  </tr>
</table>

---

## Links

- Homepage: <https://remote-pi.jacobmoura.work>
- Source: <https://github.com/jacobaraujo7/remote_pi>
- Pi coding agent: <https://github.com/earendil-works/pi>
- Relay (self-hosting guide): <https://github.com/jacobaraujo7/remote_pi/blob/main/relay/README.md>
- Issues / bugs: <https://github.com/jacobaraujo7/remote_pi/issues>

---

## License

MIT
