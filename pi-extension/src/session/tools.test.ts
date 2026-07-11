import { describe, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { registerAgentTools } from "./tools.js";
import { SessionPeer, type AckResult } from "./peer.js";
import { ipcAddress } from "./ipc.js";
import type { Envelope } from "./envelope.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// Captures tools registered via pi.registerTool so we can invoke them directly.
function makeMockPi() {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(t: ToolDefinition) {
      tools.set(t.name, t);
    },
  };
  return { pi: pi as unknown as Parameters<typeof registerAgentTools>[0], tools };
}

function makeMockPeer(
  overrides: Partial<{
    name?: string;
    send: unknown;
    sendWithAck: unknown;
    request: unknown;
  }> = {},
) {
  const myName = overrides.name ?? "orq";
  const { name: _name, ...rest } = overrides;
  return {
    name: () => myName,
    address: () => myName,  // plan/38: tests treat address == name (no cwd)
    send: vi.fn().mockResolvedValue(undefined),
    sendWithAck: vi.fn().mockResolvedValue(
      { status: "received", id: "uuid-out", target: "backend" } satisfies AckResult,
    ),
    request: vi.fn().mockResolvedValue({
      from: "backend", to: "orq", id: "uuid-reply", re: "uuid-orig",
      body: { ok: true, text: "pong" },
    }),
    ...rest,
  } as unknown as SessionPeer;
}

const TOOL_CALL_ID = "tc_test";

function tmpSock(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-tools-e2e-"));
  return ipcAddress(`tools-${basename(dir)}`, join(dir, "broker.sock"));
}

function waitForMessage(peer: SessionPeer): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), 2_000);
    const unsubscribe = peer.onMessage((env) => {
      if (env.from === "broker") return;
      clearTimeout(timer);
      unsubscribe();
      resolve(env);
    });
  });
}

describe("agent_send tool (ACK protocol)", () => {
  test("unicast idle peer → calls sendWithAck, returns status=received", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeMockPeer();
    registerAgentTools(pi, () => peer);
    const tool = tools.get("agent_send")!;

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { task: "ping" } },
      undefined, undefined, {} as never,
    );

    expect(peer.sendWithAck).toHaveBeenCalledWith("backend", { task: "ping" }, null, 5_000);
    expect(result.details).toMatchObject({ status: "received", ok: true, target: "backend" });
  });

  test("plan/34: defensive busy ACK is framed as delivered (no retry-on-busy)", async () => {
    // The broker no longer emits `busy` for new work, but if a stale/legacy
    // ACK arrives, the tool must NOT tell the LLM to retry — it reads as
    // delivered (the peer's harness enqueues mid-turn messages).
    const { pi, tools } = makeMockPi();
    const peer = makeMockPeer({
      sendWithAck: vi.fn().mockResolvedValue(
        { status: "busy", id: "uuid-out", target: "backend" } satisfies AckResult,
      ),
    });
    registerAgentTools(pi, () => peer);
    const tool = tools.get("agent_send")!;

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { x: 1 } },
      undefined, undefined, {} as never,
    );

    expect(
      (result.content[0] as { type: "text"; text: string }).text,
    ).toMatch(/delivered/i);
  });

  test("unicast denied peer → status=denied, ok=false", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeMockPeer({
      sendWithAck: vi.fn().mockResolvedValue(
        { status: "denied", id: "uuid-out", target: "backend" } satisfies AckResult,
      ),
    });
    registerAgentTools(pi, () => peer);
    const tool = tools.get("agent_send")!;

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { x: 1 } },
      undefined, undefined, {} as never,
    );

    expect(result.details).toMatchObject({ status: "denied", ok: false });
  });

  test("unicast timeout → status=timeout, ok=false", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeMockPeer({
      sendWithAck: vi.fn().mockResolvedValue(
        { status: "timeout", id: "uuid-out" } satisfies AckResult,
      ),
    });
    registerAgentTools(pi, () => peer);
    const tool = tools.get("agent_send")!;

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { x: 1 } },
      undefined, undefined, {} as never,
    );

    expect(result.details).toMatchObject({ status: "timeout", ok: false });
  });

  test("forwards `re` for replies (correlation field)", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeMockPeer();
    registerAgentTools(pi, () => peer);
    const tool = tools.get("agent_send")!;

    await tool.execute(
      TOOL_CALL_ID,
      { to: "frontend", body: { answer: "pong" }, re: "01976000-0000-7000-8000-000000000000" },
      undefined, undefined, {} as never,
    );

    expect(peer.sendWithAck).toHaveBeenCalledWith(
      "frontend",
      { answer: "pong" },
      "01976000-0000-7000-8000-000000000000",
      5_000,
    );
  });

  test("broadcast → fire-and-forget, status=sent, uses peer.send not sendWithAck", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeMockPeer();
    registerAgentTools(pi, () => peer);
    const tool = tools.get("agent_send")!;

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "broadcast", body: { announce: "wave-2-started" } },
      undefined, undefined, {} as never,
    );

    expect(peer.send).toHaveBeenCalledWith("broadcast", { announce: "wave-2-started" }, null);
    expect(peer.sendWithAck).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ status: "sent", ok: true });
  });

  test("not in a session → status=refused", async () => {
    const { pi, tools } = makeMockPi();
    registerAgentTools(pi, () => null);
    const tool = tools.get("agent_send")!;

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: "hi" },
      undefined, undefined, {} as never,
    );

    expect(result.details).toMatchObject({
      status: "refused",
      ok: false,
      error: expect.stringContaining("Not in a session"),
    });
  });

  test("body as string passes through intact", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeMockPeer();
    registerAgentTools(pi, () => peer);
    const tool = tools.get("agent_send")!;

    await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: "plain string body" },
      undefined, undefined, {} as never,
    );
    expect(peer.sendWithAck).toHaveBeenCalledWith("backend", "plain string body", null, 5_000);
  });

  test("nested body object passes through intact", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeMockPeer();
    registerAgentTools(pi, () => peer);
    const tool = tools.get("agent_send")!;

    const nested = { a: { b: { c: [1, 2, { d: "x" }] } }, e: null };
    await tool.execute(
      TOOL_CALL_ID,
      { to: "fanout-target", body: nested },
      undefined, undefined, {} as never,
    );
    expect(peer.sendWithAck).toHaveBeenCalledWith("fanout-target", nested, null, 5_000);
  });

  test("self-send refused early → sendWithAck not called", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeMockPeer({ name: "orq" });
    registerAgentTools(pi, () => peer);
    const tool = tools.get("agent_send")!;

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "orq", body: { x: 1 } },
      undefined, undefined, {} as never,
    );

    expect(peer.sendWithAck).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      status: "refused",
      ok: false,
      error: expect.stringContaining("cannot agent_send to yourself"),
    });
  });
});

