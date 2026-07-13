import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { handleSessionCompact, type ActionReplySender } from "../actions/handlers.js";
import { RemoteLifecycleController, type RemoteLifecycleEvent } from "../lifecycle/remote_lifecycle.js";
import { MeshSpool } from "../session/mesh_spool.js";
import type { ServerMessage } from "../protocol/types.js";

export type RemotePiProbeInjection =
  | Readonly<{ consumer: "remote-pi"; kind: "compact-request"; id: string; ownerId: string }>
  | Readonly<{ consumer: "remote-pi"; kind: "mesh-arrival"; id: string; lane: "reply" | "unsolicited" }>;

export type RemotePiProbeOutcome = "accepted" | "held" | "released" | "coalesced" | "rejected" | "completed" | "failed";

export interface RemotePiProbeReceipt {
  readonly consumer: "remote-pi";
  readonly id: string;
  readonly outcome: RemotePiProbeOutcome;
  readonly operationId?: string;
  readonly generationId?: string;
  readonly notificationCount?: number;
}

export interface RemotePiProbeOptions {
  readonly session: AgentSession;
  readonly seed: string | number;
}

/**
 * Archive-testing adapter for the same two ingress paths Remote Pi uses in a
 * live extension: authenticated compact actions and mesh target admission.
 * It intentionally has no relay, filesystem profile, or coordinator controls.
 */
export class RemotePiProbeAdapter {
  private readonly receipts: Readonly<RemotePiProbeReceipt>[] = [];
  private readonly compactRequests = new Map<string, string>();
  private readonly lifecycle: RemoteLifecycleController;
  private readonly meshSpool: MeshSpool;
  private disposed = false;

  constructor(private readonly options: RemotePiProbeOptions) {
    this.lifecycle = new RemoteLifecycleController((event) => this.observeLifecycle(event));
    this.lifecycle.bind(options.session.sessionId);
    this.meshSpool = new MeshSpool({
      mode: "managed",
      getSessionId: () => this.disposed ? null : options.session.sessionId,
      submit: (_lane, envelopes, submissionId, generationId) => {
        // AgentSession.sendCustomMessage is the documented SDK action surface.
        // The probe sends no mesh payload: only opaque envelope IDs reach Pi.
        void options.session.sendCustomMessage({
          customType: "remote-pi:mesh-batch",
          content: "",
          display: false,
          details: {
            generationId,
            submissionId,
            envelopeIds: envelopes.map((envelope) => envelope.id),
          },
        }, { triggerTurn: true, deliverAs: "nextTurn" }).catch(() => undefined);
        return true;
      },
    });
  }

  inject(input: RemotePiProbeInjection): Readonly<RemotePiProbeReceipt> {
    if (this.disposed) return this.record({ consumer: "remote-pi", id: input.id, outcome: "rejected" });
    if (input.consumer !== "remote-pi" || !isOpaqueId(input.id)) {
      return this.record({ consumer: "remote-pi", id: isOpaqueId(input.id) ? input.id : "invalid", outcome: "rejected" });
    }
    return input.kind === "compact-request"
      ? this.injectCompact(input)
      : this.injectMesh(input);
  }

  observations(): readonly Readonly<RemotePiProbeReceipt>[] {
    return Object.freeze([...this.receipts]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.dispose();
    this.meshSpool.dispose();
    this.compactRequests.clear();
  }

  private injectCompact(input: Extract<RemotePiProbeInjection, { kind: "compact-request" }>): Readonly<RemotePiProbeReceipt> {
    if (!isOpaqueId(input.ownerId)) return this.record({ consumer: "remote-pi", id: input.id, outcome: "rejected" });
    const replies: ServerMessage[] = [];
    const sender: ActionReplySender = { send: (message) => { replies.push(message); } };
    // This is the production authenticated-action handler. The owner ID is
    // validated at this ingress boundary but is never exposed in a receipt.
    handleSessionCompact(this.lifecycle, sender, { type: "session_compact", id: input.id });
    const reply = replies[0];
    if (reply?.type === "action_ok" && reply.action === "session_compact" && typeof reply.operation_id === "string") {
      this.compactRequests.set(reply.operation_id, input.id);
      return this.record({
        consumer: "remote-pi",
        id: input.id,
        outcome: reply.disposition === "joined" ? "coalesced" : "accepted",
        operationId: reply.operation_id,
        generationId: reply.generation_id,
      });
    }
    return this.record({ consumer: "remote-pi", id: input.id, outcome: "rejected" });
  }

  private injectMesh(input: Extract<RemotePiProbeInjection, { kind: "mesh-arrival" }>): Readonly<RemotePiProbeReceipt> {
    const before = this.meshSpool.counts();
    const accepted = this.meshSpool.accept({
      // The source, target, and body are intentionally synthetic and opaque.
      // No caller-provided message content can cross this testing seam.
      from: `remote-pi-probe-${String(this.options.seed)}`,
      to: "remote-pi-probe-target",
      id: input.id,
      re: input.lane === "reply" ? input.id : null,
      body: null,
      deliveryReceipt: { required: true },
    });
    if (accepted.status === "denied") return this.record({ consumer: "remote-pi", id: input.id, outcome: "rejected" });
    const after = this.meshSpool.counts();
    const held = after.replies + after.unsolicited > before.replies + before.unsolicited;
    return this.record({ consumer: "remote-pi", id: input.id, outcome: held ? "held" : "accepted" });
  }

  private observeLifecycle(event: RemoteLifecycleEvent): void {
    if (event.type !== "terminal") return;
    const id = this.compactRequests.get(event.operationId);
    if (!id) return;
    this.compactRequests.delete(event.operationId);
    this.record({
      consumer: "remote-pi",
      id,
      outcome: event.outcome === "completed" ? "completed" : "failed",
      operationId: event.operationId,
      generationId: event.generationId,
    });
  }

  private record(receipt: RemotePiProbeReceipt): Readonly<RemotePiProbeReceipt> {
    const immutable = Object.freeze({ ...receipt });
    this.receipts.push(immutable);
    return immutable;
  }
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
