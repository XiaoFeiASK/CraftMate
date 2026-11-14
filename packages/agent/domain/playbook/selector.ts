import {
  routeBlacklistCovers,
  type GoalStrategy,
  type SkillCall,
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
  const filtered = filterRouteBlacklist(
    context.facts,
    evaluation.task.skill,
    context.now,
  );
  if (filtered.refusal === null) {
    return {
      ...evaluation,
      task: {
        ...evaluation.task,
        skill: filtered.skill,
      },
    };
  }
  return {
    ...evaluation,
    status: "blocked",
    reason: filtered.refusal,
    blockedReason: filtered.refusal,
    task: null,
  };
}

/**
 * Normal walking and target selection obey durable route refusals. An
 * explicit dig/recover may retry a non-hazard refusal (the operator's
 * "override once" path), but never a hazard. Exported so the mainline
 * candidate, which is assembled outside the card catalog, uses the same rule.
 */
export function routeBlacklistRefusal(
  facts: CardContext["facts"],
  skill: { readonly name: string; readonly args: Record<string, unknown> },
  now: number,
): string | null {
  return filterRouteBlacklist(facts, skill as SkillCall, now).refusal;
}

interface RouteBlacklistFilter {
  readonly skill: SkillCall;
  readonly refusal: string | null;
}

function pointOf(value: unknown): { x: number; y: number; z: number } | null {
  if (
    value === null ||
    typeof value !== "object" ||
    !("x" in value) ||
    !("y" in value) ||
    !("z" in value)
  ) {
    return null;
  }
  const point = value as { x?: unknown; y?: unknown; z?: unknown };
  return typeof point.x === "number" &&
    typeof point.y === "number" &&
    typeof point.z === "number"
    ? { x: point.x, y: point.y, z: point.z }
    : null;
}

/**
 * A refusal applies to a *cell*, not to the whole errand. A chest with its
 * west standing cell blacklisted still has three other sides; blocking the
 * entire `home.store` card over one bad cell left the live body standing
 * beside its own camp with every card blocked. Drop blocked cells from the
 * candidate list and only refuse the action when no usable destination is
 * left.
 */
export function filterRouteBlacklist(
  facts: CardContext["facts"],
  skill: SkillCall,
  now: number,
): RouteBlacklistFilter {
  if (skill.name !== "goto") return { skill, refusal: null };
  const args = skill.args as Record<string, unknown>;
  const mode = args.mode === "dig" || args.mode === "recover" ? args.mode : "walk";
  const target = pointOf(args.target);
  const candidates: Array<{ x: number; y: number; z: number }> = [];
  if (Array.isArray(args.candidates)) {
    for (const candidate of args.candidates) {
      const point = pointOf(candidate);
      if (point !== null) candidates.push(point);
    }
  }
  const blocked = (point: { x: number; y: number; z: number }): boolean =>
    (facts.routeBlacklist ?? []).some(
      (entry) =>
        routeBlacklistCovers(entry, point, now) &&
        (mode === "walk" || entry.kind === "hazard"),
    );
  const isBlocked = (point: { x: number; y: number; z: number } | null): boolean =>
    point !== null && blocked(point);
  const targetBlocked = isBlocked(target);
  const safeCandidates = candidates.filter((candidate) => !blocked(candidate));
  // A locked or canonical target may not appear in `candidates` at all. Treat
  // it as the first preference so a walk never silently switches direction
  // just because the planner's old primary cell was refused.
  const safeTarget =
    target !== null && !targetBlocked ? target : safeCandidates[0] ?? null;
  if (safeTarget === null) {
    const blocking = target ?? candidates[0] ?? null;
    return {
      skill,
      refusal:
        blocking === null
          ? `路线黑名单拒绝 ${mode} 目标`
          : `路线黑名单拒绝 ${mode} 目标 (${blocking.x}, ${blocking.y}, ${blocking.z})`,
    };
  }
  const deduped: Array<{ x: number; y: number; z: number }> = [];
  const seen = new Set<string>();
  for (const point of [safeTarget, ...safeCandidates]) {
    const key = `${point.x},${point.y},${point.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(point);
    if (deduped.length === 8) break;
  }
  return {
    skill: {
      ...skill,
      args: {
        ...args,
        target: safeTarget,
        ...(Array.isArray(args.candidates)
          ? { candidates: deduped }
          : {}),
      },
    },
    refusal: null,
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