describe("public tools with current runtime identities", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const firstIdentity = {
    workspaceId,
    agentId: "22222222-2222-4222-8222-222222222222",
    processEpoch: "33333333-3333-4333-8333-333333333333",
  };
  const secondIdentity = {
    workspaceId,
    agentId: "44444444-4444-4444-8444-444444444444",
    processEpoch: "55555555-5555-4555-8555-555555555555",
  };

  test("list_peers → agent_send → correlated reply uses immutable ID routes end-to-end", async () => {
    const sockPath = tmpSock();
    const first = new SessionPeer({ sockPath, name: "worker", cwd: "/workspace", identity: firstIdentity });
    const second = new SessionPeer({ sockPath, name: "worker", cwd: "/workspace", identity: secondIdentity });
    await first.start();
    await second.start();
    try {
      const firstTools = makeMockPi();
      const secondTools = makeMockPi();
      registerAgentTools(firstTools.pi, () => first);
      registerAgentTools(secondTools.pi, () => second);

      const expectedFirst = `~identity/${workspaceId}/${firstIdentity.agentId}`;
      const expectedSecond = `~identity/${workspaceId}/${secondIdentity.agentId}`;
      const listed = await firstTools.tools.get("list_peers")!.execute(
        TOOL_CALL_ID, {}, undefined, undefined, {} as never,
      );
      expect(listed.details).toMatchObject({
        peers: [expectedSecond],
        peers_detailed: [expect.objectContaining({
          identityAddress: expectedSecond,
          address: "/workspace@worker#2",
          name: "worker",
          cwd: "/workspace",
        })],
      });
      expect((listed.details as { peers: string[] }).peers).not.toContain("/workspace@worker#2");
      expect((listed.content[0] as { text: string }).text).toContain(`"route":"${expectedSecond}"`);

      const inboundAtSecond = waitForMessage(second);
      const sent = await firstTools.tools.get("agent_send")!.execute(
        TOOL_CALL_ID, { to: expectedSecond, body: { question: "ping" } }, undefined, undefined, {} as never,
      );
      expect(sent.details).toMatchObject({ status: "received", ok: true, target: expectedSecond });
      const request = await inboundAtSecond;
      expect(request.from).toBe(expectedFirst);
      expect(request.to).toBe(expectedSecond);

      const inboundAtFirst = waitForMessage(first);
      const replied = await secondTools.tools.get("agent_send")!.execute(
        TOOL_CALL_ID,
        { to: request.from, body: { answer: "pong" }, re: request.id },
        undefined, undefined, {} as never,
      );
      expect(replied.details).toMatchObject({ status: "received", ok: true, target: expectedFirst });
      const reply = await inboundAtFirst;
      expect(reply.from).toBe(expectedSecond);
      expect(reply.to).toBe(expectedFirst);
      expect(reply.re).toBe(request.id);
    } finally {
      await second.leave();
      await first.leave();
    }
  });
});

