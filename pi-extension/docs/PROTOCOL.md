# Remote Pi paired-client protocol

This package-visible document describes the public `remote-pi/client` surface and
the lifecycle messages it supports. It is intentionally limited to authenticated
paired-owner actions; it does not expose extension routers, singleton state,
profile readers, private keys, or testing adapters.

## Public Node client

```ts
import { PairedClient } from "remote-pi/client";

const client = await PairedClient.connect({
  relayUrl: "http://127.0.0.1:8787",
  pairingUri, // `remotepi://pair?...` emitted by /remote-pi pair
  deviceName: "ephemeral automation",
});
const paired = await client.pair(); // require pair_ok before actions
if (paired.type !== "pair_ok") throw new Error(paired.code);
const status = await client.lifecycleStatus();
client.onLifecycleOutcome((outcome) => { /* terminal compact evidence */ });
const compact = await client.compact();
```

The facade creates an in-memory Ed25519 identity unless an identity returned by
`createEphemeralClientIdentity()` is supplied. It completes relay
`hello → challenge → auth`, sends `pair_request` to the exact URI room, and
requires a correlated `pair_ok`. The URI token is consumed once and is not
persisted. Supply the relay URL separately; `http(s)` is converted to `ws(s)`.
Do not log pairing URIs, tokens, private key material, or full peer identifiers.

A relay-authenticated peer is not an owner until pairing succeeds. Requests from
an unpaired peer receive the correlated `error` code `unknown_peer`. Every
public call is correlated by generated request id. `onLifecycleOutcome` receives
unsolicited terminal compact results, which are distinct from `action_ok` or
`action_error` admission replies.

## Lifecycle wire schema

All three requests travel as base64 JSON in the relay outer envelope after
pairing. The relay authenticates and routes peers but does not authorize
lifecycle actions or inspect lifecycle bodies.

```jsonc
{ "type": "lifecycle_status", "id": "<uuid>" }
{
  "type": "lifecycle_status", "in_reply_to": "<uuid>",
  "snapshot": {
    "registry_state": "unavailable" | "ready" | "disposing" | "incompatible",
    "sequence": 42,
    "session_id": "<optional>", "generation_id": "<optional>",
    "phase": "idle" | "pending-settle" | "observed-preflight" | "compacting" |
             "resuming" | "releasing" | "blocked-unknown",
    "operation_id": "<optional>",
    "reason": "self" | "remote" | "builtin" | "threshold" | "overflow",
    "last_outcome": "completed" | "failed" | "cancelled" | "timed-out"
  },
  "diagnostics": [{ "sequence": 42, "timestamp": 0, "code": "<redacted>",
    "operation_id": "<optional>", "phase": "<optional>", "outcome": "<optional>" }]
}

{ "type": "session_compact", "id": "<uuid>" }
{ "type": "action_ok", "in_reply_to": "<uuid>", "action": "session_compact",
  "disposition": "accepted" | "joined", "operation_id": "<optional>",
  "generation_id": "<optional>" }
{ "type": "lifecycle_outcome", "operation_id": "<id>", "session_id": "<id>",
  "generation_id": "<id>", "outcome": "completed" | "failed" | "cancelled" | "blocked",
  "code": "<optional redacted code>" }

{ "type": "lifecycle_repair", "id": "<uuid>",
  "action": "recognize-resume-admitted" | "retry-resume-pending" |
            "abandon-ambiguous-resume" | "retry-blocked-drainer" |
            "abandon-interrupted-operation",
  "operation_id": "<id>", "session_id": "<id>", "generation_id": "<id>",
  "expected_phase": "blocked-unknown", "expected_sequence": 41,
  "evidence_class": "persisted-resume-message" | "persisted-resume-run-settled" |
                    "no-admission-attempt" | "current-process-quiescent" |
                    "owner-process-replaced" | "idempotent-drainer-state" |
                    "branch-validated-owner-replaced",
  "consumer_id": "<optional>", "lane_id": "<optional>", "evidence_entry_id": "<optional>" }
{ "type": "lifecycle_repair", "in_reply_to": "<uuid>",
  "disposition": "applied" | "rejected", "action": "<applied only>",
  "operation_id": "<applied only>", "generation_id": "<optional>",
  "sequence": 42, "code": "<rejected only>" }
```

`lifecycle_status` returns redacted metadata only: no held consumer body,
prompts, credential material, profile path, or diagnostic body. IDs may be
present because the owner needs them to construct a repair, but receipts should
retain only presence/relations rather than values.

## CAS and rejection semantics

`lifecycle_repair` has no client-side override. The lifecycle authority checks
all mandatory session, generation, operation, phase, evidence, actor
(`operator`), and channel (`remote`) predicates. It compares
`expected_sequence` first. When a sequence captured from an earlier snapshot is
stale, the reply is:

```json
{ "type": "lifecycle_repair", "disposition": "rejected",
  "code": "snapshot-sequence-mismatch", "sequence": 42 }
```

The returned sequence is the current one. Read a fresh status before proposing a
new repair; never guess a sequence or treat compact admission as terminal
success. A correct compact proof waits for the correlated `lifecycle_outcome`.

## Redaction and receipt safety

Never retain pairing URI/token, identities/keys, full identifiers, profile paths,
prompt or consumer bodies, credentials, or diagnostic bodies. Safe receipt data
is message type/order, a boolean that correlation occurred, redacted disposition
or code, lifecycle outcome, and `old < current` sequence relation.
