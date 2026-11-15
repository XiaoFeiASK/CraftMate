import type { GoalId } from "../survival/types.ts";

/**
 * Structured survival knowledge. These are strategy facts, not prompt text:
 * every number below is consumed by the planner and can be unit-tested.
 */
export interface EquipmentRequirement {
  readonly item: string;
  readonly label: string;
  readonly priority: number;
}

export const IRON_SET: readonly EquipmentRequirement[] = [
  { item: "minecraft:iron_pickaxe", label: "铁镐", priority: 10 },
  { item: "minecraft:iron_sword", label: "铁剑", priority: 20 },
  { item: "minecraft:iron_helmet", label: "铁头盔", priority: 30 },
  { item: "minecraft:iron_chestplate", label: "铁胸甲", priority: 40 },
  { item: "minecraft:iron_leggings", label: "铁护腿", priority: 50 },
  { item: "minecraft:iron_boots", label: "铁靴", priority: 60 },
] as const;

export const ACCEPTANCE_DIAMONDS = 3;

export const KNOWLEDGE = {
  iron: {
    /** ingots needed for the full set, including tools. */
    fullSetIngots: 3 + 2 + 5 + 8 + 7 + 4,
    /** Preferred safe mining band, above deepslate lava pockets. */
    miningY: 16,
    minimumPickaxeTier: 2,
    fieldStationRadius: 6,
    stationCooldownTicks: 20 * 10,
  },
  diamond: {
    /** Diamonds are most common just above bedrock lava lakes. */
    miningY: -54,
    target: ACCEPTANCE_DIAMONDS,
    minimumPickaxeTier: 3,
  },
  survival: {
    retreatHealth: 8,
    eatFood: 12,
    nightRetreatHealth: 10,
    emergencyFood: 6,
  },
  station: {
    placeOnlyForConcreteAction: true,
    preferReuseRadius: 16,
    reclaimOnlyAtJobBoundary: true,
  },
} as const;

/** Mission stages are intentionally coarser than survival milestones. */
export type MissionStage =
  | "wood-and-table"
  | "stone-tools"
  | "food"
  | "shelter"
  | "iron"
  | "diamond-gear"
  | "nether"
  | "eyes"
  | "stronghold"
  | "dragon";

export function stageForTarget(target: MissionStage): GoalId {
  return target;
}

export function acceptanceGoal(title: string): "iron-set" | "diamonds" | "full" {
  if (/末影龙|dragon|末地|要塞|末影之眼|下界|烈焰/u.test(title)) return "full";
  if (/钻石|diamond/u.test(title)) return "diamonds";
  if (/铁|iron/u.test(title)) return "iron-set";
  return "full";
}

export function missingIronSet(
  hasItem: (item: string) => boolean,
): readonly EquipmentRequirement[] {
  return IRON_SET.filter((entry) => !hasItem(entry.item)).sort(
    (left, right) => left.priority - right.priority,
  );
}
