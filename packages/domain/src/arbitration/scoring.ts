import type { Intent } from "@craftmate/protocol";
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
  execute: 0.7,
  acknowledge: 0.45,
  queue: 0.3,
} as const;

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
  const feasibility = intent === "danger" ? 0.2 : 0.85;
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
