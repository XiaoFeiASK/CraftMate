import {
  hasItem,
  hasUsablePickaxe,
  inventoryCount,
  isNight,
  type WorldFacts,
} from "../survival/index.ts";
import {
  ACCEPTANCE_DIAMONDS,
  IRON_SET,
  KNOWLEDGE,
  acceptanceGoal,
  missingIronSet,
  type EquipmentRequirement,
  type MissionStage,
} from "./knowledge.ts";

export type MissionKind =
  | "survive"
  | "recover-tool"
  | "secure-food"
  | "acquire-station"
  | "iron-set"
  | "diamond-first-3"
  | "night-work"
  | "return-home"
  | "complete";

export interface MissionInput {
  readonly facts: WorldFacts;
  readonly goalTitle: string;
  readonly stage?: string | null;
}

export interface MissionDecision {
  readonly kind: MissionKind;
  readonly title: string;
  readonly reason: string;
  readonly stage: MissionStage;
  /** Higher utility wins at a planning boundary. */
  readonly utility: number;
  readonly missingEquipment: readonly EquipmentRequirement[];
  readonly diamonds: number;
  readonly complete: boolean;
  readonly requirements: readonly string[];
}

const STAGE_RANK: Record<MissionStage, number> = {
  "wood-and-table": 0,
  "stone-tools": 1,
  food: 2,
  shelter: 3,
  iron: 4,
  "diamond-gear": 5,
  nether: 6,
  eyes: 7,
  stronghold: 8,
  dragon: 9,
};

/**
 * One deterministic decision spine. Safety gates outrank progression, then
 * the acceptance chain is: wood/stone -> iron set -> first three diamonds.
 * The result names the stage, so the skill compiler does not have to guess
 * which of the old planner layers is in charge.
 */
