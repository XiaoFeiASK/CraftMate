import {
  routeBlacklistCovers,
  type GoalStrategy,
} from "@craftmate/contracts";
import type { CardContext, CardEvaluation } from "./types.ts";
import { playbookCards } from "./cards.ts";

function skillKey(evaluation: CardEvaluation): string | null {
  if (evaluation.status !== "available" || evaluation.task === null) return null;
  return `${evaluation.task.skill.name}:${JSON.stringify(evaluation.task.skill.args)}`;
}

/**
 * Evaluate every card, then hide duplicate actions behind the highest-priority
 * card. The model still sees blocked cards, because "why can't I do this" is
 * useful context; it does not see the same action five times.
 */
export function evaluatePlaybook(
  context: CardContext,
  strategy: GoalStrategy,
): readonly CardEvaluation[] {
  const cards = playbookCards(strategy);
  // Card evaluators close over their construction-time object. Normalise the
  // returned evaluation to the catalog copy so live strategy changes (for
  // example the operator's minimum dwell) cannot be lost.
  const raw = cards.map((card) => {
    const evaluation = card.evaluate(context);
    return evaluation.card === card ? evaluation : { ...evaluation, card };
  });
  const bestBySkill = new Map<string, CardEvaluation>();
  for (const evaluation of raw) {
    const key = skillKey(evaluation);
    if (key === null) continue;
    const current = bestBySkill.get(key);
    if (current === undefined || evaluation.card.priority > current.card.priority) {
      bestBySkill.set(key, evaluation);
    }
  }
  const keptActions = new Set(
    [...bestBySkill.values()].map((evaluation) => evaluation.card.id),
  );
  return raw.map((evaluation) => {
    const deduped =
      evaluation.status === "available" && !keptActions.has(evaluation.card.id)
        ? {
            ...evaluation,
            status: "blocked" as const,
            reason: "与更高优先级卡产生同一动作",
            blockedReason: "与更高优先级卡产生同一动作",
            task: null,
          }
        : evaluation;
    return applyRouteBlacklist(context, deduped);
  });
}

/**
 * Normal walking and target selection obey durable route refusals. An
 * explicit dig/recover may retry a non-hazard refusal (the operator's
 * "override once" path), but never a hazard.
 */
function applyRouteBlacklist(
  context: CardContext,
  evaluation: CardEvaluation,
): CardEvaluation {
  if (
    evaluation.status !== "available" ||
    evaluation.task === null ||
    evaluation.task.skill.name !== "goto"
  ) {
    return evaluation;
  }
  const args = evaluation.task.skill.args;
  const mode = args.mode === "dig" || args.mode === "recover" ? args.mode : "walk";
  const points: Array<{ x: number; y: number; z: number }> = [];
  const target = args.target;
  if (
    target !== null &&
    typeof target === "object" &&
    "x" in target &&
    "y" in target &&
    "z" in target &&
    typeof target.x === "number" &&
    typeof target.y === "number" &&
    typeof target.z === "number"
  ) {
    points.push({ x: target.x, y: target.y, z: target.z });
  }
  if (Array.isArray(args.candidates)) {
    for (const candidate of args.candidates) {
      if (
        candidate !== null &&
        typeof candidate === "object" &&
        "x" in candidate &&
        "y" in candidate &&
        "z" in candidate &&
        typeof candidate.x === "number" &&
        typeof candidate.y === "number" &&
        typeof candidate.z === "number"
      ) {
        points.push({ x: candidate.x, y: candidate.y, z: candidate.z });
      }
    }
  }
  const blocking = points.find((point) =>
    (context.facts.routeBlacklist ?? []).some(
      (entry) =>
        routeBlacklistCovers(entry, point, context.now) &&
        (mode === "walk" || entry.kind === "hazard"),
    ),
  );
  if (blocking === undefined) return evaluation;
  const reason = `路线黑名单拒绝 ${mode} 目标 (${blocking.x}, ${blocking.y}, ${blocking.z})`;
  return {
    ...evaluation,
    status: "blocked",
    reason,
    blockedReason: reason,
    task: null,
  };
}

/** Deterministic fallback: safety first, then recovery, progression, home and exploration. */
export function selectPlaybookCard(
  evaluations: readonly CardEvaluation[],
): CardEvaluation | null {
  return (
    evaluations
      .filter((evaluation) => evaluation.status === "available" && evaluation.task !== null)
      .sort((left, right) => right.card.priority - left.card.priority)[0] ?? null
  );
}

export function availableCards(
  evaluations: readonly CardEvaluation[],
): readonly CardEvaluation[] {
  return evaluations.filter(
    (evaluation) => evaluation.status === "available" && evaluation.task !== null,
  );
}
