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

export interface MeshSpoolOptions {
  mode: MeshSpoolMode;
  getSessionId(): string | null;
  /** Starts exactly one model submission for this ordered lane batch. */
  submit(lane: MeshLane, envelopes: readonly Envelope[], submissionId: string, generationId: string): boolean;
  /** Domain-owned persistence hook; the lifecycle registry never receives bodies. */
  persist?(event: { state: "held" | "submitting" | "submitted"; lane: MeshLane; generationId: string; envelope: Envelope; submissionId?: string }): void;
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

  /** Re-evaluate admission after restoring domain-owned records. */
  reconcile(): void {
    this.handleSnapshot(this.authority.snapshot());
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
    const records = this.recordsAtOrBefore(lane, permit.cut.watermark);
    if (records.length !== permit.cut.heldCount) return this.ack(permit, "blocked", 0, 0);
    if (records.length === 0) return this.ack(permit, "empty", 0, 0);
    const snapshot = this.authority.snapshot();
    if (this.admitLane(lane, snapshot, `release:${permit.releaseId}`, permit) !== "deliver") return this.ack(permit, "blocked", 0, 0);
    if (!this.submit(lane, records)) return this.ack(permit, "blocked", 0, 0);
    this.remove(lane, records);
    return this.ack(permit, "submitted", 1, records.length);
  }

  private flush(lane: MeshLane, snapshot: Snapshot): void {
    if (this.flushing.has(lane)) return;
    const records = this.recordsAtOrBefore(lane, this.nextSequence);
    if (records.length === 0 || this.admitLane(lane, snapshot, `${lane}:${this.nextSequence}`) !== "deliver") return;
    this.flushing.add(lane);
    try {
      if (this.submit(lane, records)) this.remove(lane, records);
      else if (this.options.mode === "managed") this.options.onBlocked?.("mesh-submit-failed");
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
    const submissionId = randomUUID();
    try {
      // Intent precedes the public SDK send. A reload reconciles it against the
      // durable custom-message submission proof before deciding whether replay
      // is safe, closing both send→tombstone and intent→send crash windows.
      for (const record of records) this.options.persist?.({ state: "submitting", lane, generationId: record.generationId, envelope: record.envelope, submissionId });
    } catch {
      return false;
    }
    try {
      if (!this.options.submit(lane, records.map((record) => record.envelope), submissionId, records[0]!.generationId)) return false;
    } catch {
      return false;
    }
    try {
      for (const record of records) this.options.persist?.({ state: "submitted", lane, generationId: record.generationId, envelope: record.envelope, submissionId });
    } catch {
      // Pi's custom-message entry is the submission proof. Do not retry it in
      // this runtime merely because the advisory terminal marker failed.
      this.options.onBlocked?.("mesh-submitted-marker-failed");
    }
    return true;
  }

  private restorePending(snapshot: Snapshot): void {
    if (snapshot.registryState !== "ready" || snapshot.sessionId !== this.options.getSessionId() || !snapshot.generationId) return;
    const pending = this.pendingRestores;
    this.pendingRestores = [];
    for (const record of pending) {
      if (record.generationId !== snapshot.generationId) {
        this.options.onBlocked?.("stale-mesh-spool-generation");
        continue;
      }
      const bytes = Buffer.byteLength(serialize(record.envelope), "utf8");
      if (bytes > MAX_MESH_ENVELOPE_BYTES || this.heldCount() >= MAX_MESH_ENVELOPES || this.totalBytes + bytes > MAX_MESH_TOTAL_BYTES) {
        this.options.onBlocked?.("restored-mesh-spool-capacity");
        continue;
      }
      this.held[record.lane].push({ sequence: ++this.nextSequence, bytes, generationId: record.generationId, envelope: record.envelope });
      this.totalBytes += bytes;
    }
  }

  private remove(lane: MeshLane, records: readonly HeldEnvelope[]): void {
    const set = new Set(records);
    this.held[lane] = this.held[lane].filter((record) => !set.has(record));
    for (const record of records) this.totalBytes -= record.bytes;
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
