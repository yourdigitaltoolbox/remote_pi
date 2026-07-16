import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { handleSessionCompact, type ActionReplySender } from "../actions/handlers.js";
import { RemoteLifecycleController, type RemoteLifecycleEvent } from "../lifecycle/remote_lifecycle.js";
import type { ServerMessage } from "../protocol/types.js";
import type { MeshLane } from "../session/mesh_spool.js";
import { productionMeshProbe, type ProductionMeshProbe } from "./production_mesh_probe.js";

export type RemotePiProbeInjection =
  | Readonly<{ consumer: "remote-pi"; kind: "compact-request"; id: string; ownerId: string }>
  | Readonly<{ consumer: "remote-pi"; kind: "mesh-arrival"; id: string; lane: "reply" | "unsolicited" }>;

export type RemotePiProbeOutcome = "accepted" | "held" | "released" | "coalesced" | "rejected" | "completed" | "failed";

interface RemotePiProbeReceiptBase {
  readonly consumer: "remote-pi";
  readonly id: string;
  readonly operationId?: string;
  readonly generationId?: string;
  readonly notificationCount?: number;
}

/** Redacted mesh transitions retain lane identity without exposing envelopes. */
export type RemotePiProbeReceipt =
  | (RemotePiProbeReceiptBase & Readonly<{ outcome: "held" | "released"; lane: MeshLane }>)
  | (RemotePiProbeReceiptBase & Readonly<{ outcome: Exclude<RemotePiProbeOutcome, "held" | "released">; lane?: never }>);

export interface RemotePiProbeOptions {
  readonly session: AgentSession;
  readonly seed: string | number;
}

/**
 * Archive-testing adapter for the real compact action and the MeshSpool owned
 * by the loaded Remote Pi extension. It owns no lifecycle gate or mesh queue.
 */
export class RemotePiProbeAdapter {
  private readonly receipts: Readonly<RemotePiProbeReceipt>[] = [];
  private readonly compactRequests = new Map<string, string>();
  private readonly lifecycle: RemoteLifecycleController;
  private readonly meshIds = new Set<string>();
  private readonly meshProbe: ProductionMeshProbe | undefined;
  private readonly stopObservingMesh: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly options: RemotePiProbeOptions) {
    this.lifecycle = new RemoteLifecycleController((event) => this.observeLifecycle(event));
    this.lifecycle.bind(options.session.sessionId);
    this.meshProbe = productionMeshProbe(options.session.sessionId);
    this.stopObservingMesh = this.meshProbe?.observe((transition) => {
      if (!this.meshIds.has(transition.id)) return;
      this.record({
        consumer: "remote-pi",
        id: transition.id,
        lane: transition.lane,
        outcome: transition.outcome,
        generationId: transition.generationId,
      });
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
    this.stopObservingMesh?.();
    this.lifecycle.dispose();
    this.compactRequests.clear();
    this.meshIds.clear();
  }

  private injectCompact(input: Extract<RemotePiProbeInjection, { kind: "compact-request" }>): Readonly<RemotePiProbeReceipt> {
    if (!isOpaqueId(input.ownerId)) return this.record({ consumer: "remote-pi", id: input.id, outcome: "rejected" });
    const replies: ServerMessage[] = [];
    const sender: ActionReplySender = { send: (message) => { replies.push(message); } };
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
    const probe = this.meshProbe;
    if (!probe) return this.record({ consumer: "remote-pi", id: input.id, outcome: "rejected" });
    this.meshIds.add(input.id);
    const result = probe.accept({ id: input.id, lane: input.lane === "reply" ? "mesh-reply" : "mesh-unsolicited" });
    if (result.status === "denied") {
      this.meshIds.delete(input.id);
      return this.record({ consumer: "remote-pi", id: input.id, outcome: "rejected" });
    }
    const held = [...this.receipts].reverse().find((receipt) => receipt.id === input.id && receipt.outcome === "held");
    return held ?? this.record({ consumer: "remote-pi", id: input.id, outcome: "accepted" });
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
