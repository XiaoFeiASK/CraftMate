import {
  hasUsablePickaxe,
  worldFactsFromSnapshot,
  type WorldFacts,
} from "@craftmate/agent/domain";
import type { WorldSnapshot } from "@craftmate/contracts";

export interface MonitoredDecision {
  readonly text: string;
  readonly at: number;
  readonly skill: {
    readonly name: string;
    readonly args: Record<string, unknown>;
  } | null;
}

export interface StateMonitorInput {
  readonly stage: string;
  readonly decision: MonitoredDecision | null;
  readonly world: WorldSnapshot | null;
  readonly now: number;
  readonly lastPreemptAt: number;
  readonly cooldownMs?: number;
}

export interface StateOpportunity {
  /** Stable reason key used for cooldown and diagnostics. */
  readonly key: "low-health" | "tool-recovery" | "visible-iron";
  readonly reason: string;
  readonly detail: string;
}

const DEFAULT_COOLDOWN_MS = 8_000;
const MIN_TASK_AGE_MS = 3_500;
const STAGE_ORDER = [
  "wood-and-table",
  "stone-tools",
  "food",
  "shelter",
  "iron",
  "nether",
  "eyes",
  "stronghold",
  "dragon",
] as const;
const HOSTILE =
  /zombie|husk|drowned|skeleton|stray|creeper|spider|witch|pillager|vindicator|evoker|ravager|enderman|slime|magma_cube|blaze|ghast|warden/iu;
const IRON_ORE = /(^|:)iron_ore$/u;

/**
 * A pure state gate for the execution loop. The deterministic planner already
 * chooses tasks from facts, but a long skill can become the wrong task while
 * it is running: the body loses its pickaxe, a visible ore appears, or health
 * drops. This function only answers whether the current skill should yield;
 * the planner still owns the replacement action.
 */
export function detectStateOpportunity(
  input: StateMonitorInput,
): StateOpportunity | null {
  const decision = input.decision;
  if (decision === null || decision.skill === null) return null;
  if (input.now - decision.at < MIN_TASK_AGE_MS) return null;
  const cooldown = input.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  if (input.now - input.lastPreemptAt < cooldown) return null;

  const facts = worldFactsFromSnapshot(
    input.world as Parameters<typeof worldFactsFromSnapshot>[0],
  );
  const stageIndex = STAGE_ORDER.indexOf(input.stage as (typeof STAGE_ORDER)[number]);
  if (stageIndex < STAGE_ORDER.indexOf("stone-tools")) return null;
  const skillName = decision.skill.name;
  const isNavigation = skillName === "goto";
  const isResourceWork =
    skillName === "mine_block" || skillName === "chop_tree";

  const lowHealth = healthOpportunity(facts, decision);
  if (lowHealth !== null) return lowHealth;

  const tool = toolRecoveryOpportunity(facts, decision, stageIndex, isNavigation);
  if (tool !== null) return tool;

  const ore = visibleIronOpportunity(facts, decision, isNavigation, isResourceWork);
  if (ore !== null) return ore;
  return null;
}

function healthOpportunity(
  facts: WorldFacts,
  decision: MonitoredDecision,
): StateOpportunity | null {
  const health = facts.health;
  if (health === undefined || health === null || health > 10) return null;
  if (/低血量撤离|击退近身威胁|进食/u.test(decision.text)) return null;
  const threat = (facts.entities ?? []).find(
    (entity) => HOSTILE.test(entity.type) && entity.distance <= 8,
  );
  if (threat === undefined) return null;
  if (decision.skill?.name === "attack" || decision.skill?.name === "eat") return null;
  return {
    key: "low-health",
    reason: `低血量且 ${threat.name} 在 ${Math.round(threat.distance)} 格内，切换为保命决策`,
    detail: "health dropped while a hostile is close; cancel the long task and replan",
  };
}

function toolRecoveryOpportunity(
  facts: WorldFacts,
  decision: MonitoredDecision,
  stageIndex: number,
  isNavigation: boolean,
): StateOpportunity | null {
  if (stageIndex > STAGE_ORDER.indexOf("iron")) return null;
  if (hasUsablePickaxe(facts)) return null;
  const isResourceWork =
    decision.skill?.name === "mine_block" || decision.skill?.name === "chop_tree";
  if (!isNavigation && !isResourceWork) return null;
  // These are already recovery tasks. Interrupting them would recreate the
  // same plan and spend the whole cooldown dancing in place.
  if (/(镐|工作台|修复|返回地表|挖阶梯)/u.test(decision.text)) return null;
  return {
    key: "tool-recovery",
    reason: "镐已损坏或耗尽，先恢复工具再继续长途移动",
    detail: "no usable pickaxe while a travel or mining task is in flight",
  };
}

function visibleIronOpportunity(
  facts: WorldFacts,
  decision: MonitoredDecision,
  isNavigation: boolean,
  isResourceWork: boolean,
): StateOpportunity | null {
  if ((!isNavigation && !isResourceWork) || !hasUsablePickaxe(facts, 2)) return null;
  // A one-cell blueprint/mine step finishes in seconds. Interrupting it to
  // "mine the visible ore first" is exactly the left/right fight that made
  // the body abandon half-placed blocks and half-dug stairs.
  if (decision.skill?.args["at"] !== undefined) return null;
  if (/(工作台|熔炉|镐|返回地表|挖阶梯|建房|小屋|营地|回家|箱子|储物|复用矿道)/u.test(decision.text)) {
    return null;
  }
  const currentBlock = String(decision.skill?.args["block"] ?? "");
  // Do not interrupt the ore we already chose, or a reclaim of our own field
  // station, just because another iron block is nearby.
  if (IRON_ORE.test(currentBlock) || /^(minecraft:)?(crafting_table|furnace)$/u.test(currentBlock)) {
    return null;
  }
  const ore = (facts.nearbyBlocks ?? [])
    .filter(
      (block) =>
        IRON_ORE.test(block.id) &&
        block.visible === true &&
        block.x !== undefined &&
        block.y !== undefined &&
        block.z !== undefined &&
        (block.distance ?? Number.POSITIVE_INFINITY) <= 10,
    )
    .sort(
      (left, right) =>
        (left.distance ?? Number.POSITIVE_INFINITY) -
        (right.distance ?? Number.POSITIVE_INFINITY),
    )[0];
  if (ore === undefined) return null;
  return {
    key: "visible-iron",
    reason: "视野内出现可采铁矿，先挖眼前资源",
    detail: `visible iron ore ${Math.round(ore.distance ?? 0)} blocks away`,
  };
}
