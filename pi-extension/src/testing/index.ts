import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  RemotePiProbeAdapter,
  type RemotePiProbeInjection,
  type RemotePiProbeReceipt,
} from "./remote_pi_probe.js";

export type ExactCandidateProbeInjection = RemotePiProbeInjection;
export type ExactCandidateProbeReceipt = RemotePiProbeReceipt;

export interface ExactCandidateProbeOptions {
  /** Documented public SDK session supplied by the archive candidate runner. */
  readonly session: AgentSession;
  readonly seed: string | number;
  /** Archive package directory; resolution is performed by the lifecycle loader. */
  readonly packageDirectory: string;
}

export interface ExactCandidateProbe {
  readonly consumer: "remote-pi";
  inject(input: ExactCandidateProbeInjection): Promise<Readonly<ExactCandidateProbeReceipt>>;
  observations(): Promise<readonly Readonly<ExactCandidateProbeReceipt>[]>;
  dispose(): Promise<void>;
}

/**
 * Typed, archive-included testing seam for Remote Pi's actual lifecycle action
 * and mesh-admission ingress paths. It never opens a relay or reads a profile.
 */
export function createExactCandidateProbe(options: ExactCandidateProbeOptions): ExactCandidateProbe {
  const adapter = new RemotePiProbeAdapter(options);
  return Object.freeze({
    consumer: "remote-pi" as const,
    inject: async (input: ExactCandidateProbeInjection) => adapter.inject(input),
    observations: async () => adapter.observations(),
    dispose: async () => adapter.dispose(),
  });
}
