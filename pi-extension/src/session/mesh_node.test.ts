import { describe, expect, test, vi } from "vitest";
import { MeshNode } from "./mesh_node.js";
import type { PeerInfo } from "./broker.js";

/**
 * Unit tests for `MeshNode.listPeersDetailed()` (the broker roster used by
 * presentation clients and strict identity-authority resolution).
 *
 * The constructor builds a `SessionPeer` but opens no socket until `connect()`,
 * and `listPeersDetailed` only touches `peer_.request` / `peer_.address`. So we
 * construct a node and swap the private `peer_` for a mock — no UDS, no relay.
 */

const SELF = "~identity/ws-self/agent-self";

function makeNode(reply: { peers?: string[]; peers_detailed?: PeerInfo[] }): MeshNode {
  const node = new MeshNode({ sockPath: "/tmp/unused.sock", name: "self" });
  const mockPeer = {
    address: () => SELF,
    request: vi.fn().mockResolvedValue({
      from: "broker", to: SELF, id: "r1", re: "o1",
      body: { type: "list_peers_reply", ...reply },
    }),
  };
  (node as unknown as { peer_: unknown }).peer_ = mockPeer;
  return node;
}

function peer(name: string, route: string, cwd = "/w"): PeerInfo {
  return { name, cwd, address: `${cwd}@${name}`, identityAddress: route };
}

describe("MeshNode.listPeersDetailed", () => {
  test("aligns detail to each route and excludes self", async () => {
    const backend = peer("backend", "~identity/ws-a/agent-a");
    const node = makeNode({
      peers: [SELF, backend.identityAddress!],
      peers_detailed: [
        { name: "self", cwd: "/w", address: "/w@self", identityAddress: SELF },
        backend,
      ],
    });

    const { routes, detailed } = await node.listPeersDetailed();

    expect(routes).toEqual([backend.identityAddress]);
    expect(detailed).toEqual([backend]);
  });

  test("route with no matching detail (legacy sibling) survives in routes", async () => {
    const legacy = "casa:worker";  // flat route, no structured entry
    const node = makeNode({ peers: [legacy], peers_detailed: [] });

    const { routes, detailed } = await node.listPeersDetailed();

    expect(routes).toEqual([legacy]);
    expect(detailed).toEqual([]);
  });

  test("empty roster → empty routes and detailed", async () => {
    const node = makeNode({ peers: [SELF], peers_detailed: [] });

    const { routes, detailed } = await node.listPeersDetailed();

    expect(routes).toEqual([]);
    expect(detailed).toEqual([]);
  });

  test("preserves an incomplete broker detail so authority resolution can fail closed", async () => {
    // Do not filter detail through flat routes or synthesize an identity route
    // from the legacy address: the strict resolver must observe that this exact
    // identity record lacks `identityAddress` and reject it explicitly.
    const incomplete: PeerInfo = {
      name: "ghost",
      cwd: "/w",
      address: "/w@ghost",
      workspaceId: "ws-g",
      agentId: "agent-g",
      processEpoch: "epoch-g",
    };
    const node = makeNode({ peers: [SELF], peers_detailed: [incomplete] });

    const { routes, detailed } = await node.listPeersDetailed();

    expect(routes).toEqual([]);
    expect(detailed).toEqual([incomplete]);
  });
});
