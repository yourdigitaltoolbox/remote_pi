import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createConnection } from "node:net";
import { ipcAddress } from "./ipc.js";
import { SessionPeer } from "./peer.js";
import type { Envelope } from "./envelope.js";
import { probeListPeers } from "../index.js";
import { composeAddress, sanitizeMeshName, type PeerInfo } from "./broker.js";
import { migrateAgentName } from "./local_config.js";

function tmpSock(): string {
  // Per-test unique IPC address. POSIX → a `.sock` file in a fresh tmpdir;
  // Windows → a named pipe whose name embeds the unique tmpdir basename
  // (pipes are machine-global, so the suffix must be unique — plan/40).
  const dir = mkdtempSync(join(tmpdir(), "pi-e2e-"));
  return ipcAddress(`e2e-${basename(dir)}`, join(dir, "broker.sock"));
}

async function makePeer(
  sockPath: string,
  name: string,
  auditPath?: string,
  identity?: { workspaceId: string; agentId: string; processEpoch: string },
  cwd?: string,
): Promise<SessionPeer> {
  const peer = new SessionPeer({ sockPath, name, auditPath, defaultTimeoutMs: 3000, identity, cwd });
  await peer.start();
  return peer;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await wait(10);
  }
}

async function runnerRpcBatch(sockPath: string, requests: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: sockPath });
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("runner RPC batch timed out"));
    }, 1_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(requests.map((request) => JSON.stringify(request)).join("\n") + "\n"));
    socket.on("data", (chunk: string) => { buffer += chunk; });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(buffer.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function runnerRpc(sockPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: sockPath });
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("runner RPC timed out"));
    }, 1_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("agent-network e2e", () => {
  test("1) single agent join — peer alone with itself as leader", async () => {
    const sock = tmpSock();
    const p = await makePeer(sock, "solo");
    expect(p.name()).toBe("solo");
    expect(p.currentRole()).toBe("leader");
    await p.leave();
  });

  test("2) two agents request/reply — orq.request(backend) → pong", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const backend = await makePeer(sock, "backend");

    // backend replies to any inbound message
    backend.onMessage((env: Envelope) => {
      void backend.send(env.from, { reply_to: env.id, status: "ok", text: "pong" })
        .then(() => undefined)
        .catch(() => undefined);
      // Use proper request/reply pattern: respond with `re = env.id`.
      const reply = { type: "reply", original_id: env.id, text: "pong" };
      void (async () => {
        const { envelope, serialize } = await import("./envelope.js");
        // not actually used; we send directly via send() above which is fire-and-forget
        void envelope; void serialize; void reply;
      })();
    });

    // Skip the convenience handler approach — backend uses send() to reply.
    // For proper request/reply correlation we instead use a tailored handler:
    // (rewrite below)
    backend.onMessage(() => { /* no-op (already handled above) */ });

    // Approach: orq.request and backend's handler must emit a reply with re=id.
    // The handler above used backend.send which doesn't include `re`. Switch to
    // a low-level approach by re-creating backend's handler:
    await backend.leave();
    const backend2 = await makePeer(sock, "backend");
    backend2.onMessage(async (env) => {
      // Reply with re=env.id so orq's request() resolves.
      const { envelope, serialize } = await import("./envelope.js");
      const reply = envelope(backend2.name(), env.from, { ok: true, text: "pong" }, env.id);
      // Internal: write via the peer's send() with correlation — extend API.
      // SessionPeer doesn't expose direct reply; emulate with raw socket access.
      // Cleanest: add a `reply()` helper. For now, fake via private socket.
      const sockets = (backend2 as unknown as { socket: import("node:net").Socket | null }).socket;
      if (sockets) sockets.write(serialize(reply));
    });

    const result = await orq.request("backend", { text: "ping" }, 2000);
    expect((result.body as { ok: boolean }).ok).toBe(true);
    expect((result.body as { text: string }).text).toBe("pong");
    expect(result.re).toBeTruthy();

    await orq.leave();
    await backend2.leave();
  });

  test("3) parallel wave — Promise.all([req(be), req(fe)]) — both respond", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const be = await makePeer(sock, "be");
    const fe = await makePeer(sock, "fe");

    async function autoReply(p: SessionPeer, replyText: string) {
      p.onMessage(async (env) => {
        if (env.re !== null) return;  // skip replies
        const { envelope, serialize } = await import("./envelope.js");
        const env2 = envelope(p.name(), env.from, { text: replyText }, env.id);
        const s = (p as unknown as { socket: import("node:net").Socket | null }).socket;
        if (s) s.write(serialize(env2));
      });
    }
    await autoReply(be, "be-pong");
    await autoReply(fe, "fe-pong");

    const [r1, r2] = await Promise.all([
      orq.request("be", { q: "x" }, 2000),
      orq.request("fe", { q: "y" }, 2000),
    ]);
    expect((r1.body as { text: string }).text).toBe("be-pong");
    expect((r2.body as { text: string }).text).toBe("fe-pong");

    await orq.leave();
    await be.leave();
    await fe.leave();
  });

  test("6) name collision → auto-suffix #N", async () => {
    const sock = tmpSock();
    const p1 = await makePeer(sock, "backend");
    const p2 = await makePeer(sock, "backend");
    const p3 = await makePeer(sock, "backend");
    expect(p1.name()).toBe("backend");
    expect(p2.name()).toBe("backend#2");
    expect(p3.name()).toBe("backend#3");
    await p1.leave();
    await p2.leave();
    await p3.leave();
  });

  test("broadcast: msg pra todos exceto sender", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const a = await makePeer(sock, "a");
    const b = await makePeer(sock, "b");

    const inboxA: Envelope[] = [];
    const inboxB: Envelope[] = [];
    a.onMessage((e) => { if (typeof e.body === "object" && e.body && (e.body as { type?: string }).type !== "peer_joined" && (e.body as { type?: string }).type !== "peer_left") inboxA.push(e); });
    b.onMessage((e) => { if (typeof e.body === "object" && e.body && (e.body as { type?: string }).type !== "peer_joined" && (e.body as { type?: string }).type !== "peer_left") inboxB.push(e); });

    await orq.send("broadcast", { hello: "world" });
    await new Promise((r) => setTimeout(r, 100));

    expect(inboxA.length).toBe(1);
    expect(inboxB.length).toBe(1);
    expect((inboxA[0]!.body as { hello: string }).hello).toBe("world");

    await orq.leave(); await a.leave(); await b.leave();
  });
});

