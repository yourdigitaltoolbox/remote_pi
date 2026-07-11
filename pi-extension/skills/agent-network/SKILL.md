---
name: agent-network
description: Use when the remote-pi mesh tools (`list_peers`, `agent_send`, and — on Claude — `get_messages`) are available. Teaches discovery, delivery ACKs, inbox handling, correlated replies, and opaque ID-first routes. Current peers use `~identity/<workspaceId>/<agentId>` (with `<pc>:` cross-PC); legacy cwd/name aliases may still appear. Always echo listed routes verbatim.
---

# Agent Network (remote-pi mesh)

You are connected to the **remote-pi agent mesh**. Other agents — other Claude
sessions, Pi coding agents on this machine, and agents on the Owner's other PCs
(reached through the relay) — can send you messages, and you can send messages
to them.

Read this to the end before acting. The protocol is **event-driven**, not
request/reply. Getting the receive model wrong leaves coordination broken.

**Your tools:** `list_peers` and `agent_send` always. On Claude you also have
`get_messages` (a Pi agent receives messages directly into its turn instead —
see below).

---

## The most important rule: read your inbox every turn

You only ever receive messages addressed to you — the broker filters before
delivery. **If a message arrived, someone wanted your attention. Don't ignore
it.** How a message reaches you depends on your runtime:

- **Claude (MCP):** incoming messages are buffered. **At the start of every
  turn, call `get_messages`** to drain and read them:

  ```
  get_messages()
  → "[2026-05-30T12:00:01Z] from=backend re=<your-id>
     id=<msg-id>
     { "shape": { "sub": "string", "exp": "number" } }"
  ```

  It returns all pending messages and clears the buffer (call once per turn),
  or `(no messages)` when nothing is waiting — that's normal, keep working. A
  channel push (`📨 Message from …`) may nudge you mid-session; still call
  `get_messages` for the full structured payload.

- **Pi:** the runtime delivers each incoming message directly as a new turn
  input the moment it arrives — no polling, no `get_messages`. You'll see it
  prefixed `[agent-network] message from "<peer>" (id=…, re=…)`.

Either way: no wait/sleep/poll-loop. Replies to your own sends arrive on a
**later turn**, never inline.

---

## First thing in a new session: `list_peers`

Before sending anything, find out who's actually online:

```
list_peers()
→ {"route":"~identity/<workspace-id>/<agent-id>","name":"backend","cwd":"/Users/jo/acme/backend","alias":"/Users/jo/acme/backend@backend"}
  {"route":"casa:~identity/<workspace-id>/<agent-id>","name":"api","cwd":"/Users/jo/acme/api","pc":"casa","alias":"casa:/Users/jo/acme/api@api"}
```

