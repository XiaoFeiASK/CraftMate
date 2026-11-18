import type { GoalKind } from "@craftmate/contracts";
import { hasItem } from "./facts.ts";
import { STAGE_ORDER, type GoalId, type WorldFacts } from "./types.ts";

export const DIAMOND_SET_ITEMS = [
  "minecraft:diamond_pickaxe",
  "minecraft:diamond_sword",
  "minecraft:diamond_helmet",
  "minecraft:diamond_chestplate",
  "minecraft:diamond_leggings",
  "minecraft:diamond_boots",
] as const;

const DIAMOND_STAGE_INDEX = STAGE_ORDER.indexOf("diamond-gear");

/** The stages a goal may visit. A diamond run does not need the end game. */
export const GOAL_STAGE_SCOPE: Readonly<Record<GoalKind, readonly GoalId[]>> = {
  dragon: STAGE_ORDER,
  "diamond-set": STAGE_ORDER.slice(0, DIAMOND_STAGE_INDEX + 1),
};

export function stageScopeFor(kind: GoalKind): readonly GoalId[] {
  return GOAL_STAGE_SCOPE[kind] ?? STAGE_ORDER;
}

export function goalAcceptanceMet(kind: GoalKind, facts: WorldFacts): boolean {
  if (kind === "dragon") return facts.dragonDefeated === true;
  return DIAMOND_SET_ITEMS.every((item) => hasItem(facts, item));
}
