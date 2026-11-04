import type { PersonaSummary, SkillCall } from "@craftmate/contracts";

export interface PlanRequest {
  /** Trusted system framing. Never contains audience text. */
  readonly instructions: string;
  /** The audience line, passed as untrusted data in its own channel. */
  readonly audienceText: string;
  readonly nickname: string;
  readonly intent: string;
  readonly goal: string;
  readonly persona: PersonaSummary;
  /** Approved memories only; the caller filters, the model never does. */
  readonly memories: readonly string[];
  /** Semantic game observation from the body; untrusted values stay data. */
  readonly world?: unknown;
  /** Skills advertised by the connected body at planning time. */
  readonly availableSkills?: readonly string[];
  readonly signal: AbortSignal;
}

export interface PlanResult {
  /** What the character says out loud; empty means "stay silent". */
  readonly speech: string;
  readonly skill: SkillCall | null;
  readonly reason: string;
  readonly provider: string;
  readonly model: string;
  /** Token usage when the provider reports it; used by the cost ledger. */
  readonly usage?: { readonly prompt: number; readonly completion: number };
}

/**
 * Text provider boundary. Implementations own transport and vendor auth; the
 * agent owns validation, timeouts and fallbacks.
 */
export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  plan(request: PlanRequest): Promise<PlanResult>;
}

/** Distinguishes "slow" from "broken" so the caller can degrade differently. */
export class ModelTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelTimeoutError";
  }
}

export class ModelInvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelInvalidOutputError";
  }
}