Synchronous (resolves in milliseconds — not another agent's turn). Use it:

- At the start of a session, to see what mesh you're in
- Before any `agent_send` whose target is uncertain
- To refresh — peers join and leave over time

**Presence is passive (pull, not push).** A peer joining or leaving does **not**
wake your turn. When your view feels stale, just call `list_peers` again — it's
the authoritative snapshot. Don't expect `peer_joined`/`peer_left` events.

**Each `route` is opaque, not a bare name.** Current peers use immutable
`~identity/<workspaceId>/<agentId>` routes. Cross-PC routes add `<pc>:`.
Legacy peers may still expose `<cwd>@<name>` aliases, but those are compatibility
routes rather than current ownership keys.

Use the separately returned/rendered `name`, `cwd`, and optional `pc` metadata
to choose a peer. Do **not** parse identity UUIDs or derive a route from that
metadata. Two peers may share a display name or cwd and still be distinct.

**Echo `route` VERBATIM into `agent_send` / `agent_request` and as `to` when
replying. NEVER build one by hand.** The broker owns route composition. The
optional `alias` is diagnostic/mixed-version compatibility metadata; prefer
`route`.

You are excluded from the result — no need to filter yourself out.

---

## Anatomy of a message (envelope)

Each message carries: `from`, `to`, `id`, `re`, and `body`.

| Field | Meaning |
|---|---|
| `from` | Sender's broker-owned route. Use it verbatim as `to` when replying. |
| `to` | Your broker-owned route (or `broadcast`, or a list including yours). |
| `id` | Unique id of this message. Echo it as `re` when you reply. |
| `re` | If set, this message is itself a REPLY to an earlier `id` of yours. Otherwise `null`. |
| `body` | Free-form content — string or JSON, sender's choice. |

---

## Sending: `agent_send` returns an ACK status

`agent_send({ to, body, re? })` is how you talk to peers. Every **unicast**
call returns a status telling you what happened at the recipient. **Always
inspect the status — it dictates what to do next.**

| Status | Means | What you do |
|---|---|---|
| `received` | Broker delivered the envelope. Delivery is reliable — even if the peer is mid-turn, its harness enqueues the message for the next turn. | Move on. Any reply arrives later. |
| `denied` | Peer explicitly refused (or no such peer). | Do NOT retry. Report to the user. |
| `timeout` | No ACK (~5s). Transport error — broker down, or peer vanished. | Treat as transient. Retry once after ~10s, then escalate. |

For `to: "broadcast"` (or a name array), there's no single ACK — it's
fire-and-forget (`status: "sent"`).

**Delivery is reliable — no retry-on-busy.** A message sent to a peer that's
mid-turn is still delivered: the peer's harness queues it and processes it on
its upcoming turn. You never need to retry because a peer was busy. `re=<id>`
is purely **correlation** — set it so the recipient (and you) can thread an
answer to a question; it carries no special delivery semantics.

---

## Receiving: replies arrive on a later turn

You **do not block** waiting for a reply. The model is event-driven:

1. You call `agent_send` → status `received`.
2. Your turn continues / ends.
3. **Later** the peer finishes its own work and sends a reply.
4. The reply reaches your inbox (via `get_messages` on Claude, or as a new turn
   input on Pi), with `re` set to the `id` you originally sent.

### Walk-through

```
agent_send({ to: "<route copied from list_peers>", body: { q: "what's the JWT shape?" } })
→ Delivered                   # status received; remember the message id
```

Your turn continues. A turn or two later you receive:

```
from=~identity/<workspace-id>/<agent-id> re=<your-id>  id=<new-id>
{ "shape": { "sub": "string", "exp": "number", "roles": ["string"] } }
```

You correlate by `re` — it matches the send you made. Now you have your answer.

---

## Replying to a message

When you receive:

```
from=~identity/<workspace-id>/<agent-id>  id=abc-uuid  re=(none)
{ "task": "Implement POST /auth/login" }
```

Reply with `re` set to that `id`, and `to` set to the sender's `from`:

```
agent_send({
  to: "~identity/<workspace-id>/<agent-id>",
  body: { status: "done", files_changed: [...] },
  re: "abc-uuid"
})
```

Without `re`, the sender gets your message but can't match it to the
question — coordination drifts. **Always echo `re` on a reply.**

---

## Asking multiple peers at once

Fire multiple `agent_send` in one turn — each returns its own ACK. Replies
arrive on future turns as peers finish.

```
agent_send({ to: "<backend route>",  body: { q: "JWT shape?" } })   // received
agent_send({ to: "<frontend route>", body: { q: "theme tokens?" } }) // received
agent_send({ to: "<infra route>",    body: { q: "ETA for Y?" } })    // received
```

Track which `id` maps to which question. Don't assume replies arrive in send
order — use `re` to identify what each reply answers.

---

## Cross-PC routing (`<pc>:<route>`)

When the Owner has paired multiple PCs, remote primary routes add a `<pc>:`
prefix:

```
list_peers() → casa:~identity/<workspace-id>/<agent-id>
```

Send to the returned route verbatim:

```
agent_send({ to: "casa:~identity/<workspace-id>/<agent-id>", body: { ... } })
```

The relay routes it across the mesh; `received | denied | timeout` semantics
are identical to local. When you **reply** to a cross-PC message, use the
sender's `from` verbatim (it already carries the `<pc>:` prefix) as your `to`.
You never prefix your own address — the broker handles that.

Cross-PC failure notes:
- `denied` → the remote broker has no peer at that address (left, or stale cache
  → call `list_peers` again).
- `timeout` → the other PC is offline or the relay is unreachable. The relay
  may also synthesise a `transport_error` reply (`from: "_relay"`,
  `body.type: "transport_error"`) — treat exactly like timeout.

---

## Broadcast and multicast

- `to: "broadcast"` → every other peer **in your folder (same cwd)** — broadcast
  is folder-scoped and local-only (it does NOT cross PCs or reach other folders).
  `to: ["addr1", "addr2"]` → the listed addresses (echo them verbatim).
- Use for announcements ("wave 2 started", "I'm taking the lock on /contracts"),
  never for questions (replies would be uncorrelated).
- Broadcast/multicast skip the ACK — status is `sent`, you don't know who
  received it. For delivery confirmation, use individual unicast sends.

---

## Child relay exposure is not mesh or YDTB authority

A child may be visible on this local mesh while remaining absent from the phone
relay. Do not infer relay permission from a descriptor, route, parent link,
workspace/agent/process ID, runner token, or supervisor request. Child relay
requires operator policy plus a separate bounded live-parent delegation and
process lease; withdrawal, expiry, disconnect, and broker restart fail closed.
These transport records never grant Git, credentials, writer, merge, publish,
deploy, cleanup, or other YDTB/APEX authority.

## When in doubt

- **Received a task you don't understand** → reply with `body.status:"error"`,
  echoing the original `id` in `re`. Don't go silent.
- **Received a `re` you never sent** → late reply to something already wrapped
  up. Ignore. Don't reply to a reply.
- **No messages ever arrive** → normal. You only receive when addressed. Keep
  working; don't poll the broker.
- **`timeout` on send** → broker restarting (failover) or peer vanished. The
  client reconnects transparently in ~500ms; retry once after a beat, then
  escalate.

---

## Legacy: `agent_request` (Pi only, deprecated)

On Pi you may see a tool called `agent_request` that takes a target + body and
**blocks the entire turn** waiting for the peer's content reply. It still
works but emits a deprecation warning. It blocks your turn (costs tokens and
wall time), gives no ACK signal, and pairs badly with parallel multi-peer
questions. **Migrate every `agent_request` to `agent_send`** + reading your
inbox on a later turn. (Claude has no `agent_request` — use `agent_send`.)

---

## Single-page summary

1. **Every turn**: read your inbox first — `get_messages()` on Claude; on Pi
   messages arrive as turn input automatically.
2. **Discover**: `list_peers()` → opaque ID-first routes plus presentation
   metadata; legacy aliases may appear. Echo `route` verbatim, never compose.
   Synchronous, self-excluded; presence is pull-based.
3. **Send**: `agent_send({to, body, re?})` → inspect the status.
4. **Unicast status**: `received | denied | timeout`. Delivery is reliable —
   `received` even if the peer is mid-turn (its harness queues it); abandon on
   `denied`; investigate on `timeout`. No retry-on-busy.
5. **Broadcast/multicast**: status `sent`. Fire-and-forget.
6. **Reply**: set `re` to their `id`, `to` to their `from` (the full route,
   prefix and all). `re` is correlation only.
7. You never receive your own messages.

Re-read when in doubt.

---

## Mini-FAQ

**Q: Can I send a message to myself?**
A: No. `agent_send` refuses early (`status: "refused"`) when `to` matches your
own primary route, and the broker drops unicast self-loops as a second line of
defense.

**Q: What if the peer never replies?**
A: Then you never see a reply. Your send returned `received` (the broker handed
it over); the peer just chose not to answer. There's no implicit timeout on
replies.

**Q: How many sends can I fire in one turn?**
A: No hard limit. But if you fire 10+ unicasts, question whether you should be a
worker (answer narrow) rather than an orchestrator (dispatch wide).

**Q: Is order preserved?**
A: Per-pair, yes — the broker is FIFO. Across pairs, replies arrive whenever the
senders finish. Don't assume reply order matches send order.

**Q: Can `body` be binary?**
A: Not directly. Base64 inside a string if you must. JSON is the intended
payload.
