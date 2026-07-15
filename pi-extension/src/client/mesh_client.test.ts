import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SessionPeer } from "../session/peer.js";
import type { RuntimeIdentity } from "../session/runtime_identity.js";
import { MeshClient } from "./mesh_client.js";

function identity(): RuntimeIdentity {
  return {
    workspaceId: randomUUID(),
    agentId: randomUUID(),
    processEpoch: randomUUID(),
  };
}

describe("remote-pi/mesh public client", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).reverse().map((close) => close()));
  });

  async function socket(): Promise<{ path: string; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "remote-pi-mesh-client-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    return { path: join(dir, "broker.sock"), dir };
  }

  test("lists structured peers and returns the target-retention ACK", async () => {
    const { path, dir } = await socket();
    const targetIdentity = identity();
    const target = new SessionPeer({
      sockPath: path,
      name: "orchestrator",
      cwd: "/workspace/orchestrator",
      identity: targetIdentity,
    });
    await target.start();
    cleanup.push(() => target.leave());

    let receivedBody: unknown;
    target.onMessage((envelope) => {
      if (envelope.from === "broker") return;
      receivedBody = envelope.body;
      if (envelope.deliveryReceipt?.required) {
        void target.send("broker", {
          type: "mesh_delivery_receipt",
          envelopeId: envelope.id,
          status: "received",
        });
      }
    });

    const client = new MeshClient({
      sockPath: path,
      name: "dashboard",
      cwd: dir,
      identity: identity(),
    });
    cleanup.push(() => client.close());
    const connection = await client.connect();
    expect(connection.address).toMatch(/^~identity\//);
    expect(() => client.agentSend("broadcast", {})).toThrow(/unicast/i);

    const roster = await client.listPeersDetailed();
    expect(roster.routes).toContain(target.address());
    expect(roster.detailed).toContainEqual(expect.objectContaining({
      name: "orchestrator",
      workspaceId: targetIdentity.workspaceId,
      agentId: targetIdentity.agentId,
      processEpoch: targetIdentity.processEpoch,
      identityAddress: target.address(),
    }));

    const result = await client.agentSend(target.address(), {
      decisionId: "decision-1",
      response: "approve",
    });
    expect(result).toEqual({
      status: "received",
      id: expect.any(String),
      target: target.address(),
    });
    expect(receivedBody).toEqual({ decisionId: "decision-1", response: "approve" });
  });

  test("honestly denies inbound acknowledged envelopes because v1 is outbound-only", async () => {
    const { path, dir } = await socket();
    const client = new MeshClient({
      sockPath: path,
      name: "dashboard",
      cwd: dir,
      identity: identity(),
    });
    cleanup.push(() => client.close());
    const dashboard = await client.connect();

    const sender = new SessionPeer({
      sockPath: path,
      name: "sender",
      cwd: "/workspace/sender",
      identity: identity(),
    });
    await sender.start();
    cleanup.push(() => sender.leave());

    const result = await sender.sendWithAck(dashboard.address, { message: "unsupported inbound" }, null, 1_000);
    expect(result.status).toBe("denied");
    expect(result.target).toBe(dashboard.address);
  });

  test("requires a valid stable identity and a connected lifecycle", async () => {
    const { path, dir } = await socket();
    expect(() => new MeshClient({
      sockPath: path,
      name: "dashboard",
      cwd: dir,
      identity: { workspaceId: "bad", agentId: randomUUID(), processEpoch: randomUUID() },
    })).toThrow(/identity.*valid/i);

    const client = new MeshClient({
      sockPath: path,
      name: "dashboard",
      cwd: dir,
      identity: identity(),
    });
    expect(() => client.listPeersDetailed()).toThrow(/not connected/i);
    expect(() => client.agentSend("broadcast", {})).toThrow(/not connected/i);
    await client.close();
    await expect(client.connect()).rejects.toThrow(/closed/i);
  });
});
