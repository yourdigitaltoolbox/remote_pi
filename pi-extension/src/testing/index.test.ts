import { describe, expect, test } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createExactCandidateProbe } from "./index.js";

function session(): AgentSession {
  return {
    sessionId: "remote-pi-probe-session",
    sendCustomMessage: async () => undefined,
  } as unknown as AgentSession;
}

describe("remote-pi/testing", () => {
  test("exposes only typed opaque receipts at the real action and mesh ingress boundaries", async () => {
    const probe = createExactCandidateProbe({
      session: session(),
      seed: "archive-seed",
      packageDirectory: "/candidate/node_modules/remote-pi",
    });

    expect(probe.consumer).toBe("remote-pi");
    expect(Object.isFrozen(probe)).toBe(true);

    const compact = await probe.inject({
      consumer: "remote-pi",
      kind: "compact-request",
      id: "compact-opaque-id",
      ownerId: "owner-opaque-id",
    });
    const mesh = await probe.inject({
      consumer: "remote-pi",
      kind: "mesh-arrival",
      id: "mesh-opaque-id",
      lane: "unsolicited",
    });

    for (const receipt of [compact, mesh]) {
      expect(receipt.consumer).toBe("remote-pi");
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(Object.keys(receipt)).not.toContain("body");
      expect(JSON.stringify(receipt)).not.toContain("archive-seed");
    }
    expect(await probe.observations()).toEqual([compact, mesh]);

    await probe.dispose();
    await expect(probe.inject({
      consumer: "remote-pi",
      kind: "mesh-arrival",
      id: "after-dispose",
      lane: "reply",
    })).resolves.toMatchObject({ outcome: "rejected" });
  });
});
