import { describe, expect, test } from "vitest";
import { _routeClientMessageFrom } from "../index.js";
import type { ServerMessage } from "../protocol/types.js";

function sender() {
  const sent: ServerMessage[] = [];
  return { sent, send: (message: ServerMessage) => sent.push(message) };
}

describe("remote lifecycle wire routing", () => {
  test("returns a redacted lifecycle status even before a direct Pi binding exists", () => {
    const channel = sender();
    _routeClientMessageFrom(channel as never, { type: "lifecycle_status", id: "status-1" }, { abort: () => undefined });
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({ type: "lifecycle_status", in_reply_to: "status-1", snapshot: { registry_state: expect.any(String), sequence: expect.any(Number) } });
    expect(JSON.stringify(channel.sent[0])).not.toContain("consumerId");
  });

  test("rejects an invalid repair sequence at the authenticated route boundary", () => {
    const channel = sender();
    _routeClientMessageFrom(channel as never, {
      type: "lifecycle_repair",
      id: "repair-1",
      action: "abandon-ambiguous-resume",
      operation_id: "operation-1",
      session_id: "session-1",
      generation_id: "generation-1",
      expected_phase: "blocked-unknown",
      expected_sequence: -1,
      evidence_class: "owner-process-replaced",
    }, { abort: () => undefined });
    expect(channel.sent).toEqual([
      { type: "lifecycle_repair", in_reply_to: "repair-1", disposition: "rejected", code: "invalid-expected-sequence" },
    ]);
  });

  test("fails a compact request closed rather than silently dropping it before Pi binding", () => {
    const channel = sender();
    _routeClientMessageFrom(channel as never, { type: "session_compact", id: "compact-1" }, { abort: () => undefined });
    expect(channel.sent[0]).toMatchObject({ type: "action_error", in_reply_to: "compact-1", action: "session_compact", error: "lifecycle-authority-unavailable" });
  });
});
