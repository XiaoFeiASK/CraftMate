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
  /** Recent body incidents, oldest first; game facts, not instructions. */
  readonly incidents?: readonly { readonly kind: string; readonly detail: string }[];
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

export interface GoalTaskChoiceRequest {
  /** Trusted system framing. World facts are passed separately as data. */
  readonly instructions: string;
  readonly goalTitle: string;
  readonly goalDescription: string;
  readonly stageTitle: string;
  readonly milestoneTitle: string;
  /** Deterministic, body-validated choices. The model may only pick an id. */
  readonly candidates: readonly {
    readonly id: string;
    readonly title: string;
    readonly skill: string;
    readonly rationale: string;
    readonly expectedEvidence: readonly string[];
  }[];
  readonly recentFailure: string | null;
  /** Newest last; lets the model avoid repeating a disproven action. */
  readonly recentFailures: readonly {
    readonly stage: string;
    readonly code: string;
    readonly detail: string;
    readonly attempts: number;
  }[];
  /** Observed game facts; untrusted values stay data. */
  readonly world: unknown;
  readonly signal: AbortSignal;
}

export interface GoalTaskChoiceResult {
  readonly candidateId: string;
  readonly reason: string;
  /** One short, natural line the body can say while starting the task. */
  readonly speech?: string;
  readonly provider: string;
  readonly model: string;
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
  /**
   * Goal mode uses a narrower contract than audience planning: the model
   * ranks already-validated tasks and never authors a skill or arguments.
   */
  chooseGoalTask?(request: GoalTaskChoiceRequest): Promise<GoalTaskChoiceResult>;
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
