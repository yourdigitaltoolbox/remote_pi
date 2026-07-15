import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PeerInfo } from "../session/broker.js";

interface FakeNodeState {
  routes: string[];
  detailed: PeerInfo[];
  listError: Error | null;
  sentTo: string | null;
  reconnectHandlers: Array<() => void>;
}

const fake = vi.hoisted(() => ({ instances: [] as FakeNodeState[] }));

vi.mock("../session/mesh_node.js", () => ({
  MeshNode: class {
    readonly state: FakeNodeState;

    constructor() {
      this.state = {
        routes: [],
        detailed: [],
        listError: null,
        sentTo: null,
        reconnectHandlers: [],
      };
      fake.instances.push(this.state);
    }

    async connect(): Promise<string> { return "dashboard"; }
    onMessage(): () => void { return () => undefined; }
    onReconnect(handler: () => void): () => void {
      this.state.reconnectHandlers.push(handler);
      return () => undefined;
    }
    async listPeersDetailed(): Promise<{ routes: string[]; detailed: PeerInfo[] }> {
      if (this.state.listError) throw this.state.listError;
      return { routes: this.state.routes, detailed: this.state.detailed };
    }
    async sendWithAck(to: string): Promise<{ status: "received"; id: string; target: string }> {
      this.state.sentTo = to;
      return { status: "received", id: randomUUID(), target: to };
    }
    async send(): Promise<void> {}
    onLocalPeersChanged(): void {}
    async close(): Promise<void> {}
  },
}));

const {
  MeshClient,
  MeshIdentityResolutionError,
} = await import("./mesh_client.js");

type MeshClientInstance = InstanceType<typeof MeshClient>;

function identity(): { workspaceId: string; agentId: string; processEpoch: string } {
  return {
    workspaceId: randomUUID(),
    agentId: randomUUID(),
    processEpoch: randomUUID(),
  };
}

function createClient(): MeshClientInstance {
  return new MeshClient({
    sockPath: "/tmp/fake-mesh.sock",
    name: "dashboard",
    cwd: "/workspace/dashboard",
    identity: identity(),
  });
}

function state(): FakeNodeState {
  const value = fake.instances.at(-1);
  if (!value) throw new Error("fake MeshNode was not constructed");
  return value;
}

describe("remote-pi/mesh opaque authority contract", () => {
  beforeEach(() => {
    fake.instances.length = 0;
  });

  test("captures the exact cross-PC identityAddress privately and strips it from the ACK", async () => {
    const client = createClient();
    await client.connect();
    const wanted = { workspaceId: randomUUID(), agentId: randomUUID() };
    const identityAddress = `mac:~identity/${wanted.workspaceId}/${wanted.agentId}`;
    state().routes = [identityAddress];
    state().detailed = [{
      pc: "mac",
      cwd: "/workspace/orchestrator",
      name: "orchestrator",
      address: "mac:/workspace/orchestrator@orchestrator",
      ...wanted,
      processEpoch: randomUUID(),
      identityAddress,
    }];

    const target = await client.resolveIdentityTarget(wanted);
    const result = await client.agentSend(target, { decisionId: "d-1" });

    expect(state().sentTo).toBe(identityAddress);
    expect(result).toEqual({ status: "received", id: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(identityAddress);
    expect(Object.getOwnPropertyNames(target)).toEqual([]);
    await client.close();
  });

  test("distinguishes zero, multiple, missing-address, timeout, and disconnected outcomes", async () => {
    const client = createClient();
    const wanted = { workspaceId: randomUUID(), agentId: randomUUID() };

    await expect(client.resolveIdentityTarget(wanted))
      .rejects.toMatchObject({ code: "disconnected" });
    await client.connect();

    await expect(client.resolveIdentityTarget(wanted))
      .rejects.toMatchObject({ code: "zero-match" });

    state().detailed = [
      { cwd: "/a", name: "a", address: "/a@a", ...wanted, identityAddress: "pc-a:~identity/a" },
      { cwd: "/b", name: "b", address: "/b@b", ...wanted, identityAddress: "pc-b:~identity/b" },
    ];
    await expect(client.resolveIdentityTarget(wanted))
      .rejects.toMatchObject({ code: "multiple-match" });

    state().detailed = [
      { cwd: "/legacy", name: "legacy", address: "/legacy@legacy", ...wanted },
    ];
    await expect(client.resolveIdentityTarget(wanted))
      .rejects.toMatchObject({ code: "missing-identity-address" });

    state().listError = new Error("request to broker timed out after 5ms");
    await expect(client.resolveIdentityTarget(wanted, { timeoutMs: 5 }))
      .rejects.toMatchObject({ code: "timeout" });

    state().listError = new Error("broker socket closed");
    await expect(client.resolveIdentityTarget(wanted))
      .rejects.toMatchObject({ code: "disconnected" });

    await client.close();
    expect(new MeshIdentityResolutionError("zero-match", "x").code).toBe("zero-match");
  });

  test("rejects foreign, stale-after-reconnect, and closed-client handles", async () => {
    const first = createClient();
    await first.connect();
    const firstState = state();
    const wanted = { workspaceId: randomUUID(), agentId: randomUUID() };
    firstState.detailed = [{
      cwd: "/orchestrator",
      name: "orchestrator",
      address: "/orchestrator@orchestrator",
      ...wanted,
      identityAddress: `~identity/${wanted.workspaceId}/${wanted.agentId}`,
    }];
    const target = await first.resolveIdentityTarget(wanted);

    const second = createClient();
    await second.connect();
    expect(() => second.agentSend(target, {})).toThrow(/another client/i);

    for (const reconnect of firstState.reconnectHandlers) reconnect();
    expect(() => first.agentSend(target, {})).toThrow(/stale after reconnect/i);

    await first.close();
    expect(() => first.agentSend(target, {})).toThrow(/closed/i);
    await second.close();
  });
});
