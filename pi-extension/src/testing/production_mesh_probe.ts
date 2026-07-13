import type { MeshLane } from "../session/mesh_spool.js";

export interface ProductionMeshProbeInjection {
  readonly id: string;
  readonly lane: MeshLane;
}

/** Redacted production receipt; it deliberately excludes envelope data. */
export interface ProductionMeshProbeTransition {
  readonly id: string;
  readonly lane: MeshLane;
  readonly outcome: "held" | "released";
  readonly generationId: string;
}

export interface ProductionMeshProbe {
  readonly sessionId: string;
  accept(input: ProductionMeshProbeInjection): { status: "received" } | { status: "denied"; code: string };
  observe(listener: (transition: ProductionMeshProbeTransition) => void): () => void;
}

interface ActiveProbe {
  readonly sessionId: string;
  readonly accept: ProductionMeshProbe["accept"];
  readonly listeners: Set<(transition: ProductionMeshProbeTransition) => void>;
}

interface ProbeRegistry {
  active: ActiveProbe | undefined;
}

const registryKey = Symbol.for("remote-pi.testing.production-mesh-probe.v1");

function registry(): ProbeRegistry {
  const host = globalThis as Record<PropertyKey, unknown>;
  const existing = host[registryKey];
  if (existing && typeof existing === "object") return existing as ProbeRegistry;
  const created: ProbeRegistry = { active: undefined };
  host[registryKey] = created;
  return created;
}

/**
 * Binds the archive testing subpath to the currently loaded Remote Pi extension
 * instance. The production extension alone owns the MeshSpool and its lifecycle
 * registration; this registry deliberately holds no gate or queued envelopes.
 */
export function bindProductionMeshProbe(sessionId: string, accept: ProductionMeshProbe["accept"]): {
  publish(transition: ProductionMeshProbeTransition): void;
  dispose(): void;
} {
  const probe: ActiveProbe = { sessionId, accept, listeners: new Set() };
  registry().active = probe;
  return {
    publish(transition) {
      if (registry().active !== probe) return;
      for (const listener of probe.listeners) listener(Object.freeze({ ...transition }));
    },
    dispose() {
      if (registry().active === probe) registry().active = undefined;
      probe.listeners.clear();
    },
  };
}

export function productionMeshProbe(sessionId: string): ProductionMeshProbe | undefined {
  const probe = registry().active;
  if (!probe || probe.sessionId !== sessionId) return undefined;
  return {
    sessionId,
    accept: probe.accept,
    observe(listener) {
      probe.listeners.add(listener);
      return () => probe.listeners.delete(listener);
    },
  };
}
