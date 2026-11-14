import type { GoalStrategy, WorldMemory } from "@craftmate/contracts";
import type { GoalId, Task, WorldFacts } from "../survival/types.ts";

export type PlaybookGroup =
  | "safety"
  | "recovery"
  | "food"
  | "home"
  | "mine"
  | "craft"
  | "explore"
  | "combat"
  | "progress";

export type CardStatus = "available" | "blocked" | "done";
export type CardRisk = "low" | "medium" | "high";

/** Minimum confidence for a remembered place to satisfy a hard precondition. */
export const HARD_MEMORY_CONFIDENCE = 0.7;

/**
 * Stale or low-confidence landmarks remain useful context for the model, but
 * they must never prove that a safe mine exit or station exists.
 */
export function memorySatisfiesPrecondition(
  memory: WorldMemory,
  now: number,
  minConfidence = HARD_MEMORY_CONFIDENCE,
): boolean {
  if (memory.confidence < minConfidence) return false;
  return memory.expiresAt === null || memory.expiresAt > now;
}

export interface CardContext {
  readonly stage: GoalId;
  readonly facts: WorldFacts;
  readonly strategy: GoalStrategy;
  readonly lastFailure: string | null;
  /** Strategy key that produced `lastFailure`, for segmented recovery. */
  readonly lastStrategy?: string | null;
  readonly consecutiveFailures: number;
  readonly memory: readonly WorldMemory[];
  readonly now: number;
  readonly newId: () => string;
}

export interface CardEvaluation {
  readonly card: PlaybookCard;
  readonly status: CardStatus;
  readonly reason: string;
  readonly task: Task | null;
  readonly blockedReason: string | null;
}

export interface PlaybookCard {
  readonly id: string;
  readonly title: string;
  readonly group: PlaybookGroup;
  readonly stage: GoalId | "any";
  readonly priority: number;
  readonly risk: CardRisk;
  /** A state gate; the planner executes it without asking the model. */
  readonly critical: boolean;
  readonly minDwellMs: number;
  readonly expectedEvidence: readonly string[];
  readonly recovery: readonly string[];
  readonly stopConditions: readonly string[];
  readonly evaluate: (context: CardContext) => CardEvaluation;
}

export function cardEvaluation(
  card: PlaybookCard,
  status: CardStatus,
  reason: string,
  task: Task | null = null,
): CardEvaluation {
  return {
    card,
    status,
    reason,
    task,
    blockedReason: status === "blocked" ? reason : null,
  };
}