describe("list_peers tool", () => {
  function makeListPeersPeer(
    peers: string[],
    overrides: { name?: string; request?: unknown } = {},
  ) {
    const myName = overrides.name ?? "orq";
    return {
      name: () => myName,
      address: () => myName,  // plan/38: tests treat address == name (no cwd)
      send: vi.fn(),
      sendWithAck: vi.fn(),
      request: overrides.request ?? vi.fn().mockResolvedValue({
        from: "broker", to: myName, id: "uuid-reply", re: "uuid-orig",
        body: { type: "list_peers_reply", peers },
      }),
    } as unknown as SessionPeer;
  }

  test("returns locals + cross-PC entries, excludes self", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeListPeersPeer(["orq", "backend", "casa:agent-1"]);
    registerAgentTools(pi, () => peer);
    const tool = tools.get("list_peers")!;

    const result = await tool.execute(TOOL_CALL_ID, {}, undefined, undefined, {} as never);

    expect(peer.request).toHaveBeenCalledWith("broker", { type: "list_peers" }, 2_000);
    expect(result.details).toEqual({ peers: ["backend", "casa:agent-1"] });
    expect((result.content[0] as { type: "text"; text: string }).text).toBe(
      "backend\ncasa:agent-1",
    );
  });

  test("empty inventory → (no peers) text", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeListPeersPeer(["orq"]);  // only self
    registerAgentTools(pi, () => peer);
    const tool = tools.get("list_peers")!;

    const result = await tool.execute(TOOL_CALL_ID, {}, undefined, undefined, {} as never);
    expect(result.details).toEqual({ peers: [] });
    expect((result.content[0] as { type: "text"; text: string }).text).toBe("(no peers)");
  });

  test("not in session → empty peers + NOT_IN_SESSION text", async () => {
    const { pi, tools } = makeMockPi();
    registerAgentTools(pi, () => null);
    const tool = tools.get("list_peers")!;

    const result = await tool.execute(TOOL_CALL_ID, {}, undefined, undefined, {} as never);
    expect(result.details).toEqual({ peers: [] });
    expect((result.content[0] as { type: "text"; text: string }).text).toContain("Not in a session");
  });

  test("broker request throws → structured error, peers=[]", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeListPeersPeer([], {
      request: vi.fn().mockRejectedValue(new Error("request to broker timed out")),
    });
    registerAgentTools(pi, () => peer);
    const tool = tools.get("list_peers")!;

    const result = await tool.execute(TOOL_CALL_ID, {}, undefined, undefined, {} as never);
    expect(result.details).toEqual({ peers: [] });
    expect((result.content[0] as { type: "text"; text: string }).text).toContain("list_peers failed");
  });
});

describe("agent_request tool (deprecated, still functional)", () => {
  test("legacy: calls SessionPeer.request → returns reply.body via details", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeMockPeer();
    registerAgentTools(pi, () => peer);
    const tool = tools.get("agent_request")!;

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { q: "?" } },
      undefined, undefined, {} as never,
    );

    expect(peer.request).toHaveBeenCalledWith("backend", { q: "?" }, 30_000);
    expect(result.details).toEqual({ ok: true, text: "pong" });
  });

  test("custom timeout_ms is honored", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeMockPeer();
    registerAgentTools(pi, () => peer);
    const tool = tools.get("agent_request")!;

    await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { q: "?" }, timeout_ms: 5_000 },
      undefined, undefined, {} as never,
    );
    expect(peer.request).toHaveBeenCalledWith("backend", { q: "?" }, 5_000);
  });

  test("not in a session → structured error", async () => {
    const { pi, tools } = makeMockPi();
    registerAgentTools(pi, () => null);
    const tool = tools.get("agent_request")!;

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: "x" },
      undefined, undefined, {} as never,
    );
    expect(result.details).toMatchObject({
      error: expect.stringContaining("Not in a session"),
    });
  });

  test("SessionPeer.request throws (timeout) → structured error", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeMockPeer({
      request: vi.fn().mockRejectedValue(new Error("request to backend timed out after 5000ms")),
    });
    registerAgentTools(pi, () => peer);
    const tool = tools.get("agent_request")!;

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { q: "?" }, timeout_ms: 5_000 },
      undefined, undefined, {} as never,
    );
    expect(result.details).toMatchObject({
      error: expect.stringContaining("timed out"),
    });
  });

  test("self-request refused early → request not called", async () => {
    const { pi, tools } = makeMockPi();
    const peer = makeMockPeer({ name: "orq" });
    registerAgentTools(pi, () => peer);
    const tool = tools.get("agent_request")!;

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "orq", body: { x: 1 } },
      undefined, undefined, {} as never,
    );

    expect(peer.request).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      error: expect.stringContaining("cannot agent_request to yourself"),
    });
  });
});
