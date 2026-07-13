import {
  getContextLifecycleDiagnosticsV1,
  getContextLifecycleSnapshotV1,
  observeContextLifecycleV1,
  repairContextLifecycleV1,
  requestCompaction,
  type CompactDisposition,
  type DiagnosticRecord,
  type LifecycleEvent,
  type RepairDisposition,
  type RepairRequest,
  type Snapshot,
} from "@yourdigitaltoolbox/pi-context-lifecycle";

export type RemoteLifecycleTerminal = "completed" | "failed" | "cancelled" | "blocked";

export interface LifecycleAuthority {
  snapshot(): Snapshot;
  observe(listener: (event: LifecycleEvent) => void): { snapshot: Snapshot; unsubscribe(): void };
  request(request: Parameters<typeof requestCompaction>[0]): CompactDisposition;
  repair(request: RepairRequest): RepairDisposition;
  diagnostics(): readonly DiagnosticRecord[];
}

const defaultAuthority: LifecycleAuthority = {
  snapshot: getContextLifecycleSnapshotV1,
  observe: observeContextLifecycleV1,
  request: requestCompaction,
  repair: repairContextLifecycleV1,
  diagnostics: getContextLifecycleDiagnosticsV1,
};

export type RemoteLifecycleEvent =
  | { type: "accepted" | "joined"; operationId: string; sessionId: string; generationId: string }
  | { type: "terminal"; operationId: string; sessionId: string; generationId: string; outcome: RemoteLifecycleTerminal; code?: string };

export type RemoteLifecycleStatus = {
  snapshot: Pick<Snapshot, "registryState" | "sequence" | "sessionId" | "generationId" | "phase" | "operationId" | "reason" | "lastOutcome">;
  diagnostics: readonly Pick<DiagnosticRecord, "sequence" | "timestamp" | "code" | "operationId" | "phase" | "outcome">[];
};

/**
 * Consumer-side correlation for Remote Pi actions. The lifecycle owner keeps
 * operation authority; this class keeps only request ids and redacted outcome
 * metadata needed to make the remote UI truthful.
 */
export class RemoteLifecycleController {
  private sessionId: string | undefined;
  private generationId: string | undefined;
  private activeOperationId: string | undefined;
  private unsubscribe: (() => void) | undefined;
  private terminalReportedFor: string | undefined;

  constructor(
    private readonly onEvent: (event: RemoteLifecycleEvent) => void,
    private readonly authority: LifecycleAuthority = defaultAuthority,
  ) {}

  bind(sessionId: string | undefined): void {
    this.dispose();
    if (!sessionId) return;
    this.sessionId = sessionId;
    const observed = this.authority.observe((event) => this.onSnapshot(event));
    this.unsubscribe = observed.unsubscribe;
    this.onSnapshot(observed.snapshot);
  }

  dispose(): void {
    // A session replacement/shutdown can remove the registry before a terminal
    // lifecycle snapshot is observable. Never leave an admitted remote request
    // presenting as working in that ambiguity; make the degraded outcome
    // explicit and let the new generation bind separately.
    this.emitTerminal("blocked", "lifecycle-authority-disposed");
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.sessionId = undefined;
    this.generationId = undefined;
    this.activeOperationId = undefined;
    this.terminalReportedFor = undefined;
  }

  request(requestId: string): CompactDisposition {
    const snapshot = this.authority.snapshot();
    if (!this.sessionId || snapshot.registryState !== "ready" || snapshot.sessionId !== this.sessionId || !snapshot.generationId) {
      return { disposition: "rejected", code: "lifecycle-authority-unavailable", ...(snapshot.generationId ? { generationId: snapshot.generationId } : {}) };
    }
    this.generationId = snapshot.generationId;
    const result = this.authority.request({
      requestId,
      sessionId: this.sessionId,
      generationId: snapshot.generationId,
      reason: "remote",
      source: "remote-pi-action",
      actor: "operator",
      channel: "remote",
      settlementPolicy: "current-or-next-settled-boundary",
    });
    if (result.disposition === "accepted" || result.disposition === "joined") {
      this.activeOperationId = result.operationId;
      this.terminalReportedFor = undefined;
      this.onEvent({ type: result.disposition, operationId: result.operationId, sessionId: this.sessionId, generationId: result.generationId });
    }
    return result;
  }

  repair(request: Omit<RepairRequest, "actor" | "channel">): RepairDisposition {
    return this.authority.repair({ ...request, actor: "operator", channel: "remote" });
  }

  status(): RemoteLifecycleStatus {
    const snapshot = this.authority.snapshot();
    return {
      snapshot: {
        registryState: snapshot.registryState,
        sequence: snapshot.sequence,
        ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
        ...(snapshot.generationId ? { generationId: snapshot.generationId } : {}),
        ...(snapshot.phase ? { phase: snapshot.phase } : {}),
        ...(snapshot.operationId ? { operationId: snapshot.operationId } : {}),
        ...(snapshot.reason ? { reason: snapshot.reason } : {}),
        ...(snapshot.lastOutcome ? { lastOutcome: snapshot.lastOutcome } : {}),
      },
      diagnostics: this.authority.diagnostics().slice(-20).map((record) => ({
        sequence: record.sequence,
        timestamp: record.timestamp,
        code: record.code,
        ...(record.operationId ? { operationId: record.operationId } : {}),
        ...(record.phase ? { phase: record.phase } : {}),
        ...(record.outcome ? { outcome: record.outcome } : {}),
      })),
    };
  }

  private onSnapshot(snapshot: Snapshot): void {
    if (!this.sessionId) return;
    if (snapshot.registryState !== "ready") {
      this.emitTerminal("blocked", `lifecycle-authority-${snapshot.registryState}`);
      return;
    }
    if (snapshot.sessionId !== this.sessionId) {
      this.emitTerminal("blocked", "lifecycle-session-mismatch");
      return;
    }
    // A replacement generation must bind a fresh controller from session_start.
    // Ignore an old observer's late callback rather than attributing its terminal
    // result to a request admitted by the current generation.
    if (this.generationId && snapshot.generationId && snapshot.generationId !== this.generationId) return;
    if (snapshot.generationId) this.generationId = snapshot.generationId;
    const operationId = snapshot.operationId ?? this.activeOperationId;
    if (!operationId || this.terminalReportedFor === operationId) return;
    if (snapshot.phase === "blocked-unknown") {
      this.emitTerminal("blocked", "blocked-unknown", operationId);
      return;
    }
    if (snapshot.phase === "idle" && snapshot.lastOutcome) {
      const outcome: RemoteLifecycleTerminal = snapshot.lastOutcome === "completed"
        ? "completed"
        : snapshot.lastOutcome === "cancelled"
          ? "cancelled"
          : "failed";
      this.emitTerminal(outcome, undefined, operationId);
    }
  }

  private emitTerminal(outcome: RemoteLifecycleTerminal, code?: string, operationId = this.activeOperationId): void {
    if (!operationId || this.terminalReportedFor === operationId || !this.sessionId) return;
    this.terminalReportedFor = operationId;
    this.onEvent({
      type: "terminal",
      operationId,
      sessionId: this.sessionId,
      generationId: this.generationId ?? "",
      outcome,
      ...(code ? { code } : {}),
    });
    this.activeOperationId = undefined;
  }
}