describe("ACK protocol (plan/25 Wave 0)", () => {
  test("sendWithAck to idle peer → status=received, synchronously (not an LLM turn)", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const backend = await makePeer(sock, "backend");

    const t0 = Date.now();
    const ack = await orq.sendWithAck("backend", { task: "ping" });
    const dt = Date.now() - t0;

    expect(ack.status).toBe("received");
    expect(ack.target).toBe("backend");
    // The broker ACK is synchronous — it must NOT block on the peer taking a
    // turn. A generous ceiling proves "immediate, not a turn" without flaking
    // under CI/load (this used to be 200ms and broke `prepublishOnly`).
    expect(dt).toBeLessThan(2_000);

    await orq.leave(); await backend.leave();
  });

  test("plan/34: send to mid-turn peer is delivered, not dropped → status=received", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const backend = await makePeer(sock, "backend");

    // Even if backend announces it is mid-turn (legacy turn_state — now a
    // no-op at the broker), the message must still be delivered.
    await backend.send("broker", { type: "turn_state", busy: true });
    await new Promise((r) => setTimeout(r, 50));

    const backendInbox: Envelope[] = [];
    backend.onMessage((env) => {
      const body = env.body as { type?: string } | null;
      if (env.from === "broker") return;
      if (body && (body.type === "peer_joined" || body.type === "peer_left")) return;
      backendInbox.push(env);
    });

    const ack = await orq.sendWithAck("backend", { task: "ping-while-busy" });

    expect(ack.status).toBe("received");
    expect(ack.target).toBe("backend");

    // The envelope reached the peer — reliable delivery, no drop.
    await new Promise((r) => setTimeout(r, 50));
    expect(backendInbox.length).toBe(1);

    await orq.leave(); await backend.leave();
  });

  test("plan/34: back-to-back new-work sends both deliver (no busy-on-delivery)", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const backend = await makePeer(sock, "backend");

    const backendInbox: Envelope[] = [];
    backend.onMessage((env) => {
      const body = env.body as { type?: string } | null;
      if (env.from === "broker") return;
      if (body && (body.type === "peer_joined" || body.type === "peer_left")) return;
      backendInbox.push(env);
    });

    // First send → received.
    const ack1 = await orq.sendWithAck("backend", { task: "t1" });
    expect(ack1.status).toBe("received");

    // Second send, before any turn_end: previously this returned `busy`
    // (received = commitment). plan/34 removed that — it must also deliver.
    const ack2 = await orq.sendWithAck("backend", { task: "t2" });
    expect(ack2.status).toBe("received");

    await new Promise((r) => setTimeout(r, 50));
    expect(backendInbox.length).toBe(2);

    await orq.leave(); await backend.leave();
  });

  test("reply via send with re=<original> arrives in sender inbox (async pattern)", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const backend = await makePeer(sock, "backend");

    // Orq's inbox collects replies (skip broker control / peer events).
    const orqInbox: Envelope[] = [];
    orq.onMessage((env) => {
      if (env.from === "broker") return;
      orqInbox.push(env);
    });

    // Backend auto-replies once it sees a task, marking itself busy/idle
    // around its "turn".
    backend.onMessage(async (env) => {
      if (env.from === "broker") return;
      // simulate turn lifecycle
      await backend.send("broker", { type: "turn_state", busy: true });
      // do "work" then reply via send (not sendWithAck — broadcast-style reply)
      await backend.sendWithAck(env.from, { answer: 42 }, env.id);
      await backend.send("broker", { type: "turn_state", busy: false });
    });

    const ack = await orq.sendWithAck("backend", { question: "meaning?" });
    expect(ack.status).toBe("received");

    // wait for the async reply to round-trip
    await new Promise((r) => setTimeout(r, 200));

    expect(orqInbox.length).toBeGreaterThan(0);
    const reply = orqInbox.find((e) => e.from === "backend");
    expect(reply).toBeDefined();
    expect(reply!.re).toBe(ack.id);
    expect((reply!.body as { answer: number }).answer).toBe(42);

    await orq.leave(); await backend.leave();
  });

  test("sendWithAck resolves on cross-PC ACK (from=<pc>:broker)", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const broker = orq.localBroker()!;

    // Kick off a sendWithAck that points to an unknown local target — without
    // a sibling router the broker would silently drop. We want the ACK to
    // come from a fake cross-PC broker, simulating broker_remote on Pi-B
    // sending an ACK back via the relay → broker_remote on Pi-A → the local
    // UDS broker (injectFromRemote injects the ACK envelope into the sender's
    // socket).
    const pendingAck = orq.sendWithAck("trab:agent-1", { task: "ping" }, null, 1500);
    // Give the outbound write time to register in ackPending before injecting.
    await new Promise((r) => setTimeout(r, 30));

    // Locate the original send's id by inspecting ackPending — but it's
    // private. Instead, capture the outbound envelope id by sniffing the
    // last write on orq's socket. Simpler approach: peek via a wrapper.
    // We just attach a no-op onMessage to ensure the envelope is delivered
    // and assume the most recent uuid in ackPending is ours. Cleaner: use
    // sendWithAck's return type's `id` after resolution. Since we need
    // the id BEFORE resolution, take the path of injecting via broker:
    const ackPendingMap = (orq as unknown as { ackPending: Map<string, unknown> }).ackPending;
    const outboundId = [...ackPendingMap.keys()][0]!;

    const crossPcAck: Envelope = {
      from: "casa:broker",
      to: "orq",
      id: "01976000-0000-7000-8000-aaaaaaaaaaab",
      re: outboundId,
      body: { type: "ack", status: "received", target: "agent-1" },
    };
    expect(broker.injectFromRemote(crossPcAck)).toBe("received");

    const result = await pendingAck;
    expect(result.status).toBe("received");
    expect(result.target).toBe("agent-1");

    await orq.leave();
  });

  test("plan/34: injectFromRemote delivers new work and replies alike (no busy)", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const backend = await makePeer(sock, "backend");

    // Even if backend announced mid-turn (now a no-op at the broker), cross-PC
    // injection must deliver.
    await backend.send("broker", { type: "turn_state", busy: true });
    await new Promise((r) => setTimeout(r, 50));

    const leader = orq.currentRole() === "leader" ? orq : backend;
    const broker = leader.localBroker()!;
    expect(broker).toBeTruthy();

    const backendInbox: Envelope[] = [];
    backend.onMessage((env) => {
      if (env.from === "broker") return;
      backendInbox.push(env);
    });

    // New work (re=null) — delivered, not dropped.
    const newWork = {
      from: "casa:sess-3", to: "backend", id: "01976000-0000-7000-8000-000000000001",
      re: null, body: { task: "do thing" },
    };
    expect(broker.injectFromRemote(newWork)).toBe("received");

    // A reply (re set) — same outcome.
    const reply = {
      from: "casa:sess-3", to: "backend", id: "01976000-0000-7000-8000-000000000002",
      re: "01976000-0000-7000-8000-000000000003", body: { answer: 42 },
    };
    expect(broker.injectFromRemote(reply)).toBe("received");

    await new Promise((r) => setTimeout(r, 50));
    expect(backendInbox.length).toBe(2);

    await orq.leave(); await backend.leave();
  });

  test("injectFromRemote: unknown local peer → denied", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const broker = orq.localBroker()!;

    const env = {
      from: "casa:sess-3", to: "no-such-peer", id: "01976000-0000-7000-8000-000000000004",
      re: null, body: { x: 1 },
    };
    expect(broker.injectFromRemote(env)).toBe("denied");

    await orq.leave();
  });

  test("Broker.list_peers includes RemoteRouter.listRemotePeers", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const broker = orq.localBroker()!;

    broker.setRemoteRouter({
      tryRouteOutbound: () => false,
      listRemotePeers: () => ["trab:agent-1", "movel:agent-2"],
      listRemotePeerInfos: () => [],
    });

    const reply = await orq.request("broker", { type: "list_peers" }, 1000);
    const peers = (reply.body as { peers: string[] }).peers;
    expect(peers).toContain("orq");
    expect(peers).toContain("trab:agent-1");
    expect(peers).toContain("movel:agent-2");

    broker.setRemoteRouter(null);
    await orq.leave();
  });

  test("Broker.list_peers surfaces remote peers_detailed with pc (plan/38 Fase 2)", async () => {
    const sock = tmpSock();
    const orq = new SessionPeer({ sockPath: sock, name: "orq", cwd: "/w/orq", defaultTimeoutMs: 3000 });
    await orq.start();
    const broker = orq.localBroker()!;

    broker.setRemoteRouter({
      tryRouteOutbound: () => false,
      listRemotePeers: () => ["casa:/w/api@api"],
      listRemotePeerInfos: () => [
        { pc: "casa", cwd: "/w/api", name: "api", address: "casa:/w/api@api" },
      ],
    });

    const reply = await orq.request("broker", { type: "list_peers" }, 1000);
    const body = reply.body as { peers: string[]; peers_detailed: Array<{ pc?: string; cwd: string; name: string; address: string }> };

    // Legacy `peers` field still carries the prefixed address.
    expect(body.peers).toContain("casa:/w/api@api");
    // Local self has no pc; the remote entry carries pc="casa", real cwd/name.
    expect(body.peers_detailed).toEqual(expect.arrayContaining([
      expect.objectContaining({ cwd: "/w/orq", name: "orq", address: "/w/orq@orq" }),  // local, no pc
      { pc: "casa", cwd: "/w/api", name: "api", address: "casa:/w/api@api" },           // remote, pc filled
    ]));
    const localEntry = body.peers_detailed.find((p) => p.address === "/w/orq@orq");
    expect(localEntry!.pc).toBeUndefined();

    broker.setRemoteRouter(null);
    await orq.leave();
  });

  test("Broker._route delegates to RemoteRouter for prefix-addressed envelopes", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const broker = orq.localBroker()!;

    const claimed: Envelope[] = [];
    broker.setRemoteRouter({
      tryRouteOutbound: (env) => { claimed.push(env); return true; },
      listRemotePeers: () => [],
      listRemotePeerInfos: () => [],
    });

    await orq.send("trab:agent-1", { hello: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(claimed.length).toBe(1);
    expect(claimed[0]!.to).toBe("trab:agent-1");

    broker.setRemoteRouter(null);
    await orq.leave();
  });

  test("audit.jsonl tags envelopes with via=uds for local routing", async () => {
    const sock = tmpSock();
    const auditDir = mkdtempSync(join(tmpdir(), "pi-audit-"));
    const audit = join(auditDir, "audit.jsonl");
    const orq = await makePeer(sock, "orq", audit);
    const backend = await makePeer(sock, "backend", audit);

    await orq.sendWithAck("backend", { task: "ping" });
    // Audit writes are async + best-effort; give them a tick.
    await wait(40);

    const lines = readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    // Skip any peer-discovery / broker-control lines; find the unicast.
    const uds = lines.find((r) => r.from === "orq" && r.to === "backend");
    expect(uds).toBeDefined();
    expect(uds.via).toBe("uds");
    expect(uds.ack_status).toBe("received");

    await orq.leave(); await backend.leave();
  });

  test("audit.jsonl tags injectFromRemote envelopes with via=relay", async () => {
    const sock = tmpSock();
    const auditDir = mkdtempSync(join(tmpdir(), "pi-audit-"));
    const audit = join(auditDir, "audit.jsonl");
    const orq = await makePeer(sock, "orq", audit);
    const broker = orq.localBroker()!;

    const env = {
      from: "casa:sess-3", to: "orq", id: "01976000-0000-7000-8000-aaaaaaaaaaac",
      re: null, body: { task: "remote ping" },
    };
    expect(broker.injectFromRemote(env)).toBe("received");
    await wait(40);

    const lines = readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const relayLine = lines.find((r) => r.id === env.id);
    expect(relayLine).toBeDefined();
    expect(relayLine.via).toBe("relay");
    expect(relayLine.ack_status).toBe("received");

    await orq.leave();
  });

  test("no ACK for broadcast (multi-target, no authoritative recipient)", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const a = await makePeer(sock, "a");
    const b = await makePeer(sock, "b");

    // We expose ackPending behavior indirectly: if broker ACKed broadcasts,
    // we'd see the ack envelope in handlers. Sniff for it.
    const orqInbox: Envelope[] = [];
    orq.onMessage((env) => {
      if (env.from === "broker") orqInbox.push(env);
    });

    await orq.send("broadcast", { hello: "hi" });
    await new Promise((r) => setTimeout(r, 100));

    // No ack envelopes (only peer_joined/peer_left, which we filter below)
    const ackMessages = orqInbox.filter((e) => {
      const b = e.body as { type?: string } | null;
      return !!b && b.type === "ack";
    });
    expect(ackMessages.length).toBe(0);

    await orq.leave(); await a.leave(); await b.leave();
  });

  // ── `remote-pi peers` observer probe (read-only roster) ─────────────────────

  test("unregistered list_peers probe returns the roster without joining", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const backend = await makePeer(sock, "backend");
    const broker = orq.localBroker()!;
    broker.setRemoteRouter({
      tryRouteOutbound: () => false,
      listRemotePeers: () => ["casa:sess-9"],
      listRemotePeerInfos: () => [],
    });

    // Sniff anything the registered peers receive, so we can prove the probe
    // produced no peer_joined / peer_left noise on the mesh. Flush the genuine
    // backend-join broadcast first so only probe-induced traffic remains.
    const orqSystem: Envelope[] = [];
    orq.onMessage((env) => { if (env.from === "broker") orqSystem.push(env); });
    await wait(50);
    orqSystem.length = 0;

    const reply = await new Promise<Envelope>((resolve, reject) => {
      const probe = createConnection({ path: sock });
      let buf = "";
      const timer = setTimeout(() => { probe.destroy(); reject(new Error("probe timeout")); }, 2000);
      probe.setEncoding("utf8");
      probe.on("connect", () => probe.write(JSON.stringify({ type: "list_peers" }) + "\n"));
      probe.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        clearTimeout(timer);
        probe.destroy();
        resolve(JSON.parse(buf.slice(0, nl)) as Envelope);
      });
      probe.on("error", reject);
    });

    const peers = (reply.body as { type: string; peers: string[] });
    expect(peers.type).toBe("list_peers_reply");
    expect(peers.peers).toEqual(expect.arrayContaining(["orq", "backend", "casa:sess-9"]));

    // The probe must NOT have registered: roster unchanged, no observer leaked.
    expect(broker.peerNames().sort()).toEqual(["backend", "orq"]);

    // And no peer_joined/peer_left reached the real peers because of the probe.
    await wait(50);
    const joins = orqSystem.filter((e) => {
      const b = e.body as { type?: string } | null;
      return !!b && (b.type === "peer_joined" || b.type === "peer_left");
    });
    expect(joins.length).toBe(0);

    broker.setRemoteRouter(null);
    await orq.leave(); await backend.leave();
  });

  test("probeListPeers returns the roster against a live broker", async () => {
    const sock = tmpSock();
    const orq = await makePeer(sock, "orq");
    const backend = await makePeer(sock, "backend");

    const peers = await probeListPeers(sock);
    expect(peers).not.toBeNull();
    expect(peers!.sort()).toEqual(["backend", "orq"]);

    await orq.leave(); await backend.leave();
  });

  test("probeListPeers resolves null when no broker is listening", async () => {
    const sock = tmpSock();  // fresh path, nothing bound to it
    const peers = await probeListPeers(sock, 500);
    expect(peers).toBeNull();
  });
});

