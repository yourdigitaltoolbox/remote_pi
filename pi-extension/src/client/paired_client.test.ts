import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, test } from "vitest";
import { ed25519Verify, generateEd25519Keypair } from "../pairing/crypto.js";
import { RelayClient } from "../transport/relay_client.js";
import { PairedClient } from "./paired_client.js";

interface RelayConnection {
  ws: WebSocket;
  peerId: string;
  roomId: string;
}

/** Small in-process relay that still requires each peer's real Ed25519 auth. */
class AuthenticatedTestRelay {
  readonly authenticatedPeers = new Set<string>();
  private readonly connections = new Map<string, RelayConnection>();
  private readonly server = new WebSocketServer({ port: 0 });

  constructor() {
    this.server.on("connection", (ws) => this.authenticate(ws));
  }

  async url(): Promise<string> {
    if (!this.server.address()) await new Promise<void>((resolve) => this.server.once("listening", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("test relay has no TCP address");
    return `ws://127.0.0.1:${address.port}`;
  }

  close(): Promise<void> {
    for (const connection of this.connections.values()) connection.ws.close();
    return new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  private authenticate(ws: WebSocket): void {
    let peerId = "";
    let roomId = "main";
    let nonce: Buffer | undefined;
    let publicKey: Buffer | undefined;
    let complete = false;
    ws.on("message", (raw) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(String(raw)) as Record<string, unknown>; } catch { ws.close(); return; }
      if (!complete) {
        if (!nonce) {
          if (frame.type !== "hello" || typeof frame.pubkey !== "string") { ws.close(); return; }
          publicKey = Buffer.from(frame.pubkey, "base64");
          if (publicKey.length !== 32) { ws.close(); return; }
          peerId = publicKey.toString("base64");
          roomId = typeof frame.room_id === "string" && frame.room_id ? frame.room_id : "main";
          nonce = randomBytes(32);
          ws.send(JSON.stringify({ type: "challenge", nonce: nonce.toString("base64") }));
          return;
        }
        if (frame.type !== "auth" || typeof frame.sig !== "string" || !publicKey || !ed25519Verify(publicKey, nonce, Buffer.from(frame.sig, "base64"))) {
          ws.close();
          return;
        }
        complete = true;
        this.authenticatedPeers.add(peerId);
        this.connections.set(`${peerId}:${roomId}`, { ws, peerId, roomId });
        return;
      }
      if (typeof frame.type === "string") return;
      if (typeof frame.peer !== "string" || typeof frame.ct !== "string") return;
      const destination = this.connections.get(`${frame.peer}:${typeof frame.room === "string" && frame.room ? frame.room : "main"}`);
      if (destination) destination.ws.send(JSON.stringify({ peer: peerId, room: roomId, ct: frame.ct }));
    });
    ws.on("close", () => this.connections.delete(`${peerId}:${roomId}`));
  }
}

describe("PairedClient", () => {
  let relay: AuthenticatedTestRelay | undefined;
  let pi: RelayClient | undefined;
  let client: PairedClient | undefined;

  afterEach(async () => {
    client?.close();
    pi?.close();
    if (relay) await relay.close();
    relay = undefined;
    pi = undefined;
    client = undefined;
  });

  test("uses two relay-authenticated peers for unpaired rejection, pairing, compact terminal outcome, and stale CAS rejection", async () => {
    relay = new AuthenticatedTestRelay();
    const relayUrl = await relay.url();
    const piIdentity = generateEd25519Keypair();
    const piPeerId = Buffer.from(piIdentity.publicKey).toString("base64");
    const roomId = "target-room";
    pi = new RelayClient(relayUrl, piIdentity);
    await pi.connect({ roomId });

    let pairedPeer: string | undefined;
    pi.on("message", (line) => {
      const outer = JSON.parse(line) as { peer: string; ct: string };
      const message = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8")) as { type: string; id: string; expected_sequence?: number };
      const send = (reply: object) => pi!.send(JSON.stringify({ peer: outer.peer, ct: Buffer.from(JSON.stringify(reply)).toString("base64") }));
      if (message.type === "pair_request") {
        pairedPeer = outer.peer;
        send({ type: "pair_ok", in_reply_to: message.id, session_name: "test", session_started_at: 1, room_id: roomId });
      } else if (outer.peer !== pairedPeer) {
        send({ type: "error", in_reply_to: message.id, code: "unknown_peer", message: "Peer not paired" });
      } else if (message.type === "lifecycle_status") {
        send({ type: "lifecycle_status", in_reply_to: message.id, snapshot: { registry_state: "ready", sequence: 8, session_id: "session", generation_id: "generation", phase: "blocked-unknown", operation_id: "operation" }, diagnostics: [] });
      } else if (message.type === "session_compact") {
        send({ type: "action_ok", in_reply_to: message.id, action: "session_compact", disposition: "accepted", operation_id: "operation", generation_id: "generation" });
        send({ type: "lifecycle_outcome", operation_id: "operation", session_id: "session", generation_id: "generation", outcome: "completed" });
      } else if (message.type === "lifecycle_repair") {
        expect(message.expected_sequence).toBe(7);
        send({ type: "lifecycle_repair", in_reply_to: message.id, disposition: "rejected", code: "snapshot-sequence-mismatch", sequence: 8, generation_id: "generation" });
      }
    });

    const pairingUri = `remotepi://pair?t=one-time-token&epk=${Buffer.from(piIdentity.publicKey).toString("base64url")}&rm=${roomId}`;
    client = await PairedClient.connect({ relayUrl, pairingUri, deviceName: "Integration client" });

    await expect(client.lifecycleStatus()).resolves.toMatchObject({ type: "error", code: "unknown_peer" });
    await expect(client.pair()).resolves.toMatchObject({ type: "pair_ok" });
    await expect(client.lifecycleStatus()).resolves.toMatchObject({ type: "lifecycle_status", snapshot: { sequence: 8 } });

    const terminal = new Promise<unknown>((resolve) => client!.onLifecycleOutcome(resolve));
    await expect(client.compact()).resolves.toMatchObject({ type: "action_ok", disposition: "accepted" });
    await expect(terminal).resolves.toMatchObject({ type: "lifecycle_outcome", outcome: "completed" });
    await expect(client.lifecycleRepair({
      action: "abandon-ambiguous-resume",
      operationId: "operation",
      sessionId: "session",
      generationId: "generation",
      expectedPhase: "blocked-unknown",
      expectedSequence: 7,
      evidenceClass: "current-process-quiescent",
    })).resolves.toMatchObject({ type: "lifecycle_repair", disposition: "rejected", code: "snapshot-sequence-mismatch", sequence: 8 });

    expect(relay.authenticatedPeers.size).toBe(2);
    expect(relay.authenticatedPeers).toContain(piPeerId);
  });
});
