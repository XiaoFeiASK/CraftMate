import type { Intent } from "@craftmate/contracts";
import type { PersonaWeights } from "../persona/schema.ts";

export const SCORE_WEIGHTS = {
  confidence: 0.3,
  feasibility: 0.2,
  personaFit: 0.15,
  showValue: 0.15,
  fairness: 0.1,
  cost: 0.15,
  risk: 0.2,
} as const;

export const SCORE_THRESHOLDS = {
  /**
   * Reachability matters: with the strongest possible persona term the scoring
   * formula tops out at 0.695, so a 0.7 gate made EXECUTE unreachable and the
   * whole skill pipeline dead code. 0.62 is above every non-actionable intent
   * and below a confident action intent at the default weights.
   */
  execute: 0.62,
  acknowledge: 0.45,
  queue: 0.3,
} as const;

/** Intents the body can actually carry out; chat is not one of them. */
const ACTIONABLE: ReadonlySet<Intent> = new Set([
  "move",
  "mine",
  "build",
  "craft",
  "eat",
  "follow",
]);

interface ScoreInput {
  readonly intent: Intent;
  readonly confidence: number;
  readonly textLength: number;
  readonly personaWeights: PersonaWeights;
}

/**
 * Pure scoring. Every term is explicit so the reason string can name the
 * dominant factor; nothing here reads time, network, or global state.
 */
export function scoreIntent(input: ScoreInput): number {
  const { intent, confidence, textLength, personaWeights } = input;
  // Chat has no world effect, so it must never clear the execute gate by
  // accident just because the persona is obedient.
  const feasibility = intent === "danger" ? 0.2 : ACTIONABLE.has(intent) ? 0.85 : 0.35;
  const personaFit = personaWeights.obedience * 0.8 + 0.2;
  const showValue = intent === "chat" ? 0.5 : 0.75;
  const cost = textLength > 24 ? 0.5 : 0.15;
  const risk = intent === "danger" ? 0.9 : 0.1;

  const raw =
    SCORE_WEIGHTS.confidence * confidence +
    SCORE_WEIGHTS.feasibility * feasibility +
    SCORE_WEIGHTS.personaFit * personaFit +
    SCORE_WEIGHTS.showValue * showValue +
    SCORE_WEIGHTS.fairness * 0.5 -
    SCORE_WEIGHTS.cost * cost -
    SCORE_WEIGHTS.risk * risk;

  return clamp01(raw);
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
