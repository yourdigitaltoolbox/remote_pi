import {
  admitWake,
  getContextLifecycleSnapshotV1,
  observeContextLifecycleV1,
  registerContextLifecycleDrainerV1,
  type DrainAck,
  type LifecycleEvent,
  type ReleasePermit,
  type Snapshot,
} from "@yourdigitaltoolbox/pi-context-lifecycle";
import { randomUUID } from "node:crypto";
import { serialize, type Envelope } from "./envelope.js";

export const REMOTE_PI_MESH_CONSUMER_ID = "remote-pi-mesh";
export const MAX_MESH_ENVELOPES = 256;
export const MAX_MESH_ENVELOPE_BYTES = 64 * 1024;
export const MAX_MESH_TOTAL_BYTES = 1024 * 1024;

export type MeshSpoolMode = "managed" | "compatibility";
export type MeshLane = "mesh-reply" | "mesh-unsolicited";
export type MeshAcceptance = { status: "received" } | { status: "denied"; code: string };
/** Redacted lifecycle receipts for the production-owned testing bridge. */
export interface MeshSpoolTransition {
  readonly id: string;
  readonly lane: MeshLane;
  readonly outcome: "held" | "released";
  readonly generationId: string;
}

export interface MeshSpoolAuthority {
  snapshot(): Snapshot;
  observe(listener: (event: LifecycleEvent) => void): { snapshot: Snapshot; unsubscribe(): void };
  admitWake: typeof admitWake;
  registerDrainer: typeof registerContextLifecycleDrainerV1;
}

const defaultAuthority: MeshSpoolAuthority = {
  snapshot: getContextLifecycleSnapshotV1,
  observe: observeContextLifecycleV1,
  admitWake,
  registerDrainer: registerContextLifecycleDrainerV1,
};

interface HeldEnvelope {
  sequence: number;
  bytes: number;
  generationId: string;
  envelope: Envelope;
}

interface PendingRestore {
  lane: MeshLane;
  envelope: Envelope;
  generationId: string;
}

interface DispatchingBatch {
  lane: MeshLane;
  submissionId: string;
  generationId: string;
  records: readonly HeldEnvelope[];
}

export interface PersistedMeshSpoolEvent {
  schemaVersion: 1;
  sessionId: string;
  state: "held" | "submitting" | "submitted";
  lane: MeshLane;
  generationId: string;
  envelope: Envelope;
  submissionId?: string;
}

export interface MeshBatchProof {
  sessionId: string;
  generationId: string;
  submissionId: string;
  envelopeIds: string[];
}