// ── plan/38: address encoder + name migration (pure) ─────────────────────────

describe("plan/38 — address encoder + name migration (pure)", () => {
  test("composeAddress renders [<pc>:]<cwd>@<nome>; cwd-less → name", () => {
    // The render matrix from the plan.
    expect(composeAddress({ cwd: "/Users/jacob/acme/backend", name: "backend" }))
      .toBe("/Users/jacob/acme/backend@backend");
    expect(composeAddress({ cwd: "/Users/jacob/acme/backend", name: "reviewer" }))
      .toBe("/Users/jacob/acme/backend@reviewer");
    expect(composeAddress({ cwd: "/Users/jacob/.wt/feat-login", name: "backend" }))
      .toBe("/Users/jacob/.wt/feat-login@backend");
    expect(composeAddress({ cwd: "/x/backend", name: "backend#2" }))
      .toBe("/x/backend@backend#2");               // collision suffix is part of the name
    expect(composeAddress({ pc: "MacMini", cwd: "/Users/jose/work/acme", name: "app" }))
      .toBe("MacMini:/Users/jose/work/acme@app");   // cross-PC prefix
    expect(composeAddress({ cwd: "", name: "legacy" })).toBe("legacy");  // no cwd → name only
  });

  test("sanitizeMeshName cleans the name but preserves a trailing #N", () => {
    expect(sanitizeMeshName("a/b")).toBe("a-b");          // `/` sanitized
    expect(sanitizeMeshName("two words")).toBe("two-words");  // space sanitized
    expect(sanitizeMeshName("a@b")).toBe("a-b");          // `@` sanitized → address stays unambiguous
    expect(sanitizeMeshName("name#2")).toBe("name#2");    // collision suffix kept
    expect(sanitizeMeshName("a/b#3")).toBe("a-b#3");      // base cleaned, suffix kept
    expect(sanitizeMeshName("broker")).toBe("agent");     // reserved keyword → fallback
  });

  test("migrateAgentName strips a frozen #N and the legacy parent/folder shape", () => {
    expect(migrateAgentName("backend")).toBe("backend");
    expect(migrateAgentName("backend#2")).toBe("backend");       // frozen runtime suffix
    expect(migrateAgentName("Projects/remote_pi")).toBe("remote_pi");  // legacy parent/folder
    expect(migrateAgentName("myapp/backend#3")).toBe("backend");  // both at once
    expect(migrateAgentName("")).toBeUndefined();
    expect(migrateAgentName("#2")).toBeUndefined();
  });
});

// ── plan/38: (cwd, name) mesh addressing (e2e over real UDS) ──────────────────