export function planMission(input: MissionInput): MissionDecision {
  const { facts } = input;
  const diamonds = inventoryCount(facts, "minecraft:diamond");
  const missingEquipment = missingIronSet((item) => hasItem(facts, item));
  const acceptance = acceptanceGoal(input.goalTitle);

  if (!facts.inWorld) {
    return decision("survive", "等待进入世界", "没有世界快照，不能规划动作", "iron", 100, missingEquipment, diamonds, false, [
      "inWorld",
    ]);
  }

  const hostileClose = (facts.entities ?? []).some(
    (entity) =>
      entity.distance <= 8 &&
      /zombie|husk|drowned|skeleton|stray|creeper|spider|witch|pillager|vindicator|evoker|ravager|enderman|slime|magma_cube|blaze|ghast|warden/iu.test(
        entity.type,
      ),
  );
  if (
    (facts.health !== undefined &&
      facts.health !== null &&
      facts.health <= KNOWLEDGE.survival.retreatHealth &&
      hostileClose) ||
    (facts.health !== undefined &&
      facts.health !== null &&
      facts.health <= 4)
  ) {
    return decision(
      "survive",
      "保命优先",
      "生命值过低或近身威胁过强，先撤离再继续生产",
      "food",
      100,
      missingEquipment,
      diamonds,
      false,
      ["health", "hostile distance"],
    );
  }

  const food = facts.food ?? 20;
  const foodCount = facts.inventory.reduce(
    (total, slot) =>
      /(^|:)(bread|cooked_|baked_potato|apple|carrot|beef|porkchop|chicken|mutton|rabbit|salmon|cod)/u.test(
        slot.item,
      )
        ? total + slot.count
        : total,
    0,
  );
  if (
    food <= KNOWLEDGE.survival.eatFood &&
    foodCount === 0 &&
    !isNight(facts)
  ) {
    return decision(
      "secure-food",
      "补充食物",
      "饥饿值低于安全线且背包没有可食用食物",
      "food",
      95,
      missingEquipment,
      diamonds,
      false,
      ["food >= 12", "edible item"],
    );
  }

  if (!hasUsablePickaxe(facts, 1)) {
    return decision(
      "recover-tool",
      "恢复基础镐",
      "没有可用镐，后续采矿和铁套都无法执行",
      "stone-tools",
      92,
      missingEquipment,
      diamonds,
      false,
      ["usable pickaxe"],
    );
  }

  const needsIronSet =
    acceptance === "iron-set" || acceptance === "diamonds" || acceptance === "full";
  if (needsIronSet && missingEquipment.length > 0) {
    const stationReady =
      (facts.stations ?? []).includes("crafting_table") ||
      facts.craftingTableNearby === true ||
      (facts.craftingTable !== null && facts.craftingTable !== undefined);
    const metal =
      inventoryCount(facts, "minecraft:iron_ingot") +
      inventoryCount(facts, "minecraft:raw_iron");
    const next = missingEquipment[0];
    if (
      next !== undefined &&
      metal >= ingredientCost(next.item) &&
      !stationReady
    ) {
      return decision(
        "acquire-station",
        "建立工作台",
        `材料已够制作${next.label}，但当前没有可用工作台`,
        "iron",
        88,
        missingEquipment,
        diamonds,
        false,
        ["crafting table in reach", `${next.item} ingredients`],
      );
    }
    return decision(
      "iron-set",
      `铁套进度 ${IRON_SET.length - missingEquipment.length}/${IRON_SET.length}`,
      `下一件装备：${next?.label ?? "铁制工具"}`,
      "iron",
      80,
      missingEquipment,
      diamonds,
      false,
      [
        "usable pickaxe",
        "crafting table",
        "furnace",
        `${next?.item ?? "iron gear"}`,
      ],
    );
  }

  if (acceptance !== "iron-set" && diamonds < ACCEPTANCE_DIAMONDS) {
    const tierReady = hasUsablePickaxe(facts, KNOWLEDGE.diamond.minimumPickaxeTier);
    return decision(
      "diamond-first-3",
      `钻石 ${Math.min(diamonds, ACCEPTANCE_DIAMONDS)}/${ACCEPTANCE_DIAMONDS}`,
      tierReady
        ? `铁套已齐，前往 Y=${KNOWLEDGE.diamond.miningY} 的矿道寻找前三颗钻石`
        : "铁镐尚未就绪，钻石掉落无法保证",
      "diamond-gear",
      tierReady ? 75 : 50,
      missingEquipment,
      diamonds,
      false,
      [
        "iron pickaxe",
        `mining layer Y=${KNOWLEDGE.diamond.miningY}`,
        "safe return route",
      ],
    );
  }

  if (isNight(facts) === true && acceptance !== "full") {
    return decision(
      "night-work",
      "夜间继续经营",
      "没有床时在安全区域熔炼、整理或继续矿道，不进行无目的地表游荡",
      "iron",
      65,
      missingEquipment,
      diamonds,
      false,
      ["safe work area", "no bed"],
    );
  }

  return decision(
    "complete",
    "验收目标完成",
    acceptance === "diamonds"
      ? `铁套六件已完成，并取得 ${ACCEPTANCE_DIAMONDS} 颗钻石`
      : "当前任务链已满足验收条件",
    acceptance === "iron-set" ? "iron" : "diamond-gear",
    0,
    missingEquipment,
    diamonds,
    true,
    [],
  );
}

function decision(
  kind: MissionKind,
  title: string,
  reason: string,
  stage: MissionStage,
  utility: number,
  missingEquipment: readonly EquipmentRequirement[],
  diamonds: number,
  complete: boolean,
  requirements: readonly string[],
): MissionDecision {
  return {
    kind,
    title,
    reason,
    stage,
    utility,
    missingEquipment,
    diamonds,
    complete,
    requirements,
  };
}

function ingredientCost(item: string): number {
  if (item.endsWith("_pickaxe") || item === "minecraft:iron_sword") return 3;
  if (item.endsWith("_helmet")) return 5;
  if (item.endsWith("_chestplate")) return 8;
  if (item.endsWith("_leggings")) return 7;
  if (item.endsWith("_boots")) return 4;
  return 1;
}

export function stageRank(stage: MissionStage): number {
  return STAGE_RANK[stage];
}
