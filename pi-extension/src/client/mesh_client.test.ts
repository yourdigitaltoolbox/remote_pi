import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { PeerInfo } from "../session/broker.js";
import { SessionPeer } from "../session/peer.js";
import type { RuntimeIdentity } from "../session/runtime_identity.js";
import {
  MeshClient,
  type MeshIdentityTarget,
} from "./mesh_client.js";

function identity(): RuntimeIdentity {
  return {
    workspaceId: randomUUID(),
    agentId: randomUUID(),
    processEpoch: randomUUID(),
  };
}

describe("remote-pi/mesh authority client integration", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).reverse().map((close) => close()));
  });

  async function socket(): Promise<{ path: string; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "remote-pi-mesh-client-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    return { path: join(dir, "broker.sock"), dir };
  }

  test("resolves one strict identity into an opaque target and strips the ACK route", async () => {
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
    await expect(client.connect()).resolves.toBeUndefined();

    const resolved = await client.resolveIdentityTarget({
      workspaceId: targetIdentity.workspaceId,
      agentId: targetIdentity.agentId,
    });
    expect(Object.keys(resolved)).toEqual([]);
    expect(Object.getOwnPropertyNames(resolved)).toEqual([]);
    expect(() => JSON.stringify(resolved)).toThrow(/opaque.*non-serializable/i);
    expect(() => client.agentSend({} as MeshIdentityTarget, {})).toThrow(/invalid or forged/i);
    expect(() => client.agentSend("~identity/forged" as unknown as MeshIdentityTarget, {}))
      .toThrow(/invalid or forged/i);
    expect(() => client.agentSend(structuredClone(resolved), {})).toThrow(/invalid or forged/i);
    expect("listPeersDetailed" in client).toBe(false);
    expect("onMessage" in client).toBe(false);
    expect("onReconnect" in client).toBe(false);
    expect("node" in client).toBe(false);

    const result = await client.agentSend(resolved, {
      decisionId: "decision-1",
      response: "approve",
    });
    expect(result).toEqual({ status: "received", id: expect.any(String) });
    expect("target" in result).toBe(false);
    expect(receivedBody).toEqual({ decisionId: "decision-1", response: "approve" });

    const foreign = new MeshClient({
      sockPath: path,
      name: "other-dashboard",
      cwd: `${dir}/other`,
      identity: identity(),
    });
    cleanup.push(() => foreign.close());
    await foreign.connect();
    expect(() => foreign.agentSend(resolved, {})).toThrow(/another client/i);
  });

  test("returns typed disconnected and zero-match resolution outcomes", async () => {
    const { path, dir } = await socket();
    const client = new MeshClient({
      sockPath: path,
      name: "dashboard",
      cwd: dir,
      identity: identity(),
    });
    cleanup.push(() => client.close());

    const wanted = { workspaceId: randomUUID(), agentId: randomUUID() };
    await expect(client.resolveIdentityTarget(wanted))
      .rejects.toMatchObject({ name: "MeshIdentityResolutionError", code: "disconnected" });
    await client.connect();
    await expect(client.resolveIdentityTarget(wanted))
      .rejects.toMatchObject({ code: "zero-match" });
  });

  test("honestly denies inbound acknowledged envelopes because v1 is outbound-only", async () => {
    const { path, dir } = await socket();
    const dashboardIdentity = identity();
    const client = new MeshClient({
      sockPath: path,
      name: "dashboard",
      cwd: dir,
      identity: dashboardIdentity,
    });
    cleanup.push(() => client.close());
    await client.connect();

    const sender = new SessionPeer({
      sockPath: path,
      name: "sender",
      cwd: "/workspace/sender",
      identity: identity(),
    });
    await sender.start();
    cleanup.push(() => sender.leave());

    const roster = await sender.request("broker", { type: "list_peers" });
    const details = (roster.body as { peers_detailed?: PeerInfo[] }).peers_detailed ?? [];
    const dashboard = details.find((peer) =>
      peer.workspaceId === dashboardIdentity.workspaceId
      && peer.agentId === dashboardIdentity.agentId
    );
    expect(dashboard?.identityAddress).toMatch(/^~identity\//);

    const result = await sender.sendWithAck(dashboard!.identityAddress!, { message: "unsupported inbound" }, null, 1_000);
    expect(result.status).toBe("denied");
  });

  test("requires a valid stable client identity", async () => {
    const { path, dir } = await socket();
    expect(() => new MeshClient({
      sockPath: path,
      name: "dashboard",
      cwd: dir,
      identity: { workspaceId: "bad", agentId: randomUUID(), processEpoch: randomUUID() },
    })).toThrow(/identity.*valid/i);
  });
});