describe("plan/38 — (cwd, name) mesh addressing (e2e)", () => {
  async function makePeerCwd(sockPath: string, name: string, cwd: string): Promise<SessionPeer> {
    const peer = new SessionPeer({ sockPath, name, cwd, defaultTimeoutMs: 3000 });
    await peer.start();
    return peer;
  }

  test("register with cwd → clean name() + address() = <cwd>@<name>", async () => {
    const sock = tmpSock();
    const p = await makePeerCwd(sock, "backend", "/a/backend");
    expect(p.name()).toBe("backend");
    expect(p.address()).toBe("/a/backend@backend");
    await p.leave();
  });

  test("legacy peer (no cwd) → address() == name() (mixed-mesh compat)", async () => {
    const sock = tmpSock();
    const p = await makePeer(sock, "backend");  // no cwd in register
    expect(p.name()).toBe("backend");
    expect(p.address()).toBe("backend");
    await p.leave();
  });

  test("same name in DIFFERENT folders coexist — no #N, distinct addresses", async () => {
    const sock = tmpSock();
    const a = await makePeerCwd(sock, "backend", "/a/backend");
    const b = await makePeerCwd(sock, "backend", "/b/backend");
    expect(a.name()).toBe("backend");
    expect(b.name()).toBe("backend");                 // NOT backend#2 — different cwd
    expect(a.address()).toBe("/a/backend@backend");
    expect(b.address()).toBe("/b/backend@backend");

    const reply = await a.request("broker", { type: "list_peers" });
    const peers = (reply.body as { peers?: string[] }).peers ?? [];
    expect(peers).toContain("/a/backend@backend");
    expect(peers).toContain("/b/backend@backend");
    await a.leave(); await b.leave();
  });

  test("same name SAME folder → second gets a runtime #2", async () => {
    const sock = tmpSock();
    const a = await makePeerCwd(sock, "backend", "/a/backend");
    const b = await makePeerCwd(sock, "backend", "/a/backend");
    expect(a.name()).toBe("backend");
    expect(b.name()).toBe("backend#2");
    expect(b.address()).toBe("/a/backend@backend#2");
    await a.leave(); await b.leave();
  });

  test("takeoverExisting replaces the same cwd/name instead of creating #2", async () => {
    const sock = tmpSock();
    const first = await makePeerCwd(sock, "backend", "/a/backend");
    const replacement = new SessionPeer({
      sockPath: sock,
      name: "backend",
      cwd: "/a/backend",
      takeoverExisting: true,
      defaultTimeoutMs: 3000,
    });
    await replacement.start();

    expect(replacement.name()).toBe("backend");
    expect(replacement.address()).toBe("/a/backend@backend");

    const reply = await replacement.request("broker", { type: "list_peers" });
    const peers = (reply.body as { peers?: string[] }).peers ?? [];
    expect(peers.filter((p) => p.startsWith("/a/backend@backend"))).toEqual([
      "/a/backend@backend",
    ]);

    await expect(first.send("broadcast", { stale: true })).rejects.toThrow("session peer not connected");
    await first.leave();
    await replacement.leave();
  });

  test("list_peers_reply carries peers_detailed ({cwd,name,address})", async () => {
    const sock = tmpSock();
    const a = await makePeerCwd(sock, "backend", "/a/backend");
    const b = await makePeerCwd(sock, "web", "/a/web");
    const reply = await a.request("broker", { type: "list_peers" });
    const body = reply.body as { peers?: string[]; peers_detailed?: PeerInfo[] };
    expect(body.peers).toEqual(expect.arrayContaining(["/a/backend@backend", "/a/web@web"]));
    expect(body.peers_detailed).toEqual(expect.arrayContaining([
      expect.objectContaining({ cwd: "/a/backend", name: "backend", address: "/a/backend@backend" }),
      expect.objectContaining({ cwd: "/a/web", name: "web", address: "/a/web@web" }),
    ]));
    await a.leave(); await b.leave();
  });

  test("Windows-style local cwd (drive-letter ':') is classified LOCAL, not remote", async () => {
    // plan/38 Fase 2 gap 3: a local address like `C:\proj\app@app` contains a
    // ':' but is NOT cross-PC. The broker tags it with no `pc` in
    // peers_detailed, so the consumer (index.ts) keys on `!pc` instead of a
    // naive `:`-split and counts/pushes it as local.
    const sock = tmpSock();
    const p = await makePeerCwd(sock, "app", "C:\\proj\\app");
    expect(p.address()).toBe("C:\\proj\\app@app");  // contains ':' yet local

    const reply = await p.request("broker", { type: "list_peers" });
    const detailed = (reply.body as { peers_detailed?: Array<{ pc?: string; address: string }> })
      .peers_detailed ?? [];
    const self = detailed.find((e) => e.address === "C:\\proj\\app@app");
    expect(self).toBeDefined();
    expect(self!.pc).toBeUndefined();  // no pc → LOCAL despite the ':'
    await p.leave();
  });

  test("broadcast is scoped to the sender's cwd (folder colleagues only)", async () => {
    const sock = tmpSock();
    const a = await makePeerCwd(sock, "a", "/proj/x");          // sender
    const sameFolder = await makePeerCwd(sock, "b", "/proj/x");
    const otherFolder = await makePeerCwd(sock, "c", "/proj/y");
    const gotSame: Envelope[] = [];
    const gotOther: Envelope[] = [];
    sameFolder.onMessage((e) => { if (e.from !== "broker") gotSame.push(e); });
    otherFolder.onMessage((e) => { if (e.from !== "broker") gotOther.push(e); });

    await a.send("broadcast", { hello: 1 });
    await wait(150);

    expect(gotSame.length).toBe(1);     // same folder hears it
    expect(gotOther.length).toBe(0);    // different folder does NOT
    expect(gotSame[0]!.from).toBe("/proj/x@a");  // from is the sender's address
    await a.leave(); await sameFolder.leave(); await otherFolder.leave();
  });
});

// ── Runtime identity + presentation-only rename ──────────────────────────────

