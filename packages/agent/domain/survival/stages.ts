import {
  hasAny,
  hasCraftingTableProduct,
  hasItem,
  hasStoneCapablePickaxe,
  inventoryCount,
  isNight,
  nearbyHas,
  pickaxeTier,
} from "./facts.ts";
import { STAGE_ORDER, type GoalId, type Milestone, type MilestoneStatus, type SeasonGoal, type Stage, type WorldFacts } from "./types.ts";

export const DEFAULT_SEASON_GOAL: SeasonGoal = Object.freeze({
  id: "defeat-ender-dragon",
  title: "击败末影龙",
  target: "dragon",
  version: 1,
  lockedByOperator: true,
  setBy: null,
  setAt: null,
});

const WOOD_ITEMS = /(^|:)[a-z_]+_(log|wood|stem|hyphae)$/u;
const PLANKS_ITEMS = /(^|:)[a-z_]+_planks$/u;
const BED_ITEMS = /(^|:)[a-z_]+_bed$/u;

export const STAGES: readonly Stage[] = [
  stage("wood-and-table", 0, "木头与工作台", "获得原木并建立第一个工作站", [], [
    milestone(
      "have-log",
      "已获得木头",
      "inventory contains wood products, or a reachable crafting table proves earlier wood work",
      (facts) => {
        // An empty inventory is an observation ("nothing"), not a missing one.
        if (facts.inventory.length === 0) return "incomplete";
        // A placed table physically proves logs were gathered. Leaving this
        // milestone incomplete while the table sat right next to the body made
        // the planner walk off looking for a log it had already spent.
        if (
          facts.craftingTableNearby === true ||
          nearbyHas(facts, /crafting_table$/u) !== null
        ) {
          return "complete";
        }
        return facts.inventory.some(
          (slot) =>
            WOOD_ITEMS.test(slot.item) ||
            PLANKS_ITEMS.test(slot.item) ||
            slot.item === "minecraft:crafting_table" ||
            /(^|:)wooden_[a-z_]+$/u.test(slot.item),
        )
          || hasCraftingTableProduct(facts)
          ? "complete"
          : "incomplete";
      },
    ),
    milestone(
      "have-planks",
      "背包有 4 块木板",
      "inventory contains at least 4 planks",
      (facts) => {
        // An empty inventory is an observation ("nothing"), not a missing one.
        if (facts.inventory.length === 0) return "incomplete";
        const count = facts.inventory
          .filter((slot) => PLANKS_ITEMS.test(slot.item))
          .reduce((total, slot) => total + slot.count, 0);
        return count >= 4 ||
          hasItem(facts, "minecraft:crafting_table") ||
          nearbyHas(facts, /crafting_table$/u) !== null ||
          facts.inventory.some((slot) => /(^|:)wooden_[a-z_]+$/u.test(slot.item)) ||
          hasCraftingTableProduct(facts)
          ? "complete"
          : "incomplete";
      },
    ),
    milestone(
      "have-crafting-table",
      "背包或附近有工作台",
      "inventory has crafting_table or a nearby crafting_table block exists",
      (facts) => {
        // A crafted table still in the backpack is not a station. Keep this
        // milestone incomplete until it has actually been placed (or a table
        // is visible) so a rejected placement cannot advance to stone tools.
        if (facts.craftingTablePlaced === true) return "complete";
        if (facts.craftingTableCrafted === true && hasItem(facts, "minecraft:crafting_table")) {
          return "incomplete";
        }
        if (facts.craftingTableNearby === true) return "complete";
        if (facts.inventory.length === 0 && facts.nearbyBlocks === undefined) return "unverified";
        return nearbyHas(facts, /crafting_table$/u) !== null ||
          hasCraftingTableProduct(facts)
          ? "complete"
          : "incomplete";
      },
    ),
  ]),
  stage("stone-tools", 1, "木镐与石镐", "取得石头并升级到石质工具", ["wood-and-table"], [
    milestone(
      "have-wooden-pickaxe",
      "拥有能挖石头的镐",
      "inventory contains a wooden or better pickaxe",
      // A stone or iron pickaxe already satisfies the capability this
      // milestone describes. Requiring wooden_pickaxe specifically trapped a
      // body that had upgraded past it: the milestone never completed and the
      // planner kept asking for a downgrade it could not craft.
      (facts) => hasStoneCapablePickaxe(facts) ? "complete" : "incomplete",
    ),
    milestone(
      "have-cobblestone",
      "背包有 3 块圆石",
      "inventory contains at least 3 cobblestone",
      (facts) => (inventoryCount(facts, "minecraft:cobblestone") >= 3 ? "complete" : "incomplete"),
    ),
    milestone(
      "have-stone-pickaxe",
      "拥有石镐或更好的镐",
      "inventory contains a stone or better pickaxe",
      (facts) => pickaxeTier(facts) >= 2 ? "complete" : "incomplete",
    ),
  ]),
  stage("food", 2, "食物", "获得并吃下食物，避免饥饿中断采集", ["stone-tools"], [
    milestone(
      "have-food",
      "食物保障",
      "a meal is available, this session already found food, or hunger is still safe",
      (facts) => {
        // A meal may have consumed the last item. The session fact keeps the
        // milestone complete instead of sending the planner back to hunting.
        if (facts.foodAcquired === true) return "complete";
        // Full hunger is not a reason to chop trees forever waiting for an
        // apple. An unbounded food stage blocked every later milestone even
        // though the body was in no danger. Keep the stage dynamic: if hunger
        // later drops below the safety threshold, this milestone becomes
        // incomplete again and the planner resumes eating/hunting.
        if (
          facts.food !== undefined &&
          facts.food !== null &&
          facts.food >= 18 &&
          (facts.health === undefined || facts.health === null || facts.health >= 12)
        ) {
          return "complete";
        }
        // An empty inventory is an observation ("nothing"), not a missing one.
        if (facts.inventory.length === 0) return "incomplete";
        return facts.inventory.some((slot) => FOOD.test(slot.item)) ? "complete" : "incomplete";
      },
    ),
    milestone(
      "fed",
      "食物充足",
      "a meal was confirmed, or hunger is already full while food is available",
      (facts) => {
        if (facts.foodConsumed === true) return "complete";
        // A safe hunger bar is the actual survival condition. Requiring a
        // reserve at 20/20 made the first food stage endless and produced
        // apple-farming loops. If hunger falls later, the stage reopens.
        if (
          facts.food !== undefined &&
          facts.food !== null &&
          facts.food >= 18
        ) {
          return "complete";
        }
        // Without a body-reported hunger value the planner cannot prove that
        // eating is legal, but a stocked backpack still makes the stage
        // actionable. Do not leave it as the terminal "unverified" milestone
        // when the body can simply eat later.
        if (facts.food === undefined || facts.food === null) {
          return facts.inventory.some((slot) => FOOD.test(slot.item))
            ? "complete"
            : "unverified";
        }
        if (facts.foodConsumed === false) return "incomplete";
        // Older bodies do not report the session fact. Hunger alone is not
        // proof of a meal, so this stays unverified without a reserve.
        return "unverified";
      },
    ),
  ]),
  stage("iron", 3, "铁器与熔炉", "采集铁矿石、建造熔炉并升级到铁镐", ["food"], [
    milestone(
      "have-furnace",
      "背包或附近有熔炉",
      "inventory has furnace or a nearby furnace block exists",
      (facts) => {
        if (facts.inventory.length === 0 && facts.nearbyBlocks === undefined) return "unverified";
        return hasItem(facts, "minecraft:furnace") || nearbyHas(facts, /furnace$/u) !== null
          ? "complete"
          : "incomplete";
      },
    ),
    milestone(
      "have-torches",
      "背包有 4 个火把",
      "inventory contains at least 4 torches",
      (facts) => (inventoryCount(facts, "minecraft:torch") >= 4 ? "complete" : "incomplete"),
    ),
    milestone(
      "have-raw-iron",
      "背包有粗铁",
      "inventory contains raw iron, or an iron tool proves it was already smelted",
      (facts) =>
        hasItem(facts, "minecraft:raw_iron") ||
        hasItem(facts, "minecraft:iron_ingot") ||
        hasIronTool(facts)
          ? "complete"
          : "incomplete",
    ),
    milestone(
      "have-iron-ingot",
      "背包有铁锭",
      "inventory contains iron_ingot, or an iron tool proves one was produced",
      (facts) =>
        hasItem(facts, "minecraft:iron_ingot") || hasIronTool(facts)
          ? "complete"
          : "incomplete",
    ),
    milestone(
      "have-iron-pickaxe",
      "背包有铁镐",
      "inventory contains iron_pickaxe",
      (facts) => hasItem(facts, "minecraft:iron_pickaxe") ? "complete" : "incomplete",
    ),
    milestone(
      "have-iron-sword",
      "背包有铁剑",
      "inventory contains iron_sword",
      (facts) => hasItem(facts, "minecraft:iron_sword") ? "complete" : "incomplete",
    ),
  ]),
  stage("shelter", 4, "营地与床", "建立有箱子和床的家，天黑回家睡觉", ["iron"], [
    milestone(
      "have-chest",
      "营地有箱子",
      "inventory has a chest, a nearby chest exists, or this body placed one",
      (facts) => {
        if (facts.chestPlaced === true) return "complete";
        return hasItem(facts, "minecraft:chest") ||
          nearbyHas(facts, /(^|:)chest$/u) !== null
          ? "complete"
          : "incomplete";
      },
    ),
    milestone(
      "have-bed",
      "营地有床",
      "inventory has a bed, a nearby bed exists, or this body placed one",
      (facts) => {
        if (facts.bedPlaced === true) return "complete";
        return hasAnyByRegex(facts, BED_ITEMS) || nearbyHas(facts, BED_ITEMS) !== null
          ? "complete"
          : "incomplete";
      },
    ),
  ]),
  stage("nether", 5, "下界与烈焰棒", "获得黑曜石、进入下界并击杀烈焰人", ["iron"], [
    milestone(
      "have-diamonds",
      "背包有 3 颗钻石",
      "inventory contains at least 3 diamond",
      (facts) => (inventoryCount(facts, "minecraft:diamond") >= 3 ? "complete" : "incomplete"),
    ),
    milestone(
      "have-diamond-pickaxe",
      "背包有钻石镐",
      "inventory contains diamond_pickaxe",
      (facts) => hasItem(facts, "minecraft:diamond_pickaxe") ? "complete" : "incomplete",
    ),
    milestone(
      "have-obsidian",
      "背包有黑曜石",
      "inventory contains obsidian",
      (facts) => hasItem(facts, "minecraft:obsidian") ? "complete" : "incomplete",
    ),
    milestone(
      "have-blaze-rod",
      "背包有烈焰棒",
      "inventory contains blaze_rod",
      (facts) => hasItem(facts, "minecraft:blaze_rod") ? "complete" : "incomplete",
    ),
  ]),
  stage("eyes", 6, "末影珍珠与末影之眼", "收集末影珍珠并制作末影之眼", ["nether"], [
    milestone(
      "have-ender-pearl",
      "背包有末影珍珠",
      "inventory contains ender_pearl",
      (facts) => hasItem(facts, "minecraft:ender_pearl") ? "complete" : "incomplete",
    ),
    milestone(
      "have-eyes",
      "背包有 12 个末影之眼",
      "inventory contains at least 12 ender_eye",
      (facts) => (inventoryCount(facts, "minecraft:ender_eye") >= 12 ? "complete" : "incomplete"),
    ),
  ]),
  stage("stronghold", 7, "寻找要塞", "使用末影之眼定位并进入要塞", ["eyes"], [
    milestone(
      "found-stronghold",
      "已定位要塞",
      "nearbyBlocks reports end_portal_frame or stone_bricks in stronghold context",
      (facts) => {
        if (facts.nearbyBlocks === undefined) return "unverified";
        return nearbyHas(facts, /end_portal_frame$/u) !== null ? "complete" : "incomplete";
      },
    ),
  ]),
  stage("dragon", 8, "进入末地并击败末影龙", "完成终局目标", ["stronghold"], [
    milestone(
      "in-end",
      "已进入末地",
      "dimension is end",
      (facts) => {
        if (facts.dimension === undefined || facts.dimension === null) return "unverified";
        return facts.dimension === "end" ? "complete" : "incomplete";
      },
    ),
    milestone(
      "dragon-dead",
      "末影龙已被击败",
      "body reports dragon defeat evidence",
      (facts) => {
        if (facts.entities === undefined) return "unverified";
        return facts.entities.some((entity) => /dragon/iu.test(entity.type)) ? "incomplete" : "unverified";
      },
    ),
  ]),
];