function batchKey(sessionId: string, generationId: string, submissionId: string): string {
  return `${sessionId}\u0000${generationId}\u0000${submissionId}`;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Selects exact envelopes that still need recovery from the append-only V1
 * stream. An exact durable batch proof wins over every marker state; otherwise
 * held, submitting, and submitted records all remain recoverable.
 */
export function recoverableMeshSpoolEvents(
  events: readonly PersistedMeshSpoolEvent[],
  proofs: readonly MeshBatchProof[],
): PersistedMeshSpoolEvent[] {
  const latest = new Map<string, PersistedMeshSpoolEvent>();
  const attempts = new Map<string, { generationId: string; submissionId: string; envelopeIds: string[] }>();
  for (const event of events) {
    latest.set(event.envelope.id, event);
    if (event.state !== "submitting" || !event.submissionId) continue;
    const key = batchKey(event.sessionId, event.generationId, event.submissionId);
    const attempt = attempts.get(key) ?? {
      generationId: event.generationId,
      submissionId: event.submissionId,
      envelopeIds: [],
    };
    if (!attempt.envelopeIds.includes(event.envelope.id)) attempt.envelopeIds.push(event.envelope.id);
    attempts.set(key, attempt);
  }

  const provedEnvelopeIds = new Set<string>();
  for (const proof of proofs) {
    const attempt = attempts.get(batchKey(proof.sessionId, proof.generationId, proof.submissionId));
    if (!attempt || !sameIds(attempt.envelopeIds, proof.envelopeIds)) continue;
    for (const id of attempt.envelopeIds) provedEnvelopeIds.add(id);
  }
  return [...latest.values()].filter((event) => !provedEnvelopeIds.has(event.envelope.id));
}

export interface MeshSpoolOptions {
  mode: MeshSpoolMode;
  getSessionId(): string | null;
  /** True only at a genuine Pi runtime idle boundary. */
  isRuntimeIdle?(): boolean;
  /** Starts exactly one model submission for this ordered lane batch. */
  submit(lane: MeshLane, envelopes: readonly Envelope[], submissionId: string, generationId: string): boolean;
  /** Domain-owned persistence hook; the lifecycle registry never receives bodies. */
  persist?(event: { state: "held" | "submitting" | "submitted"; lane: MeshLane; generationId: string; envelope: Envelope; submissionId?: string }): void;
  /** Observes redacted retention/release transitions without exposing envelopes. */
  onTransition?(event: MeshSpoolTransition): void;
  onBlocked?(code: string): void;
  authority?: MeshSpoolAuthority;
}

export function resolveMeshSpoolMode(value = process.env.REMOTE_PI_CONTEXT_LIFECYCLE_MODE): MeshSpoolMode {
  return value === "compatibility" ? "compatibility" : "managed";
}

/**
 * Bounded target-side mesh retention. The broker may acknowledge a unicast only
 * after `accept` has retained the exact envelope here. Lifecycle sees lane,
 * count, and watermarks—not mesh bodies.
 */
export class MeshSpool {
  private readonly authority: MeshSpoolAuthority;
  private readonly held: Record<MeshLane, HeldEnvelope[]> = { "mesh-reply": [], "mesh-unsolicited": [] };
  private nextSequence = 0;
  private totalBytes = 0;
  private pendingRestores: PendingRestore[] = [];
  private registeredSessionId: string | undefined;
  private registeredGenerationId: string | undefined;
  private unregister: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private disposed = false;
  private flushing = new Set<MeshLane>();
  private dispatching: Partial<Record<MeshLane, DispatchingBatch>> = {};

  constructor(private readonly options: MeshSpoolOptions) {
    this.authority = options.authority ?? defaultAuthority;
    const observed = this.authority.observe((event) => this.handleSnapshot(event));
    this.unsubscribe = observed.unsubscribe;
    this.handleSnapshot(observed.snapshot);
  }

  accept(envelope: Envelope): MeshAcceptance {
    if (this.disposed) return this.denied("spool-disposed");
    const lane: MeshLane = envelope.re ? "mesh-reply" : "mesh-unsolicited";
    const snapshot = this.authority.snapshot();
    if (this.options.mode === "managed" && snapshot.phase === "blocked-unknown") {
      return this.denied("lifecycle-blocked");
    }
    const admission = this.admitLane(lane, snapshot, `${lane}:${envelope.id}`);
    if (admission === "blocked") return this.denied("lifecycle-authority-unavailable");

    const bytes = Buffer.byteLength(serialize(envelope), "utf8");
    if (bytes > MAX_MESH_ENVELOPE_BYTES) return this.denied("envelope-too-large");
    if (this.heldCount() >= MAX_MESH_ENVELOPES) return this.denied("spool-envelope-capacity");
    if (this.totalBytes + bytes > MAX_MESH_TOTAL_BYTES) return this.denied("spool-byte-capacity");

    const generationId = snapshot.generationId!;
    const record: HeldEnvelope = { sequence: ++this.nextSequence, bytes, generationId, envelope };
    try {
      this.options.persist?.({ state: "held", lane, generationId, envelope });
    } catch {
      return this.denied("spool-persist-failed");
    }
    this.held[lane].push(record);
    this.totalBytes += bytes;
    this.options.onTransition?.({ id: envelope.id, lane, outcome: "held", generationId });
    if (admission === "deliver") this.flush(lane, snapshot);
    return { status: "received" };
  }

  /** Rehydrate only a record owned by this exact lifecycle generation. */
  restore(lane: MeshLane, envelope: Envelope, generationId: string): boolean {
    if (this.disposed) return false;
    this.pendingRestores.push({ lane, envelope, generationId });
    this.restorePending(this.authority.snapshot());
    return true;
  }

  /** Re-evaluate admission after restoring domain-owned records or settlement. */
  reconcile(): void {
    this.handleSnapshot(this.authority.snapshot());
  }

  /**
   * Commits one in-flight batch only after Pi exposes the exact custom-message
   * proof. Until this succeeds, records remain capacity-accounted and durable.
   */
  confirmSubmission(proof: Pick<MeshBatchProof, "generationId" | "submissionId" | "envelopeIds">): boolean {
    const batch = (["mesh-reply", "mesh-unsolicited"] as const)
      .map((lane) => this.dispatching[lane])
      .find((candidate) => candidate?.submissionId === proof.submissionId);
    if (!batch || batch.generationId !== proof.generationId) return false;
    const envelopeIds = batch.records.map((record) => record.envelope.id);
    if (!sameIds(envelopeIds, proof.envelopeIds)) return false;
    try {
      for (const record of batch.records) {
        this.options.persist?.({
          state: "submitted",
          lane: batch.lane,
          generationId: record.generationId,
          envelope: record.envelope,
          submissionId: batch.submissionId,
        });
      }
    } catch {
      // The durable custom_message is authoritative even if this advisory
      // terminal marker fails. Keeping it dispatching would duplicate delivery;
      // startup recovery also suppresses the exact proved attempt.
      this.options.onBlocked?.("mesh-submitted-marker-failed");
    }
    delete this.dispatching[batch.lane];
    this.remove(batch.lane, batch.records);
    return true;
  }

  /** Return every proofless attempt to retained state at a genuine settlement. */
  retryUnproved(): void {
    for (const lane of ["mesh-reply", "mesh-unsolicited"] as const) {
      const batch = this.dispatching[lane];
      if (!batch) continue;
      if (!this.returnToHeld(batch)) continue;
      delete this.dispatching[lane];
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unregister?.();
    this.unregister = undefined;
    this.held["mesh-reply"] = [];
    this.held["mesh-unsolicited"] = [];
    this.pendingRestores = [];
    this.dispatching = {};
    this.totalBytes = 0;
  }

  counts(): { replies: number; unsolicited: number; bytes: number } {
    return { replies: this.held["mesh-reply"].length, unsolicited: this.held["mesh-unsolicited"].length, bytes: this.totalBytes };
  }

  private handleSnapshot(snapshot: Snapshot): void {
    if (this.disposed) return;
    this.restorePending(snapshot);
    this.ensureRegistration(snapshot);
    if (snapshot.registryState === "ready" && snapshot.phase === "idle") {
      this.flush("mesh-reply", snapshot);
      this.flush("mesh-unsolicited", snapshot);
    }
  }

  private ensureRegistration(snapshot: Snapshot): void {
    const sessionId = this.options.getSessionId();
    if (snapshot.registryState !== "ready" || !sessionId || snapshot.sessionId !== sessionId || !snapshot.generationId) {
      this.unregister?.();
      this.unregister = undefined;
      this.registeredSessionId = undefined;
      this.registeredGenerationId = undefined;
      return;
    }
    if (this.registeredSessionId === sessionId && this.registeredGenerationId === snapshot.generationId) return;
    this.unregister?.();
    try {
      const releases = (["mesh-reply", "mesh-unsolicited"] as const).map((lane) => this.authority.registerDrainer({
        consumerId: REMOTE_PI_MESH_CONSUMER_ID,
        laneId: lane,
        generationId: snapshot.generationId!,
        capture: () => this.capture(lane),
        drain: (permit) => this.drain(lane, permit),
      }));
      this.unregister = () => { for (const release of releases) release(); };
      this.registeredSessionId = sessionId;
      this.registeredGenerationId = snapshot.generationId;
    } catch {
      this.unregister = undefined;
      this.registeredSessionId = undefined;
      this.registeredGenerationId = undefined;
      if (this.options.mode === "managed") this.options.onBlocked?.("mesh-drainer-registration-failed");
    }
  }

  private capture(lane: MeshLane): { watermark: number; heldCount: number } {
    const records = this.held[lane];
    return { watermark: this.nextSequence, heldCount: records.filter((record) => record.sequence <= this.nextSequence).length };
  }

  private drain(lane: MeshLane, permit: ReleasePermit): DrainAck {
    if (this.dispatching[lane]) return this.ack(permit, "blocked", 0, 0);
    const records = this.recordsAtOrBefore(lane, permit.cut.watermark);
    if (records.length !== permit.cut.heldCount) return this.ack(permit, "blocked", 0, 0);
    if (records.length === 0) return this.ack(permit, "empty", 0, 0);
    if (!this.runtimeIdle()) return this.ack(permit, "blocked", 0, 0);
    const snapshot = this.authority.snapshot();
    if (this.admitLane(lane, snapshot, `release:${permit.releaseId}`, permit) !== "deliver") return this.ack(permit, "blocked", 0, 0);
    if (!this.submit(lane, records)) return this.ack(permit, "blocked", 0, 0);
    return this.ack(permit, "submitted", 1, records.length);
  }

  private flush(lane: MeshLane, snapshot: Snapshot): void {
    if (this.flushing.has(lane) || this.dispatching[lane]) return;
    const records = this.recordsAtOrBefore(lane, this.nextSequence);
    if (records.length === 0 || !this.runtimeIdle() || this.admitLane(lane, snapshot, `${lane}:${this.nextSequence}`) !== "deliver") return;
    this.flushing.add(lane);
    try {
      if (!this.submit(lane, records) && this.options.mode === "managed") this.options.onBlocked?.("mesh-submit-failed");
    } finally {
      this.flushing.delete(lane);
    }
  }

  private admitLane(lane: MeshLane, snapshot: Snapshot, wakeId: string, permit?: ReleasePermit): "deliver" | "hold" | "blocked" {
    const sessionId = this.options.getSessionId();
    if (snapshot.registryState !== "ready" || !sessionId || snapshot.sessionId !== sessionId || !snapshot.generationId) return this.options.mode === "compatibility" ? "deliver" : "blocked";
    this.ensureRegistration(snapshot);
    if (this.options.mode === "managed" && this.registeredGenerationId !== snapshot.generationId) return "blocked";
    const outcome = this.authority.admitWake({ consumerId: REMOTE_PI_MESH_CONSUMER_ID, laneId: lane, wakeId, sessionId, generationId: snapshot.generationId, source: "remote-pi-mesh" }, permit);
    if (outcome.disposition === "deliver") return "deliver";
    if (outcome.disposition === "hold") return "hold";
    return this.options.mode === "compatibility" ? "deliver" : "blocked";
  }

  private submit(lane: MeshLane, records: readonly HeldEnvelope[]): boolean {
    if (records.length === 0 || this.dispatching[lane] || !this.runtimeIdle()) return false;
    const batch: DispatchingBatch = {
      lane,
      submissionId: randomUUID(),
      generationId: records[0]!.generationId,
      records,
    };
    this.dispatching[lane] = batch;
    try {
      // The intent precedes the public SDK call, but is not a tombstone. The
      // exact Pi custom-message proof is the only path to `submitted`+remove.
      for (const record of records) {
        this.options.persist?.({
          state: "submitting",
          lane,
          generationId: record.generationId,
          envelope: record.envelope,
          submissionId: batch.submissionId,
        });
      }
    } catch {
      if (this.returnToHeld(batch)) delete this.dispatching[lane];
      return false;
    }
    try {
      if (this.options.submit(
        lane,
        records.map((record) => record.envelope),
        batch.submissionId,
        batch.generationId,
      )) return true;
    } catch {
      // The append-only retained state below keeps the attempt replayable.
    }
    if (this.returnToHeld(batch)) delete this.dispatching[lane];
    return false;
  }

  private restorePending(snapshot: Snapshot): void {
    if (snapshot.registryState !== "ready" || snapshot.sessionId !== this.options.getSessionId() || !snapshot.generationId) return;
    const pending = this.pendingRestores;
    this.pendingRestores = [];
    for (const record of pending) {
      const generationId = snapshot.generationId;
      if (record.generationId !== generationId) this.options.onBlocked?.("rebound-mesh-spool-generation");
      const bytes = Buffer.byteLength(serialize(record.envelope), "utf8");
      if (bytes > MAX_MESH_ENVELOPE_BYTES || this.heldCount() >= MAX_MESH_ENVELOPES || this.totalBytes + bytes > MAX_MESH_TOTAL_BYTES) {
        this.options.onBlocked?.("restored-mesh-spool-capacity");
        continue;
      }
      this.held[record.lane].push({ sequence: ++this.nextSequence, bytes, generationId, envelope: record.envelope });
      this.totalBytes += bytes;
    }
  }

  private returnToHeld(batch: DispatchingBatch): boolean {
    try {
      for (const record of batch.records) {
        this.options.persist?.({
          state: "held",
          lane: batch.lane,
          generationId: record.generationId,
          envelope: record.envelope,
        });
      }
      return true;
    } catch {
      this.options.onBlocked?.("mesh-retry-marker-failed");
      return false;
    }
  }

  private runtimeIdle(): boolean {
    return this.options.isRuntimeIdle?.() ?? true;
  }

  private remove(lane: MeshLane, records: readonly HeldEnvelope[]): void {
    const set = new Set(records);
    this.held[lane] = this.held[lane].filter((record) => !set.has(record));
    for (const record of records) {
      this.totalBytes -= record.bytes;
      this.options.onTransition?.({ id: record.envelope.id, lane, outcome: "released", generationId: record.generationId });
    }
  }

  private recordsAtOrBefore(lane: MeshLane, watermark: number): HeldEnvelope[] {
    return this.held[lane].filter((record) => record.sequence <= watermark).sort((left, right) => left.sequence - right.sequence);
  }

  private heldCount(): number {
    return this.held["mesh-reply"].length + this.held["mesh-unsolicited"].length;
  }

  private ack(permit: ReleasePermit, disposition: DrainAck["disposition"], submittedCount: number, handledCount: number): DrainAck {
    return { releaseId: permit.releaseId, consumerId: REMOTE_PI_MESH_CONSUMER_ID, laneId: permit.laneId, disposition, submittedCount, handledCount, handledThrough: permit.cut.watermark };
  }

  private denied(code: string): MeshAcceptance {
    if (this.options.mode === "managed") this.options.onBlocked?.(code);
    return { status: "denied", code };
  }
}