describe("SessionPeer runtime identity", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const identity = (agentId: string, processEpoch: string) => ({ workspaceId, agentId, processEpoch });

  test("distinct logical IDs may share a display name while retaining routable aliases", async () => {
    const sock = tmpSock();
    const first = await makePeer(
      sock,
      "worker",
      undefined,
      identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
      "/workspace",
    );
    const second = await makePeer(
      sock,
      "worker",
      undefined,
      identity("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"),
      "/workspace",
    );

    const firstRoute = `~identity/${workspaceId}/${first.identity()!.agentId}`;
    const secondRoute = `~identity/${workspaceId}/${second.identity()!.agentId}`;
    expect(first.name()).toBe("worker");
    expect(second.name()).toBe("worker");
    expect(first.address()).toBe(firstRoute);
    expect(second.address()).toBe(secondRoute);

    const roster = await first.request("broker", { type: "list_peers" }, 2000);
    const rosterBody = roster.body as { peers: string[]; peers_detailed: PeerInfo[] };
    expect(rosterBody.peers).toEqual([firstRoute, secondRoute]);
    expect(rosterBody.peers).not.toContain("/workspace@worker");
    expect(rosterBody.peers).not.toContain("/workspace@worker#2");
    const detailed = rosterBody.peers_detailed;
    expect(detailed).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: first.identity()!.agentId, name: "worker", address: "/workspace@worker" }),
      expect.objectContaining({ agentId: second.identity()!.agentId, name: "worker", address: "/workspace@worker#2" }),
    ]));
    const secondInfo = detailed.find((peer) => peer.agentId === second.identity()!.agentId)!;
    expect(secondInfo.identityAddress).toBe(`~identity/${workspaceId}/${second.identity()!.agentId}`);
    const received: Envelope[] = [];
    second.onMessage((envelope) => { if (envelope.from !== "broker") received.push(envelope); });
    await first.send(secondInfo.identityAddress!, { stable: true });
    await first.send(secondInfo.address, { compatibilityAlias: true });
    await wait(50);
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ from: firstRoute, to: secondRoute, body: { stable: true } });
    expect(received[1]).toMatchObject({ from: firstRoute, to: "/workspace@worker#2", body: { compatibilityAlias: true } });

    await first.leave();
    await second.leave();
  });

  test("a live canonical identity rejects duplicate epochs instead of replacing state", async () => {
    const sock = tmpSock();
    const first = await makePeer(
      sock,
      "worker",
      undefined,
      identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
      "/workspace",
    );
    const duplicate = new SessionPeer({
      sockPath: sock,
      name: "renamed",
      cwd: "/elsewhere",
      identity: identity("22222222-2222-4222-8222-222222222222", "66666666-6666-4666-8666-666666666666"),
    });

    await expect(duplicate.start()).rejects.toThrow(/duplicate runtime identity/i);
    expect(first.name()).toBe("worker");
    expect(first.address()).toBe(`~identity/${workspaceId}/${first.identity()!.agentId}`);
    await first.leave();
  });

  test("one live workspaceId cannot claim different cwd paths, but may relocate after the old owner leaves", async () => {
    const sock = tmpSock();
    const first = await makePeer(
      sock,
      "first",
      undefined,
      identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
      "/workspace-a",
    );
    const copiedWorkspace = new SessionPeer({
      sockPath: sock,
      name: "copied",
      cwd: "/workspace-b",
      identity: identity("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"),
    });

    await expect(copiedWorkspace.start()).rejects.toThrow(/workspace.*different cwd/i);
    expect(first.address()).toBe(`~identity/${workspaceId}/${first.identity()!.agentId}`);

    await first.leave();
    await wait(50);

    const relocated = await makePeer(
      sock,
      "relocated",
      undefined,
      identity("44444444-4444-4444-8444-444444444444", "66666666-6666-4666-8666-666666666666"),
      "/workspace-b",
    );
    expect(relocated.address()).toBe(`~identity/${workspaceId}/${relocated.identity()!.agentId}`);
    await relocated.leave();
  });

  test("relay lease issuance requires an in-process grant on the exact live parent connection", async () => {
    const sock = tmpSock();
    const parent = await makePeer(
      sock,
      "parent",
      undefined,
      identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
      "/workspace",
    );
    const other = await makePeer(
      sock,
      "other",
      undefined,
      identity("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"),
      "/workspace",
    );
    const child = await makePeer(
      sock,
      "child",
      undefined,
      identity("66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"),
      "/workspace",
    );
    const binding = {
      runId: "run-lease-1",
      workspaceId,
      agentId: child.identity()!.agentId,
      processEpoch: child.identity()!.processEpoch,
      mode: "relay" as const,
    };

    // There is deliberately no wire operation that authorizes a peer. A raw
    // child/peer cannot turn self-asserted identity into parent authority.
    await expect(parent.request("broker", { type: "relay_parent_authorize" }, 50)).rejects.toThrow(/timed out/i);
    const denied = await parent.request("broker", { type: "relay_lease_issue", binding, ttlMs: 30_000 }, 1000);
    expect(denied.body).toEqual({ type: "relay_lease_issue_result", ok: false, reason: "unauthorized_parent" });

    const broker = parent.localBroker()!;
    expect(broker.authorizeRelayParent(parent.address(), { delegationTtlMs: 120_000, maxLeaseTtlMs: 60_000 }))
      .toMatchObject({ ok: true, parent: parent.identity() });

    const unknownIssueField = await parent.request("broker", {
      type: "relay_lease_issue",
      binding,
      ttlMs: 30_000,
      workloadId: "forged",
    }, 1000);
    expect(unknownIssueField.body).toEqual({
      type: "relay_lease_issue_result",
      ok: false,
      reason: "invalid_binding",
    });

    const issuedReply = await parent.request("broker", { type: "relay_lease_issue", binding, ttlMs: 30_000 }, 1000);
    const issuedBody = issuedReply.body as {
      type: string;
      ok: boolean;
      capability?: string;
      lease?: { relayExposureLeaseId: string };
    };
    expect(issuedBody).toMatchObject({ type: "relay_lease_issue_result", ok: true });
    expect(issuedBody.capability).toMatch(/^rpel1\./);
    const duplicateIssue = await parent.request("broker", { type: "relay_lease_issue", binding, ttlMs: 30_000 }, 1000);
    expect(duplicateIssue.body).toMatchObject({
      type: "relay_lease_issue_result",
      ok: false,
      reason: "lease_already_exists",
      lease: { relayExposureLeaseId: issuedBody.lease!.relayExposureLeaseId },
    });

    const copiedAuthority = await other.request("broker", { type: "relay_lease_issue", binding, ttlMs: 30_000 }, 1000);
    expect(copiedAuthority.body).toEqual({ type: "relay_lease_issue_result", ok: false, reason: "unauthorized_parent" });

    const unknownActivationField = await child.request("broker", {
      type: "relay_lease_activate",
      capability: issuedBody.capability,
      runId: binding.runId,
      mode: "relay",
      workloadId: "forged",
    }, 1000);
    expect(unknownActivationField.body).toEqual({
      type: "relay_lease_activate_result",
      ok: false,
      reason: "forged_capability",
    });

    const activated = await child.request("broker", {
      type: "relay_lease_activate",
      capability: issuedBody.capability,
      runId: binding.runId,
      mode: "relay",
    }, 1000);
    expect(activated.body).toMatchObject({
      type: "relay_lease_activate_result",
      ok: true,
      state: "activated",
      lease: { relayExposureLeaseId: issuedBody.lease!.relayExposureLeaseId },
    });
    const duplicate = await child.request("broker", {
      type: "relay_lease_activate",
      capability: issuedBody.capability,
      runId: binding.runId,
      mode: "relay",
    }, 1000);
    expect(duplicate.body).toMatchObject({ ok: true, state: "idempotent" });

    await parent.leave();
    await other.leave();
    await child.leave();
  });

  test("lets a live parent withdraw its own delegation and closes every active child lease", async () => {
    const sock = tmpSock();
    const parent = await makePeer(
      sock,
      "parent-withdraw",
      undefined,
      identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
      "/workspace",
    );
    const child = await makePeer(
      sock,
      "child-withdraw",
      undefined,
      identity("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"),
      "/workspace",
    );
    const notices: Array<Record<string, unknown>> = [];
    child.onMessage((env) => {
      const body = env.body as Record<string, unknown> | null;
      if (body?.["type"] === "relay_lease_closed") notices.push(body);
    });
    const broker = parent.localBroker()!;
    broker.authorizeRelayParent(parent.address(), { delegationTtlMs: 120_000, maxLeaseTtlMs: 60_000 });
    const binding = {
      runId: "run-policy-withdrawal",
      workspaceId,
      agentId: child.identity()!.agentId,
      processEpoch: child.identity()!.processEpoch,
      mode: "relay" as const,
    };
    const promoted = await parent.request("broker", { type: "relay_lease_promote", binding, ttlMs: 30_000 }, 1000);
    expect(promoted.body).toMatchObject({ ok: true, state: "promoted" });
    const leaseId = (promoted.body as { lease: { relayExposureLeaseId: string } }).lease.relayExposureLeaseId;

    const withdrawn = await parent.request("broker", { type: "relay_parent_deauthorize" }, 1000);
    expect(withdrawn.body).toEqual({ type: "relay_parent_deauthorize_result", ok: true });
    await waitFor(() => notices.length === 1);
    expect(notices).toEqual([expect.objectContaining({
      relayExposureLeaseId: leaseId,
      reason: "parent_revoked",
    })]);
    expect((await parent.request("broker", { type: "relay_lease_issue", binding: { ...binding, runId: "after-withdrawal" }, ttlMs: 1_000 }, 1000)).body)
      .toEqual({ type: "relay_lease_issue_result", ok: false, reason: "unauthorized_parent" });

    await child.leave();
    await parent.leave();
  });

  test("workspace policy withdrawal revokes every selected parent route and active child lease", async () => {
    const sock = tmpSock();
    const parentA = await makePeer(sock, "parent-policy-a", undefined, identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"), "/workspace");
    const parentB = await makePeer(sock, "parent-policy-b", undefined, identity("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"), "/workspace");
    const childA = await makePeer(sock, "child-policy-a", undefined, identity("66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"), "/workspace");
    const childB = await makePeer(sock, "child-policy-b", undefined, identity("88888888-8888-4888-8888-888888888888", "99999999-9999-4999-8999-999999999999"), "/workspace");
    const noticesA: Array<Record<string, unknown>> = [];
    const noticesB: Array<Record<string, unknown>> = [];
    childA.onMessage((env) => {
      const body = env.body as Record<string, unknown> | null;
      if (body?.["type"] === "relay_lease_closed") noticesA.push(body);
    });
    childB.onMessage((env) => {
      const body = env.body as Record<string, unknown> | null;
      if (body?.["type"] === "relay_lease_closed") noticesB.push(body);
    });
    const broker = parentA.localBroker()!;
    expect(broker.authorizeRelayParent(parentA.address())).toMatchObject({ ok: true });
    expect(broker.authorizeRelayParent(parentB.address())).toMatchObject({ ok: true });
    const bindingA = { runId: "policy-a", workspaceId, agentId: childA.identity()!.agentId, processEpoch: childA.identity()!.processEpoch, mode: "relay" as const };
    const bindingB = { runId: "policy-b", workspaceId, agentId: childB.identity()!.agentId, processEpoch: childB.identity()!.processEpoch, mode: "relay" as const };
    expect((await parentA.request("broker", { type: "relay_lease_promote", binding: bindingA, ttlMs: 30_000 }, 1000)).body).toMatchObject({ ok: true });
    expect((await parentB.request("broker", { type: "relay_lease_promote", binding: bindingB, ttlMs: 30_000 }, 1000)).body).toMatchObject({ ok: true });

    const withdrawn = await parentA.request("broker", { type: "relay_policy_withdraw" }, 1000);
    expect(withdrawn.body).toEqual({ type: "relay_policy_withdraw_result", ok: true, revokedParents: 2 });
    await waitFor(() => noticesA.length === 1 && noticesB.length === 1);
    expect(noticesA[0]).toMatchObject({ reason: "parent_revoked" });
    expect(noticesB[0]).toMatchObject({ reason: "parent_revoked" });
    expect((await parentB.request("broker", { type: "relay_lease_issue", binding: { ...bindingB, runId: "after-policy-withdraw" }, ttlMs: 1_000 }, 1000)).body)
      .toEqual({ type: "relay_lease_issue_result", ok: false, reason: "unauthorized_parent" });

    await childB.leave();
    await childA.leave();
    await parentB.leave();
    await parentA.leave();
  });

  test("atomically live-promotes and demotes only the exact current child", async () => {
    const sock = tmpSock();
    const parent = await makePeer(
      sock,
      "parent",
      undefined,
      identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
      "/workspace",
    );
    const child = await makePeer(
      sock,
      "child",
      undefined,
      identity("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"),
      "/workspace",
    );
    const notices: Array<Record<string, unknown>> = [];
    child.onMessage((env) => {
      const body = env.body as Record<string, unknown> | null;
      if (body?.["type"] === "relay_lease_promoted" || body?.["type"] === "relay_lease_closed") notices.push(body);
    });
    const broker = parent.localBroker()!;
    broker.authorizeRelayParent(parent.address(), { delegationTtlMs: 120_000, maxLeaseTtlMs: 60_000 });
    const binding = {
      runId: "run-live-promote",
      workspaceId,
      agentId: child.identity()!.agentId,
      processEpoch: child.identity()!.processEpoch,
      mode: "relay" as const,
    };
    const promoted = await parent.request("broker", { type: "relay_lease_promote", binding, ttlMs: 30_000 }, 1000);
    expect(promoted.body).toMatchObject({
      type: "relay_lease_promote_result",
      ok: true,
      state: "promoted",
      lease: { binding },
    });
    expect(JSON.stringify(promoted.body)).not.toContain("rpel1.");
    const leaseId = (promoted.body as { lease: { relayExposureLeaseId: string } }).lease.relayExposureLeaseId;
    await wait(10);
    expect(notices).toEqual([expect.objectContaining({
      type: "relay_lease_promoted",
      version: 1,
      lease: expect.objectContaining({ relayExposureLeaseId: leaseId, binding }),
    })]);

    expect((await parent.request("broker", { type: "relay_lease_promote", binding, ttlMs: 30_000 }, 1000)).body)
      .toMatchObject({ ok: true, state: "idempotent", lease: { relayExposureLeaseId: leaseId } });
    await wait(10);
    expect(notices).toHaveLength(1);
    expect((await parent.request("broker", {
      type: "relay_lease_promote",
      binding: { ...binding, processEpoch: "99999999-9999-4999-8999-999999999999" },
      ttlMs: 30_000,
    }, 1000)).body).toEqual({
      type: "relay_lease_promote_result",
      ok: false,
      reason: "target_epoch_mismatch",
    });

    expect((await parent.request("broker", {
      type: "relay_lease_revoke",
      relayExposureLeaseId: leaseId,
      binding,
    }, 1000)).body).toMatchObject({ ok: true, state: "revoked" });
    await wait(10);
    expect(notices[1]).toMatchObject({
      type: "relay_lease_closed",
      relayExposureLeaseId: leaseId,
      reason: "parent_revoked",
    });
    expect(broker.peerNames()).toContain(child.address());

    await child.leave();
    await parent.leave();
  });

  test("accepts typed close only from the exact active child connection after live promotion", async () => {
    const sock = tmpSock();
    const parent = await makePeer(
      sock,
      "parent-child-close",
      undefined,
      identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
      "/workspace",
    );
    const child = await makePeer(
      sock,
      "child-close",
      undefined,
      identity("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"),
      "/workspace",
    );
    const broker = parent.localBroker()!;
    broker.authorizeRelayParent(parent.address(), { delegationTtlMs: 120_000, maxLeaseTtlMs: 60_000 });
    const binding = {
      runId: "run-child-apply-failure-close",
      workspaceId,
      agentId: child.identity()!.agentId,
      processEpoch: child.identity()!.processEpoch,
      mode: "relay" as const,
    };
    const promoted = await parent.request("broker", { type: "relay_lease_promote", binding, ttlMs: 30_000 }, 1000);
    const leaseId = (promoted.body as { lease: { relayExposureLeaseId: string } }).lease.relayExposureLeaseId;

    expect((await child.request("broker", {
      type: "relay_lease_close",
      relayExposureLeaseId: leaseId,
      binding,
      reason: "controlled_shutdown",
    }, 1000)).body).toMatchObject({
      type: "relay_lease_close_result",
      ok: true,
      state: "closed",
    });
    expect((await parent.request("broker", {
      type: "relay_lease_renew",
      relayExposureLeaseId: leaseId,
      renewalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      binding,
      ttlMs: 30_000,
    }, 1000)).body).toMatchObject({ ok: false, reason: "lease_not_active" });

    await child.leave();
    await parent.leave();
  });

  test("issues and consumes bounded async runner subdelegation only over strict local IPC", async () => {
    const sock = tmpSock();
    const auditPath = join(mkdtempSync(join(tmpdir(), "pi-runner-audit-")), "audit.jsonl");
    const parent = await makePeer(
      sock,
      "runner-parent",
      auditPath,
      identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
      "/workspace",
    );
    const child = await makePeer(
      sock,
      "runner-child",
      undefined,
      identity("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"),
      "/workspace",
    );
    const notices: Array<Record<string, unknown>> = [];
    child.onMessage((env) => {
      const body = env.body as Record<string, unknown> | null;
      if (body?.type === "relay_lease_renewed" || body?.type === "relay_lease_closed") notices.push(body);
    });
    parent.localBroker()!.authorizeRelayParent(parent.address(), { delegationTtlMs: 120_000, maxLeaseTtlMs: 60_000 });
    expect((await child.request("broker", {
      type: "relay_runner_delegate",
      version: 1,
      rootRunId: "run-async",
      workspaceId,
      delegationTtlMs: 60_000,
      maxLeaseTtlMs: 30_000,
      maxChildIssues: 2,
    }, 1000)).body).toMatchObject({ ok: false, reason: "unauthorized_parent" });
    const oneShotDelegated = (await parent.request("broker", {
      type: "relay_runner_delegate",
      version: 1,
      rootRunId: "run-one-shot",
      workspaceId,
      delegationTtlMs: 60_000,
      maxLeaseTtlMs: 30_000,
      maxChildIssues: 1,
    }, 1000)).body as { token: string };
    const batchRequestId = "20202020-2020-4020-8020-202020202020";
    expect(await runnerRpcBatch(sock, [{
      type: "relay_runner_issue",
      version: 1,
      requestId: batchRequestId,
      token: oneShotDelegated.token,
      binding: {
        runId: "run-one-shot",
        workspaceId,
        agentId: child.identity()!.agentId,
        processEpoch: child.identity()!.processEpoch,
        mode: "relay",
      },
      ttlMs: 10_000,
      workloadId: "forged",
    }, {
      type: "relay_runner_release",
      version: 1,
      requestId: "21212121-2121-4121-8121-212121212121",
      token: oneShotDelegated.token,
    }])).toEqual([{ type: "relay_runner_result", version: 1, requestId: batchRequestId, ok: false, reason: "invalid_request" }]);
    expect(await runnerRpc(sock, {
      type: "relay_runner_release",
      version: 1,
      requestId: "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      token: oneShotDelegated.token,
    })).toMatchObject({ ok: true, state: "released" });

    const delegated = (await parent.request("broker", {
      type: "relay_runner_delegate",
      version: 1,
      rootRunId: "run-async",
      workspaceId,
      delegationTtlMs: 60_000,
      maxLeaseTtlMs: 30_000,
      maxChildIssues: 2,
    }, 1000)).body as Record<string, unknown>;
    expect(delegated).toMatchObject({
      type: "relay_runner_delegate_result",
      version: 1,
      ok: true,
      maxLeaseTtlMs: 30_000,
      maxChildIssues: 2,
    });
    const token = delegated.token as string;
    const binding = {
      runId: "run-async",
      workspaceId,
      agentId: child.identity()!.agentId,
      processEpoch: child.identity()!.processEpoch,
      mode: "relay" as const,
    };
    const requestId = "66666666-6666-4666-8666-666666666666";
    expect(await runnerRpc(sock, {
      type: "relay_runner_issue",
      version: 1,
      requestId,
      token,
      binding,
      ttlMs: 20_000,
      workloadId: "forged",
    })).toEqual({ type: "relay_runner_result", version: 1, requestId, ok: false, reason: "invalid_request" });
    const issued = await runnerRpc(sock, {
      type: "relay_runner_issue",
      version: 1,
      requestId,
      token,
      binding,
      ttlMs: 20_000,
    });
    expect(issued).toMatchObject({ type: "relay_runner_result", version: 1, requestId, ok: true, state: "issued", lease: { binding } });
    expect(JSON.stringify(issued)).not.toContain(token);
    const capability = issued.capability as string;
    const leaseId = (issued.lease as { relayExposureLeaseId: string }).relayExposureLeaseId;
    expect((await child.request("broker", {
      type: "relay_lease_activate",
      capability,
      runId: binding.runId,
      mode: "relay",
    }, 1000)).body).toMatchObject({ ok: true, state: "activated" });
    expect(await runnerRpc(sock, {
      type: "relay_runner_renew",
      version: 1,
      requestId: "77777777-7777-4777-8777-777777777777",
      token,
      relayExposureLeaseId: leaseId,
      renewalId: "88888888-8888-4888-8888-888888888888",
      binding,
      ttlMs: 25_000,
    })).toMatchObject({ ok: true, state: "renewed" });
    await wait(10);
    expect(notices).toContainEqual(expect.objectContaining({
      type: "relay_lease_renewed",
      relayExposureLeaseId: leaseId,
      binding,
    }));
    expect(await runnerRpc(sock, {
      type: "relay_runner_close",
      version: 1,
      requestId: "99999999-9999-4999-8999-999999999999",
      token,
      relayExposureLeaseId: leaseId,
      binding,
      reason: "completed",
    })).toMatchObject({ ok: true, state: "closed" });
    await wait(10);
    expect(notices).toContainEqual(expect.objectContaining({
      type: "relay_lease_closed",
      relayExposureLeaseId: leaseId,
      reason: "child_closed",
      closeReason: "completed",
    }));
    expect(await runnerRpc(sock, {
      type: "relay_runner_issue",
      version: 1,
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      token,
      binding: { ...binding, runId: "other-run" },
      ttlMs: 10_000,
    })).toMatchObject({ ok: false, reason: "runner_binding_mismatch", field: "runId" });
    const alternateBinding = {
      ...binding,
      agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      processEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    };
    expect(await runnerRpc(sock, {
      type: "relay_runner_issue",
      version: 1,
      requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      token,
      binding: alternateBinding,
      ttlMs: 10_000,
    })).toMatchObject({ ok: true, state: "issued" });
    expect(await runnerRpc(sock, {
      type: "relay_runner_issue",
      version: 1,
      requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      token,
      binding: {
        ...binding,
        agentId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        processEpoch: "12121212-1212-4212-8212-121212121212",
      },
      ttlMs: 10_000,
    })).toMatchObject({ ok: false, reason: "runner_issue_capacity_exceeded" });
    expect(await runnerRpc(sock, {
      type: "relay_runner_release",
      version: 1,
      requestId: "13131313-1313-4313-8313-131313131313",
      token,
    })).toEqual({
      type: "relay_runner_result",
      version: 1,
      requestId: "13131313-1313-4313-8313-131313131313",
      ok: true,
      state: "released",
    });
    await parent.send(child.address(), { type: "runner_audit_sentinel" });
    await wait(10);
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain('"ack_status":"received"');
    expect(audit).not.toContain(token);

    await child.leave();
    await parent.leave();
  });

  test("invalidates unregistered runner delegation on exact parent disconnect and broker restart", async () => {
    const sock = tmpSock();
    const leader = await makePeer(
      sock,
      "leader",
      undefined,
      identity("14141414-1414-4414-8414-141414141414", "15151515-1515-4515-8515-151515151515"),
      "/workspace",
    );
    const parent = await makePeer(
      sock,
      "parent",
      undefined,
      identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
      "/workspace",
    );
    const replacementParent = await makePeer(
      sock,
      "replacement-parent",
      undefined,
      identity("16161616-1616-4616-8616-161616161616", "17171717-1717-4717-8717-171717171717"),
      "/workspace",
    );
    const child = await makePeer(
      sock,
      "child",
      undefined,
      identity("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"),
      "/workspace",
    );
    const broker = leader.localBroker()!;
    const delegate = async (peer: SessionPeer, rootRunId: string): Promise<string> => {
      const result = (await peer.request("broker", {
        type: "relay_runner_delegate",
        version: 1,
        rootRunId,
        workspaceId,
        delegationTtlMs: 60_000,
        maxLeaseTtlMs: 30_000,
        maxChildIssues: 1,
      }, 1000)).body as { token: string };
      return result.token;
    };
    const invalidIssue = async (token: string, rootRunId: string, requestId: string) => runnerRpc(sock, {
      type: "relay_runner_issue",
      version: 1,
      requestId,
      token,
      binding: {
        runId: rootRunId,
        workspaceId,
        agentId: child.identity()!.agentId,
        processEpoch: child.identity()!.processEpoch,
        mode: "relay",
      },
      ttlMs: 10_000,
    });

    expect(broker.authorizeRelayParent(parent.address(), { delegationTtlMs: 120_000, maxLeaseTtlMs: 60_000 }).ok).toBe(true);
    const disconnectedToken = await delegate(parent, "run-disconnect");
    expect(broker.peerNames()).not.toContain(disconnectedToken);
    await parent.leave();
    await wait(10);
    expect(await invalidIssue(
      disconnectedToken,
      "run-disconnect",
      "18181818-1818-4818-8818-181818181818",
    )).toMatchObject({ ok: false, reason: "invalid_runner_delegation" });

    expect(broker.authorizeRelayParent(replacementParent.address(), { delegationTtlMs: 120_000, maxLeaseTtlMs: 60_000 }).ok).toBe(true);
    const restartToken = await delegate(replacementParent, "run-restart");
    await leader.leave();
    await wait(150);
    expect(await invalidIssue(
      restartToken,
      "run-restart",
      "19191919-1919-4919-8919-191919191919",
    )).toMatchObject({ ok: false, reason: "invalid_runner_delegation" });

    await child.leave();
    await replacementParent.leave();
  });

  test("renews, revokes, closes, and stale-fences one active relay lease", async () => {
    const sock = tmpSock();
    const parent = await makePeer(
      sock,
      "parent",
      undefined,
      identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
      "/workspace",
    );
    const child = await makePeer(
      sock,
      "child",
      undefined,
      identity("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"),
      "/workspace",
    );
    const notices: Array<Record<string, unknown>> = [];
    const renewals: Array<Record<string, unknown>> = [];
    child.onMessage((env) => {
      const body = env.body as Record<string, unknown> | null;
      if (body?.["type"] === "relay_lease_closed") notices.push(body);
      if (body?.["type"] === "relay_lease_renewed") renewals.push(body);
    });
    const broker = parent.localBroker()!;
    expect(broker.authorizeRelayParent(parent.address(), { delegationTtlMs: 120_000, maxLeaseTtlMs: 60_000 }).ok).toBe(true);
    const binding = {
      runId: "run-lifecycle",
      workspaceId,
      agentId: child.identity()!.agentId,
      processEpoch: child.identity()!.processEpoch,
      mode: "relay" as const,
    };
    const issued = await parent.request("broker", { type: "relay_lease_issue", binding, ttlMs: 30_000 }, 1000);
    const issuedBody = issued.body as { capability: string; lease: { relayExposureLeaseId: string } };
    expect((await child.request("broker", {
      type: "relay_lease_activate",
      capability: issuedBody.capability,
      runId: binding.runId,
      mode: "relay",
    }, 1000)).body).toMatchObject({ ok: true, state: "activated" });

    const renewalId = "66666666-6666-4666-8666-666666666666";
    const renewRequest = {
      type: "relay_lease_renew",
      relayExposureLeaseId: issuedBody.lease.relayExposureLeaseId,
      renewalId,
      binding,
      ttlMs: 40_000,
    };
    expect((await parent.request("broker", renewRequest, 1000)).body).toMatchObject({
      type: "relay_lease_renew_result",
      ok: true,
      state: "renewed",
    });
    expect((await parent.request("broker", renewRequest, 1000)).body).toMatchObject({ ok: true, state: "idempotent" });
    await wait(10);
    expect(renewals).toEqual([expect.objectContaining({
      type: "relay_lease_renewed",
      version: 1,
      relayExposureLeaseId: issuedBody.lease.relayExposureLeaseId,
      binding,
    })]);
    expect((await parent.request("broker", { ...renewRequest, task: "secret" }, 1000)).body).toEqual({
      type: "relay_lease_renew_result",
      ok: false,
      reason: "invalid_request",
    });
    expect((await parent.request("broker", {
      ...renewRequest,
      renewalId: "77777777-7777-4777-8777-777777777777",
      binding: { ...binding, processEpoch: "88888888-8888-4888-8888-888888888888" },
    }, 1000)).body).toMatchObject({ ok: false, reason: "binding_mismatch", field: "processEpoch" });

    const revokeRequest = {
      type: "relay_lease_revoke",
      relayExposureLeaseId: issuedBody.lease.relayExposureLeaseId,
      binding,
    };
    expect((await parent.request("broker", revokeRequest, 1000)).body).toMatchObject({ ok: true, state: "revoked" });
    await wait(10);
    expect(notices).toEqual([expect.objectContaining({
      type: "relay_lease_closed",
      version: 1,
      relayExposureLeaseId: issuedBody.lease.relayExposureLeaseId,
      binding,
      reason: "parent_revoked",
    })]);
    expect((await parent.request("broker", revokeRequest, 1000)).body).toMatchObject({ ok: true, state: "idempotent" });
    expect(notices).toHaveLength(1);

    const replacement = await parent.request("broker", { type: "relay_lease_issue", binding, ttlMs: 30_000 }, 1000);
    const replacementBody = replacement.body as { capability: string; lease: { relayExposureLeaseId: string } };
    expect((await child.request("broker", {
      type: "relay_lease_activate",
      capability: replacementBody.capability,
      runId: binding.runId,
      mode: "relay",
    }, 1000)).body).toMatchObject({ ok: true, state: "activated" });
    expect((await parent.request("broker", revokeRequest, 1000)).body).toMatchObject({ ok: true, state: "idempotent" });
    expect((await child.request("broker", {
      type: "relay_lease_activate",
      capability: replacementBody.capability,
      runId: binding.runId,
      mode: "relay",
    }, 1000)).body).toMatchObject({ ok: true, state: "idempotent" });

    expect((await parent.request("broker", {
      type: "relay_lease_close",
      relayExposureLeaseId: replacementBody.lease.relayExposureLeaseId,
      binding,
      reason: "timeout",
    }, 1000)).body).toMatchObject({ ok: true, state: "closed" });
    await wait(10);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatchObject({
      relayExposureLeaseId: replacementBody.lease.relayExposureLeaseId,
      reason: "child_closed",
      closeReason: "timeout",
    });

    await child.leave();
    await parent.leave();
  });

  test("keeps the authoritative later expiry timer after an A/B/A renewal retry", async () => {
    const sock = tmpSock();
    const parent = await makePeer(
      sock,
      "parent",
      undefined,
      identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
      "/workspace",
    );
    const child = await makePeer(
      sock,
      "child",
      undefined,
      identity("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"),
      "/workspace",
    );
    const notices: Array<Record<string, unknown>> = [];
    child.onMessage((env) => {
      const body = env.body as Record<string, unknown> | null;
      if (body?.["type"] === "relay_lease_closed") notices.push(body);
    });
    const broker = parent.localBroker()!;
    broker.authorizeRelayParent(parent.address(), { delegationTtlMs: 5_000, maxLeaseTtlMs: 1_000 });
    const binding = {
      runId: "run-renewal-order",
      workspaceId,
      agentId: child.identity()!.agentId,
      processEpoch: child.identity()!.processEpoch,
      mode: "relay" as const,
    };
    const issued = await parent.request("broker", { type: "relay_lease_issue", binding, ttlMs: 80 }, 1000);
    const issuedBody = issued.body as { capability: string; lease: { relayExposureLeaseId: string } };
    await child.request("broker", {
      type: "relay_lease_activate",
      capability: issuedBody.capability,
      runId: binding.runId,
      mode: "relay",
    }, 1000);

    await wait(10);
    const renewalA = {
      type: "relay_lease_renew",
      relayExposureLeaseId: issuedBody.lease.relayExposureLeaseId,
      renewalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      binding,
      ttlMs: 120,
    };
    expect((await parent.request("broker", renewalA, 1000)).body).toMatchObject({ ok: true, state: "renewed" });
    await wait(10);
    expect((await parent.request("broker", {
      ...renewalA,
      renewalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ttlMs: 180,
    }, 1000)).body).toMatchObject({ ok: true, state: "renewed" });
    expect((await parent.request("broker", renewalA, 1000)).body).toMatchObject({ ok: true, state: "idempotent" });

    await waitFor(() => notices.length === 1);
    expect(notices).toEqual([expect.objectContaining({
      relayExposureLeaseId: issuedBody.lease.relayExposureLeaseId,
      reason: "expired",
    })]);
    await child.leave();
    await parent.leave();
  });

  test("expires an active relay lease and notifies only its exact child", async () => {
    const sock = tmpSock();
    const parent = await makePeer(
      sock,
      "parent",
      undefined,
      identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
      "/workspace",
    );
    const child = await makePeer(
      sock,
      "child",
      undefined,
      identity("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"),
      "/workspace",
    );
    const notices: unknown[] = [];
    child.onMessage((env) => {
      const body = env.body as { type?: string } | null;
      if (body?.type === "relay_lease_closed") notices.push(body);
    });
    const broker = parent.localBroker()!;
    broker.authorizeRelayParent(parent.address(), { delegationTtlMs: 5_000, maxLeaseTtlMs: 1_000 });
    const binding = {
      runId: "run-expiry",
      workspaceId,
      agentId: child.identity()!.agentId,
      processEpoch: child.identity()!.processEpoch,
      mode: "relay" as const,
    };
    const issued = await parent.request("broker", { type: "relay_lease_issue", binding, ttlMs: 40 }, 1000);
    const issuedBody = issued.body as { capability: string; lease: { relayExposureLeaseId: string } };
    await child.request("broker", {
      type: "relay_lease_activate",
      capability: issuedBody.capability,
      runId: binding.runId,
      mode: "relay",
    }, 1000);
    await wait(80);
    expect(notices).toEqual([expect.objectContaining({
      relayExposureLeaseId: issuedBody.lease.relayExposureLeaseId,
      reason: "expired",
    })]);
    await child.leave();
    await parent.leave();
  });

  test("disconnecting a delegated parent revokes its unactivated capabilities", async () => {
    const sock = tmpSock();
    const leader = await makePeer(
      sock,
      "leader",
      undefined,
      identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
      "/workspace",
    );
    const parent = await makePeer(
      sock,
      "parent",
      undefined,
      identity("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"),
      "/workspace",
    );
    const child = await makePeer(
      sock,
      "child",
      undefined,
      identity("66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"),
      "/workspace",
    );
    const broker = leader.localBroker()!;
    expect(broker.authorizeRelayParent(parent.address(), { delegationTtlMs: 120_000, maxLeaseTtlMs: 60_000 }).ok).toBe(true);
    const binding = {
      runId: "run-lease-2",
      workspaceId,
      agentId: child.identity()!.agentId,
      processEpoch: child.identity()!.processEpoch,
      mode: "relay" as const,
    };
    const issued = await parent.request("broker", { type: "relay_lease_issue", binding, ttlMs: 30_000 }, 1000);
    const capability = (issued.body as { capability: string }).capability;
    await parent.leave();
    await wait(25);

    const rejected = await child.request("broker", {
      type: "relay_lease_activate",
      capability,
      runId: binding.runId,
      mode: "relay",
    }, 1000);
    expect(rejected.body).toEqual({ type: "relay_lease_activate_result", ok: false, reason: "revoked_capability" });

    await child.leave();
    await leader.leave();
  });

  test("rename updates presentation metadata without changing canonical identity or route", async () => {
    const sock = tmpSock();
    const first = await makePeer(
      sock,
      "before",
      undefined,
      identity("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
      "/workspace",
    );
    const address = first.address();
    const beforeIdentity = first.identity();

    expect(await first.rename("after")).toBe("after");
    expect(first.name()).toBe("after");
    expect(first.address()).toBe(address);
    expect(first.identity()).toEqual(beforeIdentity);

    const roster = await first.request("broker", { type: "list_peers" }, 2000);
    expect((roster.body as { peers_detailed: PeerInfo[] }).peers_detailed)
      .toContainEqual(expect.objectContaining({
        address: "/workspace@before",
        identityAddress: address,
        name: "after",
        agentId: beforeIdentity!.agentId,
      }));
    await first.leave();
  });
});

// ── Legacy SessionPeer.rename: no duplicate / no ghost ───────────────────────

describe("SessionPeer.rename (live rename)", () => {
  test("renames in place — no `#N` duplicate, no stale old name (single rejoin)", async () => {
    const sock = tmpSock();
    const observer = await makePeer(sock, "observer");  // leader; used to query the roster
    const p = await makePeer(sock, "alice");            // follower we rename
    expect(p.name()).toBe("alice");

    const assigned = await p.rename("bob");
    expect(assigned).toBe("bob");
    // Wait past FAILOVER_RETRY_MS (100ms): the old bug fired a spurious
    // `_onSocketClose` → second `_joinOrLead` → "bob#2" + an orphaned "alice".
    await wait(300);

    const reply = await observer.request("broker", { type: "list_peers" });
    const names = ((reply.body as { peers?: string[] }).peers ?? [])
      .filter((x) => x === "alice" || x.startsWith("bob"));
    expect(names).toEqual(["bob"]);  // exactly one, no ghost "alice", no "bob#2"

    expect(p.name()).toBe("bob");
    await p.leave();
    await observer.leave();
  });
});