export function stageById(id: GoalId): Stage {
  const found = STAGES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`unknown survival stage ${id}`);
  return found;
}

export function stageIndex(id: GoalId): number {
  return STAGE_ORDER.indexOf(id);
}

/**
 * The next pending milestone in a stage. Completed milestones are skipped so
 * an already-fed player does not re-plan eating, but the first incomplete or
 * unverified milestone must remain the anchor for the next task.
 */
export function nextMilestone(
  stage: Stage,
  facts: WorldFacts,
): { readonly milestone: Milestone; readonly status: MilestoneStatus } | null {
  for (const milestone of stage.milestones) {
    const status = evaluateMilestone(milestone, facts);
    if (status !== "complete") return { milestone, status };
  }
  return null;
}

export function evaluateMilestone(milestone: Milestone, facts: WorldFacts): MilestoneStatus {
  try {
    return milestone.verify(facts);
  } catch {
    return "unverified";
  }
}

export function isNightOrUnknown(facts: WorldFacts): boolean {
  return isNight(facts) !== false;
}

function stage(
  id: GoalId,
  index: number,
  title: string,
  objective: string,
  requires: readonly GoalId[],
  milestones: readonly Milestone[],
): Stage {
  return { id, index, title, objective, requires, milestones };
}

function milestone(
  id: string,
  title: string,
  condition: string,
  verify: (facts: WorldFacts) => MilestoneStatus,
): Milestone {
  return { id, title, condition, verify };
}

function hasAnyByRegex(facts: WorldFacts, pattern: RegExp): boolean {
  return facts.inventory.some((slot) => pattern.test(slot.item));
}

function hasIronTool(facts: WorldFacts): boolean {
  return facts.inventory.some((slot) =>
    /^minecraft:iron_(pickaxe|sword|axe|shovel|hoe)$/u.test(slot.item),
  );
}

const FOOD =
  /(^|:)apple$|(^|:)baked_potato$|(^|:)bread$|(^|:)carrot$|(^|:)potato$|(^|:)beetroot$|(^|:)sweet_berries$|(^|:)melon_slice$|(^|:)cookie$|(^|:)golden_apple$|(^|:)golden_carrot$|(^|:)pumpkin_pie$|(^|:)honey_bottle$|(^|:)(cooked_)?(beef|chicken|cod|mutton|porkchop|rabbit|salmon)$/u;
