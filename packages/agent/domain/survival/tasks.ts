import { routeBlacklistCovers, type SkillCall } from "@craftmate/contracts";
import {
  canMine,
  dropsFor,
  normalizeItemId,
  queryRecipe,
  recipesUsing,
  requiredTool,
  smeltingFor,
  type CraftingRecipe,
} from "../knowledge/src/index.ts";
import {
  countAny,
  depthBelowSurface,
  hasInventoryCapacity,
  hasCraftingTableProduct,
  hasItem,
  hasUsablePickaxe,
  inventoryCount,
  isHungry,
  isLowHealth,
  isNight,
  isUnderground,
  nearbyHas,
  nearestEntity,
  nearestEntityWithinHeight,
  pickaxeTier,
  pickaxeUses,
  usedInventorySlots,
} from "./facts.ts";
import type {
  BlockedTask,
  GoalId,
  Missing,
  NearbyBlock,
  NearbyEntity,
  Task,
  TaskKind,
  WorldFacts,
} from "./types.ts";
import { STAGE_ORDER } from "./types.ts";

export interface TaskContext {
  readonly stage: GoalId;
  readonly facts: WorldFacts;
  readonly newId: () => string;
  /**
   * `full` keeps the cross-stage safety, food, night and storage gates.
   * `stage` evaluates only the stage's own task builder so a playbook card
   * can offer useful work when the mainline is blocked by an unrelated
   * route refusal (for example an old mine entrance).
   */
  readonly scope?: "full" | "stage";
}

const WOOD_ITEMS = /(^|:)[a-z_]+_(log|wood|stem|hyphae)$/u;
const PLANK_ITEMS = /(^|:)[a-z_]+_planks$/u;
const BED_ITEMS = /(^|:)[a-z_]+_bed$/u;
const WOOL_ITEMS = /(^|:)[a-z_]+_wool$/u;
const IRON_ORE = /(^|:)iron_ore$/u;
const FOOD_ITEMS =
  /(^|:)apple$|(^|:)baked_potato$|(^|:)bread$|(^|:)carrot$|(^|:)potato$|(^|:)beetroot$|(^|:)sweet_berries$|(^|:)melon_slice$|(^|:)cookie$|(^|:)golden_apple$|(^|:)golden_carrot$|(^|:)pumpkin_pie$|(^|:)honey_bottle$|(^|:)(cooked_)?(beef|chicken|cod|mutton|porkchop|rabbit|salmon)$/u;
/**
 * Rotten flesh is a last-resort meal. It restores hunger at the cost of a
 * short hunger effect, so it is only worth planning when the body is already
 * hungry and has no proper food. Refusing it entirely can leave a hurt body
 * unable to eat while it keeps failing hunts.
 */
const EMERGENCY_FOOD_ITEMS = /(^|:)rotten_flesh$/u;
/**
 * Raw meat is edible, but it restores half of what the cooked item does.
 * A body with a furnace and fuel should cook first; raw meat is only the
 * desperate meal.
 */
const RAW_MEAT_ITEMS = /(^|:)(beef|chicken|cod|mutton|porkchop|rabbit|salmon)$/u;
const COOKED_MEAT: Readonly<Record<string, string>> = {
  "minecraft:beef": "minecraft:cooked_beef",
  "minecraft:chicken": "minecraft:cooked_chicken",
  "minecraft:cod": "minecraft:cooked_cod",
  "minecraft:mutton": "minecraft:cooked_mutton",
  "minecraft:porkchop": "minecraft:cooked_porkchop",
  "minecraft:rabbit": "minecraft:cooked_rabbit",
  "minecraft:salmon": "minecraft:cooked_salmon",
};
/** Items vanilla allows even when the hunger bar is already full. */
const ALWAYS_EDIBLE_ITEMS =
  /(^|:)golden_apple$|(^|:)enchanted_golden_apple$|(^|:)golden_carrot$|(^|:)honey_bottle$/u;
/**
 * After the shelter stage, a couple of extra meals are worth taking when one
 * is already visible. This is a preemption, never a milestone: the planner
 * must not stall iron or the Nether by exploring an empty world for food.
 */
const FOOD_RESERVE_COUNT = 3;
const FOOD_RESERVE_STAGES: readonly GoalId[] = [
  "stone-tools",
  "shelter",
  "iron",
  "diamond-gear",
  "nether",
  "eyes",
  "stronghold",
  "dragon",
];
const IRON_GEAR_ITEMS = [
  "minecraft:iron_pickaxe",
  "minecraft:iron_sword",
  "minecraft:iron_helmet",
  "minecraft:iron_chestplate",
  "minecraft:iron_leggings",
  "minecraft:iron_boots",
] as const;
const DIAMOND_GEAR_ITEMS = [
  "minecraft:diamond_pickaxe",
  "minecraft:diamond_sword",
  "minecraft:diamond_helmet",
  "minecraft:diamond_chestplate",
  "minecraft:diamond_leggings",
  "minecraft:diamond_boots",
] as const;
/**
 * Item entities carry the localized display name, not their registry id.
 * The body reports "苹果" in a Chinese client and "Apple" in an English one,
 * so the planner has to accept both spellings when deciding whether a
 * dropped meal is worth a pickup walk.
 */
const DROPPED_FOOD_NAME =
  /苹果|apple|腐肉|rotten flesh|牛肉|beef|鸡肉|chicken|猪肉|porkchop|羊肉|mutton|兔肉|rabbit|鳕鱼|cod|鲑鱼|salmon|面包|bread|胡萝卜|carrot|马铃薯|potato|甜菜根|beetroot|甜浆果|sweet berries/iu;
/**
 * Rotten flesh keeps the body alive in an emergency, but it never counts
 * toward the proper food reserve. Planning a reserve pickup for it made the
 * agent walk to a corpse drop, succeed at collecting it, and then immediately
 * plan the same pickup again because the reserve counter had not moved.
 */
const DROPPED_EMERGENCY_FOOD_NAME = /腐肉|rotten flesh/iu;
const HOSTILE_ENTITIES =
  /zombie|husk|drowned|skeleton|stray|creeper|spider|witch|pillager|vindicator|evoker|ravager|enderman|slime|magma_cube|blaze|ghast|wither|piglin|hoglin|phantom|warden/iu;
/**
 * A wounded body only has to give ground to something that can hurt it from
 * range. Treating every mob ten blocks away as an emergency made a 6.5-heart
 * body flee a spider down a one-wide stair: every retreat target was solid
 * rock, each failure reissued the same walk, and the run spent minutes in
 * place with a stone sword in the pack.
 */
const RANGED_HOSTILES =
  /skeleton|stray|witch|pillager|evoker|blaze|ghast|phantom/iu;
const FURNACE_FUEL_ITEMS =
  /(^|:)(coal|charcoal|lava_bucket|blaze_rod|dried_kelp_block|coal_block|[a-z_]+_planks|[a-z_]+_log|[a-z_]+_wood|stick)$/u;
/** Below this health a ranged mob is an immediate retreat, not a fair fight. */
const RETREAT_HEALTH = 14;
/**
 * The body's chop search is bounded to 48 blocks. Starting a chop while the
 * only observed trunk is near that edge often fails after a short approach,
 * so walk toward the visible landmark first and let the next planning cycle
 * issue the chop from reliable interaction range.
 */
const VISIBLE_WOOD_APPROACH_DISTANCE = 40;
/**
 * A placed table is a durable station. Rebuilding one every time the body
 * explores more than a dozen blocks away burns wood and produces the visible
 * "planks -> table -> place table" loop. Only treat the remembered station as
 * lost after a genuinely long trip; the 3x3 craft skill can walk back to the
 * saved position first.
 */
/**
 * A 3×3 craft needs an interaction station, not a landmark anywhere in the
 * render distance. A table more than eight blocks away is usually behind a
 * tunnel wall or on another layer; making a fresh one from carried planks is
 * both faster and more reliable than pathing back through a mineshaft.
 */
const REPLACE_TABLE_VERTICAL = 4;
/**
 * The craft skill can walk a short staircase to a remembered table, so a
 * small floor offset is not "another mineshaft". Beyond this, a surface
 * `goto` cannot descend and the planner must build/place locally instead.
 */
const MAX_WALK_TABLE_VERTICAL = 12;
/**
 * A remembered table on the same floor is a real station even when it is
 * outside interaction range. Walking back a short tunnel is cheaper and far
 * more reliable than exploring 48 blocks for wood to build a replacement --
 * especially underground, where no tree exists at all.
 */
const WALK_BACK_TABLE_DISTANCE = 64;
/**
 * A table is only "the one this body just placed" when it is still within a
 * short walk. A remembered table 20+ blocks away is not a local station even
 * if the place flag is still set; treating it as usable made the planner skip
 * the rebuild and then fail the craft with "no table within range".
 */
const JUST_PLACED_TABLE_DISTANCE = 8;

/**
 * Builds the single next executable task for a stage. When no task is ready,
 * returns a blocked description that names the first missing dependency
 * instead of inventing an action.
 */
export function nextTaskForStage(context: TaskContext): Task | BlockedTask | null {
  const { stage, facts, newId } = context;
  if (context.scope !== "stage") {
    const safety = immediateSafetyTask(stage, facts, newId);
    if (safety !== null) return safety;
    // Hunger is a survival need in every stage, not only while the food stage
    // happens to be the current milestone. This keeps a later mining trip from
    // ignoring a steak in the backpack until the body starves.
    const meal = immediateFoodTask(stage, facts, newId);
    if (meal !== null) return meal;
    /*
     * Critical health is a cross-stage need. Once the food stage is marked
     * complete, the deterministic stage builder no longer asks foodTask for a
     * meal, so a body at 1.5 hearts with no carried food sat idle while a pig
     * stood forty blocks away. Reuse the food search as emergency care; the
     * task keeps the current stage so progression is not rolled back.
     */
    const criticalMeal = criticalHealthFoodTask(stage, facts, newId);
    if (criticalMeal !== null) return criticalMeal;
    // Night and a full backpack are cross-stage needs too. Going home must win
    // over a mining or exploration task, and offloading bulk items has to win
    // before a full inventory silently blocks every pickup.
    const nightHome = nightHomeTask(stage, facts, newId);
    if (nightHome !== null) return nightHome;
    // A broken pickaxe is a hard capability loss, not a storage problem. When
    // the backpack is full the old order walked home first, then tried to mine
    // a staircase bare-handed. Restore the tool (or make a safe local table)
    // before any long transfer or exploration.
    const toolRescue = essentialPickaxeTask(stage, facts, newId);
    if (toolRescue !== null) return toolRescue;
    // A pickaxe is not a weapon. The first live night produced nine deaths in
    // twenty minutes because the body carried cobblestone and sticks but kept
    // running from zombies bare-handed. Craft the basic sword while daylight
    // and a station are still available, then let the combat card use it.
    const weaponPrep = essentialWeaponTask(stage, facts, newId);
    if (weaponPrep !== null) return weaponPrep;
    const campChest = campChestTask(stage, facts, newId);
    if (campChest !== null) return campChest;
    const campBed = campBedTask(stage, facts, newId);
    if (campBed !== null) return campBed;
    const overflow = overflowStorageTask(stage, facts, newId);
    if (overflow !== null) return overflow;
    /*
     * A full pack must not preempt work whose ingredients are already in the
     * pack. The live iron run smelted three ingots, then walked to the chest
     * forever because storage outranked the pickaxe craft. Only defer storage
     * for a terminal equipment step, never for another mining leg.
     */
    const stagedProgress = stageTask(stage, facts, newId);
    /*
     * Mining refuses to start below ten hunger. When the stage task is
     * blocked by that rule and the pack has no meal, returning the block
     * left the whole goal idle through the night: the strategy asked for
     * iron, the iron plan asked for food, and nothing ever hunted or slept.
     * Turn that specific standstill into a real action: hunt by day, hold
     * still until dawn at night.
     */
    if (
      stagedProgress !== null &&
      !("skill" in stagedProgress)
    ) {
      const hungryFallback = hungryWithoutMealTask(stage, facts, newId);
      if (hungryFallback !== null) return hungryFallback;
    }
    const equipmentNow =
      stagedProgress !== null &&
      "skill" in stagedProgress &&
      /^(craft|place_block|smelt|run_job)$/u.test(stagedProgress.skill.name);
    /*
     * A hungry body must spend its remaining time finding food. Storage and
     * the trip back to the mine are useful housekeeping, but they were taking
     * the slot before the food stage's own climb-to-surface task. The live
     * body then tried to walk to a chest through a sealed pit and never got
     * the meal at all.
     */
    const survivalNow =
      stage === "food" &&
      isHungry(facts) &&
      stagedProgress !== null &&
      "skill" in stagedProgress;
    const storage = homeStorageTask(stage, facts, newId);
    if (storage !== null && !equipmentNow && !survivalNow) return storage;
    const miningReturn = miningReturnTask(stage, facts, newId);
    if (miningReturn !== null && !equipmentNow && !survivalNow) {
      return miningReturn;
    }
    const reserve = foodReserveTask(stage, facts, newId);
    if (reserve !== null) return reserve;
    // A visible ore is a state-driven opportunity, not a stage reward. Waiting
    // for the linear DAG to reach `iron` made the body walk past a lit iron
    // vein while it was still polishing off stone tools. The deterministic
    // fallback now takes the one-block opportunity; the model can still rank
    // food, shelter or a failure recovery beside it.
    const visibleIron = crossStageIronOpportunity(stage, facts, newId);
    if (visibleIron !== null) return visibleIron;
  }
  const resolved = stageTask(stage, facts, newId);
  if (resolved === null || /探索|搜索/u.test(resolved.title)) {
    const fullCamp = fullBackpackCampTask(stage, facts, newId);
    if (fullCamp !== null) return fullCamp;
  }
  return resolved;
}

function stageTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask | null {
  switch (stage) {
    case "wood-and-table":
      return woodAndTable(facts, newId);
    case "stone-tools":
      return stoneTools(facts, newId);
    case "food":
      return foodTask(facts, newId);
    case "shelter":
      return shelter(facts, newId);
    case "iron":
      return iron(facts, newId);
    case "diamond-gear":
      return diamondGear(facts, newId);
    case "nether":
      return nether(facts, newId);
    case "eyes":
      return eyes(facts, newId);
    case "stronghold":
      return stronghold(facts, newId);
    case "dragon":
      return dragon(facts, newId);
  }
}

function immediateFoodTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  if (!isHungry(facts)) return null;
  // Cooking a hunted animal is the meal a player actually plans. Do it
  // before the raw-meat shortcut so a carried steak is not eaten at half
  // value while a furnace and fuel are already in reach.
  const cooked = cookMeatTask(stage, facts, newId);
  if (cooked !== null) return cooked;
  const properFood = facts.inventory.find((slot) => FOOD_ITEMS.test(slot.item));
  /*
   * Rotten flesh applies a hunger effect. Eating it at 17 in the middle of a
   * mining stage dropped hunger again a few seconds later, so the live body
   * alternated eating and placing a chest forever. Outside the dedicated
   * food stage, emergency food is for the starvation line; otherwise keep
   * working until the normal hunt/cook path takes over below 8.
   */
  const emergencyFood =
    stage === "food" || (facts.food ?? 20) <= 6
      ? facts.inventory.find((slot) => EMERGENCY_FOOD_ITEMS.test(slot.item))
      : undefined;
  const food = properFood ?? emergencyFood;
  if (food === undefined) {
    /*
     * No carried meal. The mining return gate used to walk a hungry body to
     * the surface with no hunt task waiting there, so the next mine step sent
     * it straight back down: y59 and y71 alternated until hunger dropped.
     * Reuse the food stage's hunt/cook plan at emergency hunger, keeping the
     * current stage so progression is not rolled back. Between 10 and 17 the
     * body can finish the current cut instead of dropping the mine for an
     * empty surface sweep.
     */
    if (
      stage !== "food" &&
      (facts.food ?? 20) < 8 &&
      hasUsablePickaxe(facts)
    ) {
      const hunt = foodTask(facts, newId);
      if (hunt === null || !("skill" in hunt)) return null;
      return { ...hunt, stage };
    }
    return null;
  }
  return {
    id: `task:${newId()}`,
    stage,
    kind: "interact",
    title: `进食补充饥饿：${shortName(food.item)}`,
    critical: true,
    skill: skill("eat", { item: food.item }, newId),
    preconditions: ["hunger is below the safe threshold", "food in inventory"],
    expectedEvidence: [`${food.item} count decreases`, "food_consumed evidence"],
    verify: (next) => inventoryCount(next, food.item) < inventoryCount(facts, food.item),
  };
}

function criticalHealthFoodTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask | null {
  if (!isLowHealth(facts) || !isHungry(facts)) return null;
  // At 17+ hunger the body can regenerate without a meal. A missing meal is
  // still a real problem below that line, even when the food milestone was
  // completed earlier in the run.
  if ((facts.food ?? 0) >= 17) return null;
  const meal = foodTask(facts, newId);
  if (meal === null) return null;
  return { ...meal, stage };
}

/**
 * Tops up a small travel reserve without turning "have N food" into a
 * blocking milestone. It only acts on a target the body can already see, so
 * an empty plain falls through to the real stage task instead of another
 * unbounded food sweep.
 */
function foodReserveTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  if (!FOOD_RESERVE_STAGES.includes(stage)) return null;
  // Unknown time is not daytime: reserve gathering must not start at dusk
  // just because the body has not reported a clock yet.
  if (isNight(facts) !== false || isHungry(facts)) return null;
  const reserve = facts.inventory.reduce(
    (total, slot) => (FOOD_ITEMS.test(slot.item) ? total + slot.count : total),
    0,
  );
  if (reserve >= FOOD_RESERVE_COUNT) return null;
  const animals = nearestEntityWithinHeight(
    facts,
    /(^|:)(cow|pig|chicken|rabbit|sheep)$/u,
    24,
  );
  if (animals !== null) {
    const approach = approachEntity(facts, stage, animals, shortName(animals.type), newId);
    if (approach !== null) {
      return { ...approach, title: `补充食物储备：${approach.title}` };
    }
    return {
      id: `task:${newId()}`,
      stage,
      kind: "combat",
      title: `补充食物储备：猎取 ${shortName(animals.type)}`,
      skill: skill("attack", {
        target: animals.type,
        count: 1,
        radius: 32,
        lethal: true,
        collect: true,
      }, newId),
      preconditions: ["safe daylight", "a passive animal is visible", "food reserve is low"],
      expectedEvidence: ["an edible drop enters the inventory"],
      verify: (next) =>
        next.inventory.reduce(
          (total, slot) => (FOOD_ITEMS.test(slot.item) ? total + slot.count : total),
          0,
        ) > reserve,
    };
  }
  const wheat = inventoryCount(facts, "minecraft:wheat");
  if (wheat >= 3) {
    const recipe = queryRecipe("minecraft:bread");
    if (recipe !== null) return craftTask(recipe, stage, facts, newId);
  }
  const dropped = (facts.entities ?? [])
    .filter(
      (entity) =>
        entity.type === "minecraft:item" &&
        entity.distance <= 16 &&
        DROPPED_FOOD_NAME.test(entity.name) &&
        !DROPPED_EMERGENCY_FOOD_NAME.test(entity.name),
    )
    .sort((left, right) => left.distance - right.distance)[0];
  if (dropped === undefined) return null;
  return {
    id: `task:${newId()}`,
    stage,
    kind: "gather",
    title: `补充食物储备：捡起 ${dropped.name}`,
    skill: skill("collect_items", { count: 1 }, newId),
    preconditions: ["safe daylight", "a dropped food item is visible", "food reserve is low"],
    expectedEvidence: ["an edible item enters the inventory"],
    verify: (next) => next.inventory.some((slot) => FOOD_ITEMS.test(slot.item)),
  };
}

function reclaimTask(
  stage: GoalId,
  facts: WorldFacts,
  block: "minecraft:crafting_table" | "minecraft:furnace",
  newId: () => string,
): Task {
  const label = block === "minecraft:furnace" ? "熔炉" : "工作台";
  const before = inventoryCount(facts, block);
  const station =
    block === "minecraft:furnace" ? facts.furnace : facts.craftingTable;
  return {
    id: `task:${newId()}`,
    stage,
    kind: "gather",
    title: `回收临时${label}`,
    skill: skill("mine_block", {
      block,
      count: 1,
      ...(station === undefined || station === null ? {} : { at: station }),
    }, newId),
    preconditions: [
      `the temporary ${block} is beside the body`,
      "the next task leaves this work area",
    ],
    expectedEvidence: [`${label} drops and is collected`, `${block} count increases`],
    verify: (next) => inventoryCount(next, block) > before,
  };
}

/**
 * A stage task can be worth doing for a long time, but none of it matters if
 * a pillager is three blocks away. The body already reports a reflex; this is
 * the next planner decision, using the same skill schema as every other step.
 * It only overrides construction when the threat is genuinely close:
 * low-health bodies retreat from a ten-block radius, healthy bodies only
 * fight something already within melee range.
 */
function immediateSafetyTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  const threat = nearestEntity(facts, HOSTILE_ENTITIES, 10);
  if (threat === null) return null;
  const health = facts.health ?? 20;
  const position = facts.position;
  const threatPosition =
    threat.x === undefined || threat.y === undefined || threat.z === undefined
      ? null
      : { x: threat.x, y: threat.y, z: threat.z };
  const close = threat.distance <= 4.5;
  const wounded = health < RETREAT_HEALTH;
  const critical = health < 8;
  const ranged = RANGED_HOSTILES.test(threat.type);
  /*
   * Melee threats are only urgent when they can actually reach the body.
   * A wounded miner keeps working while a spider is ten blocks down the
   * tunnel; the old rule dropped the mine, picked a random direction into
   * stone and looped the failed walk until the mob arrived anyway.
   */
  const urgent =
    close || (wounded && (ranged || critical) && threat.distance <= 10);
  if (!urgent) return null;
  const mustRetreat =
    critical || /creeper/iu.test(threat.type) || (ranged && wounded);

  if (mustRetreat && position !== null && position !== undefined && threatPosition !== null) {
    const dx = position.x - threatPosition.x;
    const dz = position.z - threatPosition.z;
    const length = Math.hypot(dx, dz);
    const baseAngle = length < 0.01
      ? Math.PI / 2
      : Math.atan2(dz, dx);
    const candidates: { x: number; y: number; z: number }[] = Array.from({ length: 7 }, (_, index) => {
      const offset = (index - 3) * (Math.PI / 6);
      const radians = baseAngle + offset;
      const distance = index === 3 ? 16 : 12;
      return {
        x: Math.round((position.x + Math.cos(radians) * distance) * 10) / 10,
        y: Math.round(position.y * 10) / 10,
        z: Math.round((position.z + Math.sin(radians) * distance) * 10) / 10,
      };
    });
    /*
     * Blind radial targets are guesses; a mineshaft is a one-block corridor
     * surrounded by stone. When every guess is unreachable the goto settles
     * "safe route stopped short", the planner reissues the same escape and
     * the body never leaves the mob. The remembered entrance is a route the
     * body already walked, so it stays as the last candidate.
     */
    const entrance = facts.mineEntrance ?? facts.mine?.entrance ?? null;
    if (
      entrance !== null &&
      entrance !== undefined &&
      distanceTo(position, entrance) > 6 &&
      candidates.every(
        (candidate) =>
          candidate.x !== entrance.x ||
          candidate.y !== entrance.y ||
          candidate.z !== entrance.z,
      )
    ) {
      candidates.push({ x: entrance.x, y: entrance.y, z: entrance.z });
    }
    return {
      id: `task:${newId()}`,
      stage,
      kind: "navigate",
      title: `低血量撤离 ${threat.name}`,
      critical: true,
      skill: skill("goto", {
        target: candidates[3]!,
        candidates,
        acceptPartial: true,
        mode: "walk",
        // This retreat is the planner's answer to the threat. Without the
        // flag the coordinator preempted it on the next threat report and
        // reissued a different doomed retreat from the same spot, which is
        // how a low-health body burned its last seconds at night.
        emergency: true,
      }, newId),
      preconditions: [
        "a hostile entity is within the body's observed radius",
        "the retreat direction has a safe bounded route",
      ],
      expectedEvidence: [
        "the body leaves the hostile entity's immediate range",
        "a later snapshot reports a safer distance",
      ],
      verify: (next) =>
        next.position === undefined ||
        next.position === null ||
        Math.hypot(next.position.x - position.x, next.position.z - position.z) >= 3,
    };
  }

  if (!mustRetreat && health >= 8 && threat.distance <= 5.5) {
    return {
      id: `task:${newId()}`,
      stage,
      kind: "combat",
      title: `击退近身威胁 ${threat.name}`,
      critical: true,
      skill: skill("attack", {
        target: threat.type,
        count: 1,
        radius: 12,
        lethal: true,
        collect: false,
      }, newId),
      preconditions: [
        "a hostile entity is within melee or immediate ranged range",
        "the body has enough health to trade one hit",
      ],
      expectedEvidence: [
        "the hostile entity's health reaches zero",
        "the immediate threat disappears from the snapshot",
      ],
      verify: (next) =>
        !(next.entities ?? []).some(
          (entity) => entity.type === threat.type && entity.distance <= 3.5,
        ),
    };
  }
  return null;
}

/**
 * Reverse expansion for a target item. Returns dependencies in craft order:
 * raw/intermediate resources first, target last. Capped to keep the result
 * explainable; a cycle or an unknown item stops that branch.
 */
export function expandItem(
  item: string,
  facts: WorldFacts,
  options: { readonly depth?: number; readonly recipeId?: string } = {},
): readonly string[] {
  const maxDepth = options.depth ?? 4;
  const result: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number): void => {
    const normalized = normalizeItemId(id);
    if (depth > maxDepth || seen.has(normalized)) return;
    seen.add(normalized);
    const recipe = queryRecipe(normalized, options.recipeId);
    if (recipe === null) {
      result.push(normalized);
      return;
    }
    for (const ingredient of recipe.ingredients) {
      const available = ingredient.choices.find((choice) => inventoryCount(facts, choice) >= ingredient.count);
      const choice = available ?? ingredient.choices[0];
      if (choice !== undefined) visit(choice, depth + 1);
    }
    result.push(normalized);
  };
  visit(item, 0);
  return [...new Set(result)];
}

export function missingForRecipe(
  recipe: CraftingRecipe,
  facts: WorldFacts,
): readonly Missing[] {
  const missing: Missing[] = [];
  for (const ingredient of recipe.ingredients) {
    const available = ingredient.choices.reduce(
      (total, choice) => total + inventoryCount(facts, choice),
      0,
    );
    if (available < ingredient.count) {
      missing.push({
        kind: "material",
        item: ingredient.choices[0] ?? "minecraft:unknown",
        count: ingredient.count - available,
        detail: `需要 ${ingredient.count} 个 ${ingredient.tag ?? ingredient.choices[0]}，当前 ${available}`,
      });
    }
  }
  if (
    recipe.station === "crafting_table" &&
    !hasStation(facts, "crafting_table") &&
    // Walking away from a table this body already placed does not destroy
    // the station. The body can walk back to the remembered position; only
    // demand a new table when no placed table is known at all.
    facts.craftingTablePlaced !== true &&
    !hasItem(facts, "minecraft:crafting_table")
  ) {
    missing.push({
      kind: "station",
      item: "minecraft:crafting_table",
      detail: "3×3 配方需要工作台；背包或附近都没有",
    });
  }
  return missing;
}

export function craftTask(
  recipe: CraftingRecipe,
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
  count = 1,
): Task {
  const item = recipe.output.item;
  return {
    id: `task:${newId()}`,
    stage,
    kind: "craft",
    title: `合成 ${shortName(item)} ×${recipe.output.count * count}`,
    skill: skill("craft", { item, count }, newId),
    preconditions: [
      `inventory has ingredients for ${recipe.id}`,
      recipe.station === "crafting_table" ? "crafting table in reach" : "2x2 inventory grid free",
    ],
    expectedEvidence: [`${item} count increases by ${recipe.output.count * count}`],
    verify: (next) => inventoryCount(next, item) >= inventoryCount(facts, item) + recipe.output.count * count,
  };
}

/**
 * A missing material is not always a dead end. Sticks come from planks, and
 * planks come from logs. Walk that chain from the target recipe and issue the
 * first intermediate craft whose ingredients are already in the backpack.
 * This never invents a resource: an unavailable leaf stops the recursion and
 * the original blocked reason is preserved.
 */
function craftWithPrerequisite(
  recipe: CraftingRecipe,
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
  title: string,
): Task | BlockedTask {
  const missing = missingForRecipe(recipe, facts);
  if (missing.length === 0) return craftTask(recipe, stage, facts, newId);
  const prerequisite = preparationTask(recipe, stage, facts, newId, 0);
  if (prerequisite !== null) return prerequisite;
  if (
    recipe.ingredients.some((ingredient) =>
      ingredient.choices.some((choice) => isWoodDerived(choice)),
    )
  ) {
    if (nearbyHas(facts, WOOD_ITEMS) !== null) {
      const gather = woodGatherTask(facts, stage, "补充原木", newId);
      if (gather !== null) return gather;
    }
    // No tree in this observation is not proof that the recipe is
    // impossible. Sweep far enough that a later snapshot is a genuinely new
    // area; an 8–16 block leg kept the body orbiting the same clearing.
    return explore(facts, stage, "寻找原木", "原木", 1, newId, 32, 48, true);
  }
  return blockedWith(stage, "craft", title, missing);
}

function preparationTask(
  recipe: CraftingRecipe,
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
  depth: number,
): Task | null {
  if (depth > 6) return null;
  // Tools need both planks and sticks. Craft sticks only once the target's
  // direct material requirement is already satisfied, otherwise the stick
  // recipe consumes the last planks that the tool itself needs.
  const missing = missingForRecipe(recipe, facts);
  const directMaterialsReady = missing.every(
    (entry) =>
      entry.kind !== "material" ||
      /_stick$/u.test(entry.item ?? ""),
  );
  const orderedIngredients = directMaterialsReady
    ? [...recipe.ingredients].sort((left, right) => {
        const leftStick = left.choices.includes("minecraft:stick") ? 1 : 0;
        const rightStick = right.choices.includes("minecraft:stick") ? 1 : 0;
        return leftStick - rightStick;
      })
    : recipe.ingredients;
  for (const ingredient of orderedIngredients) {
    const available = ingredient.choices.reduce(
      (total, choice) => total + inventoryCount(facts, choice),
      0,
    );
    if (available >= ingredient.count) continue;
    for (const choice of ingredient.choices) {
      const subRecipe = queryRecipe(choice);
      if (subRecipe === null) continue;
      const prerequisite = preparationTask(subRecipe, stage, facts, newId, depth + 1);
      if (prerequisite !== null) return prerequisite;
    }
  }
  return missingForRecipe(recipe, facts).length === 0
    ? craftTask(recipe, stage, facts, newId)
    : null;
}

function isWoodDerived(item: string | undefined): boolean {
  if (item === undefined) return false;
  return WOOD_ITEMS.test(item) || /_planks$|_stick$/u.test(item);
}

/**
 * Pick the plank recipe that matches the wood the body actually has. A birch
 * log can only become birch planks, so always planning oak planks strands the
 * body even though its inventory contains a legal ingredient.
 */
function planksRecipeFor(facts: WorldFacts): CraftingRecipe | null {
  const sources = [
    ...facts.inventory
      .filter((slot) => isRawWood(slot.item))
      .sort((left, right) => right.count - left.count)
      .map((slot) => slot.item),
    ...facts.inventory.filter((slot) => PLANK_ITEMS.test(slot.item)).map((slot) => slot.item),
    ...(facts.nearbyBlocks ?? []).filter((block) => isRawWood(block.id)).map((block) => block.id),
  ];
  for (const source of sources) {
    const recipe = PLANK_ITEMS.test(source)
      ? queryRecipe(source)
      : recipesUsing(source).find((candidate) => PLANK_ITEMS.test(candidate.output.item)) ?? null;
    if (recipe?.station === "inventory" && PLANK_ITEMS.test(recipe.output.item)) return recipe;
  }
  return queryRecipe("minecraft:oak_planks");
}

function isRawWood(item: string): boolean {
  return WOOD_ITEMS.test(item) || /(^|:)bamboo_block$/u.test(item);
}

/**
 * Returns the correct next step for observed wood: chop what is close, or
 * approach a tree that is visible but outside a reliable chop/route window.
 * A visible far tree is still useful evidence; ignoring it caused the body
 * to choose an unrelated exploration heading while the tree filled the view.
 */
export function woodGatherTask(
  facts: WorldFacts,
  stage: GoalId,
  title: string,
  newId: () => string,
  count = 1,
): Task | null {
  const nearbyLog = nearbyHas(facts, WOOD_ITEMS);
  if (nearbyLog === null) return null;
  const hasTarget =
    nearbyLog.visible === true &&
    nearbyLog.distance !== undefined &&
    nearbyLog.distance > VISIBLE_WOOD_APPROACH_DISTANCE &&
    nearbyLog.x !== undefined &&
    nearbyLog.z !== undefined;
  if (!hasTarget) {
    return {
      id: `task:${newId()}`,
      stage,
      kind: "gather",
      title,
      skill: skill("chop_tree", { count }, newId),
      preconditions: ["a log block is nearby", "no screen is open"],
      expectedEvidence: ["a log enters the inventory"],
      verify: (next) => next.inventory.some((slot) => WOOD_ITEMS.test(slot.item)),
    };
  }
  const target = {
    x: nearbyLog.x!,
    y: nearbyLog.y ?? facts.position?.y ?? 64,
    z: nearbyLog.z!,
  };
  return {
    id: `task:${newId()}`,
    stage,
    kind: "navigate",
    title: `接近可见树木：${title}`,
    skill: skill("goto", {
      target,
      acceptPartial: true,
      mode: "walk",
    }, newId),
    preconditions: [
      "a log is visible but beyond reliable interaction range",
      "a bounded safe route exists toward the tree's column",
    ],
    expectedEvidence: [
      "the body reaches a closer observation point",
      "a later snapshot places the log within chop range",
    ],
    verify: () => true,
  };
}

/**
 * A missing table is itself a dependency. If planks are available on the
 * spot, turn the log/plank stock into the table first; otherwise keep the
 * explicit "need a station" reason.
 */
function placeOrBuildTable(
  table: Task | BlockedTask,
  facts: WorldFacts,
  newId: () => string,
  stage: GoalId = "stone-tools",
): Task | BlockedTask {
  if ("skill" in table) return table;
  if (!hasItem(facts, "minecraft:crafting_table")) {
    const tableRecipe = queryRecipe("minecraft:crafting_table");
    if (tableRecipe !== null && missingForRecipe(tableRecipe, facts).length === 0) {
      return craftTask(tableRecipe, stage, facts, newId);
    }
  }
  return table;
}

function woodAndTable(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  const tableInInventory = hasItem(facts, "minecraft:crafting_table");
  const tableStation =
    hasStation(facts, "crafting_table") || facts.craftingTablePlaced === true;
  const planks = facts.inventory
    .filter((slot) => /(^|:)[a-z_]+_planks$/u.test(slot.item))
    .reduce((total, slot) => total + slot.count, 0);
  const log = facts.inventory.find((slot) => WOOD_ITEMS.test(slot.item));

  if (!tableInInventory && !tableStation && planks < 4) {
    if (planks > 0) {
      if (log !== undefined) {
        const planksRecipe = planksRecipeFor(facts);
        if (planksRecipe === null) return blocked("wood-and-table", "craft", "制作木板");
        return craftTask(
          planksRecipe,
          "wood-and-table",
          facts,
          newId,
          Math.max(1, Math.ceil((4 - planks) / planksRecipe.output.count)),
        );
      }
      const nearbyLog = nearbyHas(facts, WOOD_ITEMS);
      if (nearbyLog !== null) {
        return woodGatherTask(facts, "wood-and-table", "砍树补齐工作台材料", newId);
      }
      return blockedWith("wood-and-table", "craft", "补齐工作台材料", [
        {
          kind: "material",
          item: planksRecipeFor(facts)?.output.item ?? "minecraft:oak_planks",
          count: 4 - planks,
          detail: `工作台需要 4 块木板，当前 ${planks}`,
        },
        {
          kind: "station",
          item: "minecraft:crafting_table",
          detail: "没有工作台；3×3 配方（木镐）必须依赖它",
        },
      ]);
    }
    if (log === undefined) {
      const nearbyLog = nearbyHas(facts, WOOD_ITEMS);
      if (nearbyLog !== null) {
        return woodGatherTask(facts, "wood-and-table", "砍树并获得原木", newId);
      }
      // "No log in this local observation" is not "no tree exists". Commit to
      // a long, steady sweep so the next snapshot is genuinely new terrain.
      return explore(
        facts,
        "wood-and-table",
        "寻找树木",
        "树木",
        1,
        newId,
        32,
        48,
        true,
      );
    }
    const planksRecipe = planksRecipeFor(facts);
    if (planksRecipe === null) return blocked("wood-and-table", "craft", "制作木板");
    return craftTask(planksRecipe, "wood-and-table", facts, newId);
  }

  if (!tableInInventory && !tableStation) {
    const table = queryRecipe("minecraft:crafting_table");
    if (table === null) return blocked("wood-and-table", "craft", "制作工作台");
    return craftTask(table, "wood-and-table", facts, newId);
  }
  if (!tableStation) {
    return {
      id: `task:${newId()}`,
      stage: "wood-and-table",
      kind: "place",
      title: "放下工作台",
      skill: skill("place_block", { block: "minecraft:crafting_table", count: 1 }, newId),
      preconditions: ["crafting_table in inventory", "a safe adjacent block face exists"],
      expectedEvidence: ["nearbyBlocks contains crafting_table"],
      verify: (next) => nearbyHas(next, /crafting_table$/u) !== null,
    };
  }
  // The wood-and-table stage owns the table, not an arbitrary plank quota.
  // Once the table exists, surplus planks belong to the next stage.
  return null;
}

function stoneTools(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  // Never ask for a tier the body has already surpassed. The previous
  // `hasItem(wooden_pickaxe)` check stranded a body carrying only a stone or
  // iron pickaxe: it demanded a wooden downgrade, needed logs for it, and
  // then failed every replan because no log was nearby.
  if (pickaxeTier(facts) < 1) {
    const table = ensureTable(facts, "stone-tools", newId);
    if (table !== null) return placeOrBuildTable(table, facts, newId);
    // A broken wooden pickaxe is not a reason to re-enter the wood stage.
    // With three cobblestone, two sticks and a table this session placed,
    // the stone pickaxe is already craftable; demanding a wooden detour
    // sent the body into an underground wood hunt it could never finish.
    const stonePickaxe = queryRecipe("minecraft:stone_pickaxe");
    if (
      stonePickaxe !== null &&
      inventoryCount(facts, "minecraft:cobblestone") >= 3 &&
      (hasStation(facts, "crafting_table") ||
        facts.craftingTableNearby === true ||
        placedTableWithinWalk(facts) ||
        (facts.craftingTablePlaced === true && facts.canSeeSky === false)) &&
      missingForRecipe(stonePickaxe, facts).length === 0
    ) {
      return craftTask(stonePickaxe, "stone-tools", facts, newId);
    }
    const pickaxe = queryRecipe("minecraft:wooden_pickaxe");
    if (pickaxe === null) return blocked("stone-tools", "craft", "制作木镐");
    const missing = missingForRecipe(pickaxe, facts);
    if (missing.length > 0) {
      const prerequisite = preparationTask(pickaxe, "stone-tools", facts, newId, 0);
      if (prerequisite !== null) return prerequisite;
      return craftWithPrerequisite(pickaxe, "stone-tools", facts, newId, "制作木镐");
    }
    return craftTask(pickaxe, "stone-tools", facts, newId);
  }
  if (inventoryCount(facts, "minecraft:cobblestone") < 3) {
    const nearbyStone = reachableStone(facts);
    if (nearbyStone === null) {
      // "Not in this observation" is not "does not exist". Ground is under
      // nearly every overworld biome, so walk one bounded step and look again
      // instead of parking the whole season goal on a missing neighbour.
      return explore(facts, "stone-tools", "寻找石头", "石头", 3, newId);
    }
    if (!canMine("minecraft:wooden_pickaxe", nearbyStone.id)) {
      return blockedWith("stone-tools", "mine", "挖石头", [
        {
          kind: "tool",
          item: "minecraft:wooden_pickaxe",
          detail: `${nearbyStone.id} 需要更高等级工具`,
        },
      ]);
    }
    return {
      id: `task:${newId()}`,
      stage: "stone-tools",
      kind: "mine",
      title: "挖 3 块石头",
      skill: skill("mine_block", {
        block: nearbyStone.id,
        count: 3,
        ...exactOpportunisticAt(nearbyStone, facts),
      }, newId),
      preconditions: ["wooden pickaxe equipped", "stone block nearby"],
      expectedEvidence: ["cobblestone count reaches 3"],
      verify: (next) => inventoryCount(next, "minecraft:cobblestone") >= 3,
    };
  }
  if (pickaxeTier(facts) < 2) {
    const table = ensureTable(facts, "stone-tools", newId);
    if (table !== null) return placeOrBuildTable(table, facts, newId);
    const pickaxe = queryRecipe("minecraft:stone_pickaxe");
    if (pickaxe === null) return blocked("stone-tools", "craft", "制作石镐");
    const missing = missingForRecipe(pickaxe, facts);
    if (missing.length > 0) {
      return craftWithPrerequisite(pickaxe, "stone-tools", facts, newId, "制作石镐");
    }
    return craftTask(pickaxe, "stone-tools", facts, newId);
  }
  return null;
}

/**
 * Restoring the pickaxe is a state gate that applies beyond the stone-tools
 * stage. An iron-stage body with a broken iron pickaxe and no ingots still
 * needs a wooden or stone tool before it can escape a shaft or mine again.
 *
 * This runs before storage because a full backpack used to send the body on a
 * long climb home, where its only path was bare-handed stone mining. The
 * replacement order matches a player's: use ingots if the next tier is
 * already possible, then cobblestone, then carried wood.
 */
function essentialPickaxeTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask | null {
  const stageIndex = STAGE_ORDER.indexOf(stage);
  if (
    stageIndex < STAGE_ORDER.indexOf("stone-tools") ||
    stageIndex > STAGE_ORDER.indexOf("diamond-gear") ||
    ((stage === "food" || stage === "shelter") && !isUnderground(facts)) ||
    hasUsablePickaxe(facts) ||
    !canRecoverPickaxeFromCarriedMaterials(facts)
  ) {
    return null;
  }
  const recipe = replacementPickaxeRecipe(facts);
  if (recipe === null) return null;
  // A basic tool rescue is stone-tools work even when it preempts dinner or a
  // shelter. An iron pickaxe remains iron-stage work.
  const rescueStage: GoalId =
    recipe.output.item === "minecraft:iron_pickaxe" ? "iron" : "stone-tools";
  const table = ensureTable(facts, rescueStage, newId);
  if (table !== null) return asCritical(table);
  return asCritical(
    craftWithPrerequisite(
      recipe,
      rescueStage,
      facts,
      newId,
      `修复${shortName(recipe.output.item)}`,
    ),
  );
}

/**
 * Iron does not wait for the food/shelter milestones to finish. A located
 * ore inside the body's interaction radius is a real, state-driven upgrade
 * opportunity: mine one block now, then let the normal planner decide whether
 * to smelt it or continue the current stage. This deliberately reuses the
 * iron-stage guard (stone pickaxe, actual metal deficit) so a finished iron
 * toolset does not turn every nearby ore into an infinite detour.
 */
function crossStageIronOpportunity(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  const stageIndex = STAGE_ORDER.indexOf(stage);
  if (
    stageIndex < STAGE_ORDER.indexOf("stone-tools") ||
    stageIndex > STAGE_ORDER.indexOf("iron") ||
    !hasUsablePickaxe(facts, 2)
  ) {
    return null;
  }
  const ore = locatedNearby(facts, IRON_ORE);
  if (
    ore === null ||
    ore.visible !== true ||
    (ore.distance ?? Number.POSITIVE_INFINITY) > 16
  ) {
    return null;
  }
  const opportunity = iron(facts, newId);
  if (
    opportunity === null ||
    !("skill" in opportunity) ||
    opportunity.skill.name !== "mine_block" ||
    !IRON_ORE.test(String(opportunity.skill.args["block"] ?? ""))
  ) {
    return null;
  }
  return opportunity;
}

/**
 * Do not preempt storage for a tool rescue that would immediately need a
 * wood-gathering expedition. The hard gate applies when the carried material
 * can actually produce a binding and a head, or when a table is already
 * available to turn those materials into a tool.
 */
function canRecoverPickaxeFromCarriedMaterials(facts: WorldFacts): boolean {
  const sticks = inventoryCount(facts, "minecraft:stick");
  const planks = facts.inventory
    .filter((slot) => PLANK_ITEMS.test(slot.item))
    .reduce((total, slot) => total + slot.count, 0);
  const logs = logCount(facts);
  const potentialPlanks = planks + logs * 4;
  if (sticks < 2 && potentialPlanks < 2) return false;
  const stoneHead = inventoryCount(facts, "minecraft:cobblestone") >= 3;
  const ironHead = inventoryCount(facts, "minecraft:iron_ingot") >= 3;
  const woodenHead = potentialPlanks >= (sticks >= 2 ? 3 : 5);
  if (!stoneHead && !ironHead && !woodenHead) return false;
  if (
    hasStation(facts, "crafting_table") ||
    facts.craftingTableNearby === true ||
    facts.craftingTablePlaced === true ||
    hasItem(facts, "minecraft:crafting_table")
  ) {
    return true;
  }
  // A fresh table costs four planks. Only count that extra cost when no
  // remembered station exists, so a body with four planks and no logs does
  // not spend its only pickaxe material on a table it cannot use.
  const bindingPlanks = sticks >= 2 ? 0 : 2;
  const headPlanks = stoneHead || ironHead ? 0 : 3;
  return potentialPlanks >= 4 + bindingPlanks + headPlanks;
}

function replacementPickaxeRecipe(facts: WorldFacts): CraftingRecipe | null {
  const iron = queryRecipe("minecraft:iron_pickaxe");
  if (iron !== null && inventoryCount(facts, "minecraft:iron_ingot") >= 3) {
    return iron;
  }
  const stone = queryRecipe("minecraft:stone_pickaxe");
  if (stone !== null && inventoryCount(facts, "minecraft:cobblestone") >= 3) {
    return stone;
  }
  return queryRecipe("minecraft:wooden_pickaxe");
}

function hasCombatWeapon(facts: WorldFacts): boolean {
  return facts.inventory.some((slot) =>
    /(^|:)(wooden|stone|iron|golden|diamond|netherite)_(sword|axe)$/u.test(slot.item),
  );
}

/**
 * Basic weapon preparation belongs to the early tool stage, but it must also
 * survive the transition into food or shelter. Waiting until the iron stage
 * leaves the body defenseless through several nights.
 */
function essentialWeaponTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask | null {
  const stageIndex = STAGE_ORDER.indexOf(stage);
  if (
    stageIndex < STAGE_ORDER.indexOf("stone-tools") ||
    stageIndex > STAGE_ORDER.indexOf("shelter") ||
    hasCombatWeapon(facts) ||
    pickaxeTier(facts) < 2
  ) {
    return null;
  }
  // A nearly spent pickaxe is the more urgent tool. Replacing it first also
  // avoids leaving the body underground with a sword but no way to climb out.
  const uses = pickaxeUses(facts, Math.max(1, pickaxeTier(facts)));
  if (uses !== null && uses < 24) return null;
  const sword = queryRecipe("minecraft:stone_sword");
  if (sword === null || missingForRecipe(sword, facts).length > 0) return null;
  const table = ensureTable(facts, stage, newId);
  if (table !== null) return table;
  return asCritical(craftTask(sword, stage, facts, newId));
}

function asCritical(task: Task | BlockedTask): Task | BlockedTask {
  return "skill" in task ? { ...task, critical: true } : task;
}

/**
 * Only `stone` drops cobblestone. `deepslate` is a different block and drops
 * `cobbled_deepslate`, so accepting it here would make the cobblestone
 * milestone impossible to satisfy.
 */
function reachableStone(facts: WorldFacts): NearbyBlock | null {
  const target = facts.reachableBlock;
  if (target !== undefined && target !== null && /(^|:)stone$/u.test(target.id)) {
    return { id: target.id, x: target.x, y: target.y, z: target.z };
  }
  // `reachableBlock` is the nearest geometric interaction candidate, not a
  // camera-selected block. Nearby observation is enough to issue the task;
  // the body still has to prove it reached and mined it.
  return nearbyHas(facts, /(^|:)stone$/u);
}

function blockHasLocation(block: NearbyBlock): boolean {
  return block.x !== undefined && block.y !== undefined && block.z !== undefined;
}

/**
 * Aggregate inventory-style entries ("coal_ore × 8") carry no coordinates.
 * Mining tasks need a concrete located block, so prefer an observed located
 * entry over the first aggregate match. Without this, the planner saw iron
 * ore right next to the body and still ordered a blind mine shaft.
 */
function locatedNearby(facts: WorldFacts, pattern: RegExp): NearbyBlock | null {
  const matches = (facts.nearbyBlocks ?? []).filter((block) => pattern.test(block.id));
  return (
    matches.find((block) => blockHasLocation(block) && block.visible !== false) ??
    matches.find(blockHasLocation) ??
    null
  );
}

function logCount(facts: WorldFacts): number {
  return facts.inventory.reduce(
    (total, slot) => (WOOD_ITEMS.test(slot.item) ? total + slot.count : total),
    0,
  );
}

/**
 * Turns a hunted animal into a proper meal. Raw meat restores half the hunger
 * of the cooked item, so a body with a furnace and fuel should cook first.
 * Below eight points the detour is more dangerous than eating it raw, and a
 * full hunger bar has no reason to cook at all.
 */
function cookMeatTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  const properFood = facts.inventory.find(
    (slot) => FOOD_ITEMS.test(slot.item) && !RAW_MEAT_ITEMS.test(slot.item),
  );
  const rawMeat = facts.inventory.find((slot) => RAW_MEAT_ITEMS.test(slot.item));
  if (properFood !== undefined || rawMeat === undefined) return null;
  const food = facts.food ?? 20;
  /*
   * Cooking is the meal a player plans. Only a body already at the starvation
   * line eats raw meat for the immediate calories; treating 7 or 8 as that
   * line made every hunt end in raw mutton even with a furnace and coal in
   * the pack.
   */
  if (food <= 3 || food >= 20) return null;
  const cooked = COOKED_MEAT[rawMeat.item];
  const fuel = fuelChoice(facts);
  if (cooked === undefined || fuel === null) return null;
  if (hasStation(facts, "furnace")) {
    return smeltTask(stage, rawMeat.item, cooked, rawMeat.count, fuel, facts, newId);
  }
  const furnaceTrip = gotoFurnaceTask(stage, facts, newId);
  if (furnaceTrip !== null) return furnaceTrip;
  if (inventoryCount(facts, "minecraft:furnace") > 0 && !deepUnderground(facts)) {
    return {
      id: `task:${newId()}`,
      stage,
      kind: "place",
      title: "放置熔炉烤肉",
      skill: skill("place_block", { block: "minecraft:furnace", count: 1 }, newId),
      preconditions: ["furnace in inventory", "a safe adjacent block face exists"],
      expectedEvidence: ["nearbyBlocks contains furnace"],
      verify: (next) => nearbyHas(next, /furnace$/u) !== null,
    };
  }
  return null;
}

function foodTask(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  const properFood = facts.inventory.find(
    (slot) => FOOD_ITEMS.test(slot.item) && !RAW_MEAT_ITEMS.test(slot.item),
  );
  const rawMeat = facts.inventory.find((slot) => RAW_MEAT_ITEMS.test(slot.item));
  const cookedMeal = cookMeatTask("food", facts, newId);
  if (cookedMeal !== null) return cookedMeal;
  const food =
    properFood ??
    rawMeat ??
    facts.inventory.find((slot) => FOOD_ITEMS.test(slot.item));
  // Vanilla refuses ordinary food at a full hunger bar. Only golden apples
  // and similar always-edible items can be consumed there; asking for a
  // normal meal at 20/20 produces a use animation that never completes.
  if (
    food !== undefined &&
    (facts.food !== 20 || ALWAYS_EDIBLE_ITEMS.test(food.item))
  ) {
    return {
      id: `task:${newId()}`,
      stage: "food",
      kind: "interact",
      title: `吃 ${shortName(food.item)}`,
      skill: skill("eat", { item: food.item }, newId),
      preconditions: ["food in inventory", "edible item selected"],
      expectedEvidence: [`${food.item} count decreases`, "food_consumed evidence"],
      verify: (next) => inventoryCount(next, food.item) < inventoryCount(facts, food.item),
    };
  }
  const emergencyFood = facts.inventory.find((slot) => EMERGENCY_FOOD_ITEMS.test(slot.item));
  if (emergencyFood !== undefined && isHungry(facts)) {
    return {
      id: `task:${newId()}`,
      stage: "food",
      kind: "interact",
      title: `应急吃 ${shortName(emergencyFood.item)}`,
      skill: skill("eat", { item: emergencyFood.item }, newId),
      preconditions: ["no proper food in inventory", "hunger is below the safe threshold"],
      expectedEvidence: [`${emergencyFood.item} count decreases`, "food_consumed evidence"],
      verify: (next) => inventoryCount(next, emergencyFood.item) < inventoryCount(facts, emergencyFood.item),
    };
  }
  if (food !== undefined && facts.food === 20) {
    // The stage milestone treats a full belly plus a reserve as sufficient.
    // If the caller reached this stage anyway, there is no legal meal to do.
    return blockedWith("food", "interact", "食物充足，无需进食", [
      {
        kind: "material",
        item: food.item,
        detail: `${food.item} 在满饥饿时不可食用；保留作为下一段行程的储备`,
      },
    ]);
  }
  if (
    facts.food !== undefined &&
    facts.food !== null &&
    facts.food >= 17 &&
    (facts.health === undefined || facts.health === null || facts.health >= 12)
  ) {
    // The milestone advances in this state; do not keep chopping trees for an
    // apple that is not needed. If hunger falls later, the stage reopens.
    return null;
  }
  const position = facts.position;
  /**
   * A starving body in a sealed cave can be one craft away from escape. When
   * the remembered table is close and the backpack already has a pickaxe's
   * ingredients, climbing toward the surface with bare hands is the worse
   * move: the stone roof stops the pillar and every retry burns time. Restore
   * the tool first; the pickaxe then unlocks stone collection, pillar recovery
   * and the surface food hunt.
   */
  const table = facts.craftingTable;
  const tableDistance =
    position !== undefined &&
    position !== null &&
    table !== undefined &&
    table !== null
      ? Math.hypot(table.x - position.x, table.y - position.y, table.z - position.z)
      : Number.POSITIVE_INFINITY;
  const woodenPickaxe = queryRecipe("minecraft:wooden_pickaxe");
  const canRestorePickaxe =
    pickaxeTier(facts) < 1 &&
    facts.craftingTablePlaced === true &&
    tableDistance <= 20 &&
    woodenPickaxe !== null &&
    missingForRecipe(woodenPickaxe, facts).length === 0;
  if (
    canRestorePickaxe &&
    woodenPickaxe !== null &&
    isHungry(facts) &&
    isUnderground(facts)
  ) {
    return craftTask(
      woodenPickaxe,
      "stone-tools",
      facts,
      newId,
    );
  }
  if (
    position !== undefined &&
    position !== null &&
    isHungry(facts) &&
    isUnderground(facts) &&
    !canRestorePickaxe &&
    (facts.health ?? 20) >= 12
  ) {
    // Cave animals are rare, but zombies are common and drop emergency
    // food. A starving body should take that fight before committing to a
    // hundred-block staircase; the eat task already knows rotten flesh is
    // an emergency meal.
    const zombie = nearestEntity(facts, /(^|:)(zombie|husk|drowned)$/u, 14);
    if (zombie !== null) {
      return {
        id: `task:${newId()}`,
        stage: "food",
        kind: "combat",
        title: `猎取 ${shortName(zombie.type)} 获取应急食物`,
        skill: skill("attack", {
          target: zombie.type,
          count: 1,
          radius: 14,
          lethal: true,
          collect: true,
        }, newId),
        preconditions: ["hunger is low", "a zombie is within the cave search radius"],
        expectedEvidence: ["an entity is damaged", "rotten flesh enters the inventory"],
        verify: (next) => inventoryCount(next, "minecraft:rotten_flesh") > 0,
      };
    }
  }
  /*
   * Night is not a reason to climb out of a working mine for food. Passive
   * animals live on the surface, but hunting them in the dark is slower and
   * more dangerous than continuing the current underground job. The old
   * order reached the "climb toward the surface" branch first, so every
   * night tick pulled the body up a staircase and the next mining tick sent
   * it back down. Let night work own the underground case; food remains the
   * current stage, so the next snapshot resumes the hunt at dawn.
   */
  if (isNight(facts) === true && isUnderground(facts)) {
    const nightWork = nightWorkTask("food", facts, newId);
    if (nightWork !== null) return nightWork;
  }
  const surfaceY = facts.surfaceY;
  if (
    position !== undefined &&
    position !== null &&
    isHungry(facts) &&
    facts.canSeeSky === false &&
    surfaceY !== undefined &&
    surfaceY !== null &&
    surfaceY > position.y + 1
  ) {
    // Passive animals live on the surface. Exploring a cave at y=16 for a
    // meal is not a hunt, it is a slow starvation: the body has no surface
    // fact to steer by, so it sweeps the same dark tunnels until hunger
    // empties. Climb in bounded 12-block stages; the next snapshot re-reads
    // the real surface height and either continues or starts hunting.
    const targetY = Math.min(surfaceY, position.y + 12);
    return {
      id: `task:${newId()}`,
      stage: "food",
      kind: "navigate",
      title: `挖阶梯接近地表寻找食物（还差 ${surfaceY - position.y} 格）`,
      skill: skill("goto", {
        target: {
          x: position.x,
          y: targetY,
          z: position.z,
        },
        acceptPartial: false,
        mode: "recover",
      }, newId),
      preconditions: ["hunger is low", "the body is underground", "no food in inventory"],
      expectedEvidence: ["the body gains height toward the surface layer"],
      verify: (next) =>
        next.position === undefined ||
        next.position === null ||
        next.position.y > position.y,
    };
  }
  const surfaceAnchor = facts.craftingTable;
  if (
    position !== undefined &&
    position !== null &&
    surfaceAnchor !== undefined &&
    surfaceAnchor !== null &&
    position.y < 60 &&
    surfaceAnchor.y > position.y + 1
  ) {
    // Passive animals and oak canopies live on the surface. Sweeping the
    // mining layer at y=16 forever cannot create a meal; use the table the
    // body placed above ground as a known route back to daylight.
    const candidates = [
      { x: surfaceAnchor.x + 1, y: surfaceAnchor.y, z: surfaceAnchor.z },
      { x: surfaceAnchor.x - 1, y: surfaceAnchor.y, z: surfaceAnchor.z },
      { x: surfaceAnchor.x, y: surfaceAnchor.y, z: surfaceAnchor.z + 1 },
      { x: surfaceAnchor.x, y: surfaceAnchor.y, z: surfaceAnchor.z - 1 },
    ];
    return {
      id: `task:${newId()}`,
      stage: "food",
      kind: "navigate",
      title: "返回地面工作台寻找食物",
      skill: skill("goto", {
        target: candidates[0]!,
        candidates,
        acceptPartial: false,
        mode: "recover",
      }, newId),
      preconditions: ["hunger is low", "no food or visible animal nearby"],
      expectedEvidence: ["the body reaches the surface workstation layer"],
      verify: (next) =>
        next.position === undefined ||
        next.position === null ||
        next.position.y >= surfaceAnchor.y - 1,
    };
  }
  const foodAnimals = /(^|:)(cow|pig|chicken|rabbit|sheep)$/u;
  // The body observes further than it can see through terrain, and the attack
  // skill walks to a target it only knows by direction. A pig at 38 blocks is
  // a real, reachable meal; ignoring it sent the agent back to the explore
  // sweep and made the food stage last minutes longer than necessary.
  const nearby = nearestEntityWithinHeight(facts, foodAnimals, 40);
  if (nearby !== null) {
    const approach = approachEntity(facts, "food", nearby, shortName(nearby.type), newId);
    if (approach !== null) return approach;
    return {
      id: `task:${newId()}`,
      stage: "food",
      kind: "combat",
      title: `猎取 ${shortName(nearby.type)}`,
      skill: skill("attack", {
        target: nearby.type,
        count: 2,
        radius: 48,
        lethal: true,
        collect: true,
      }, newId),
      preconditions: ["passive animal within the body's search radius"],
      expectedEvidence: ["an entity is damaged", "an edible drop enters the inventory"],
      verify: (next) => next.inventory.some((slot) => FOOD_ITEMS.test(slot.item)),
    };
  }
  // Fish are food, but the navigation grid deliberately refuses water. A cod
  // fifteen blocks offshore is not a hunt target: the body reports "no
  // reachable route" and the runtime backs off instead of moving. Only a fish
  // already inside vanilla melee reach is worth swinging at; anything further
  // is left to the land sweep below.
  const fish = nearestEntity(facts, /(^|:)(cod|salmon|tropical_fish)$/u, 3);
  if (fish !== null) {
    return {
      id: `task:${newId()}`,
      stage: "food",
      kind: "combat",
      title: `捕捉 ${shortName(fish.type)}`,
      skill: skill("attack", {
        target: fish.type,
        count: 1,
        radius: 24,
        lethal: true,
        collect: true,
      }, newId),
      preconditions: ["a fish is within the body's bounded search radius"],
      expectedEvidence: ["the fish dies", "an edible drop enters the inventory"],
      verify: (next) => next.inventory.some((slot) => FOOD_ITEMS.test(slot.item)),
    };
  }
  const wheat = inventoryCount(facts, "minecraft:wheat");
  if (wheat >= 3) {
    const recipe = queryRecipe("minecraft:bread");
    return recipe === null ? blocked("food", "craft", "制作面包") : craftTask(recipe, "food", facts, newId);
  }
  const droppedFood = (facts.entities ?? [])
    .filter(
      (entity) =>
        entity.type === "minecraft:item" &&
        entity.distance <= 16 &&
        DROPPED_FOOD_NAME.test(entity.name),
    )
    .sort((left, right) => left.distance - right.distance)[0];
  if (droppedFood !== undefined) {
    return {
      id: `task:${newId()}`,
      stage: "food",
      kind: "gather",
      title: `捡起 ${droppedFood.name}`,
      skill: skill("collect_items", { count: 1 }, newId),
      preconditions: ["a dropped food item is visible within pickup range"],
      expectedEvidence: ["an edible item enters the inventory"],
      verify: (next) => next.foodAcquired === true || next.inventory.some((slot) => FOOD_ITEMS.test(slot.item)),
    };
  }
  // Apples are a 0.5% leaf drop and chopping a whole canopy is not a meal
  // plan. A player hunts a passive animal and cooks the meat; when the hunt
  // window is empty, walking to new terrain is the action that can create a
  // real target. Wood is already plentiful by this stage, so the old
  // leaf/log fallback only produced a slow walk in circles.
  //
  // There is no visible animal. An attack with no target fails in the same
  // tick and the runtime then retries byte-identical work after every
  // backoff, which looks exactly like an idle agent. Walking to a new
  // observation area is the action that can actually create a hunt target.
  // A passive mob is rarely inside the 16-block observation that failed
  // above. Sweep further than the generic resource search so a full loop
  // actually covers new ground instead of orbiting the same clearing.
  // The old 36-block cap stayed inside the already-loaded spawn chunks:
  // after a four-hour run those animals were long gone, so the body walked
  // a tight loop for minutes at food 3. A longer leg reaches unloaded ground
  // where passive mobs can spawn again.
  if (isNight(facts) === true) {
    // Hunting in the dark is how the live run lost eighteen health to a
    // creeper. With no food and no visible animal, spend the night on work
    // that stays near camp and hunt again at dawn.
    return nightWorkTask("food", facts, newId);
  }
  return explore(facts, "food", "寻找可猎取的动物", "动物", 2, newId, 32, 64, true);
}

function shelter(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  if (facts.sleeping === true) return null;
  const bedNearby = nearbyHas(facts, BED_ITEMS);
  const bedItem = facts.inventory.find((slot) => BED_ITEMS.test(slot.item));
  const bedPlaced =
    facts.bedPlaced === true && !anchorIsUnderground(facts, facts.bed ?? null);
  const hasBed =
    bedPlaced ||
    bedNearby !== null ||
    bedItem !== undefined;
  // A first night without a bed is not a construction project. Keep the body
  // mining, crafting, smelting or sorting what it already owns; the wool trip
  // can wait for daylight. A bed already in hand or in reach is still used.
  // This must run before the deep-underground return: otherwise a night miner
  // climbs out to the surface and immediately walks back down.
  if (isNight(facts) === true && !hasBed) {
    return nightWorkTask("shelter", facts, newId);
  }
  // A camp is a surface home. Building it in a mineshaft is how the body
  // ended up sleeping and storing loot underground, then treating the hole
  // as "home" on every later trip.
  if (deepUnderground(facts)) {
    return returnToSurfaceTask("shelter", facts, newId) ??
      blocked("shelter", "navigate", "返回地表建立营地");
  }

  let bedRecipe: CraftingRecipe | null = null;
  let bedMissing: readonly Missing[] = [];
  if (!hasBed) {
    bedRecipe = queryRecipe("minecraft:white_bed");
    if (bedRecipe === null) return blocked("shelter", "craft", "制作床");
    bedMissing = missingForRecipe(bedRecipe, facts);
    const woolMissing = bedMissing.find((entry) => /_wool$/u.test(entry.item ?? ""));
    if (woolMissing !== undefined) {
      // Wool is the gate for a bed and does not need a crafting table yet.
      // Hunt a flock before walking to a station, otherwise a missing table
      // can send the body on a 200-block wood sweep while a sheep is nearby.
      const sheep = nearestEntityWithinHeight(facts, /(^|:)sheep$/u, 40);
      if (sheep !== null) {
        const approach = approachEntity(facts, "shelter", sheep, "绵羊", newId);
        if (approach !== null) return approach;
        return {
          id: `task:${newId()}`,
          stage: "shelter",
          kind: "combat",
          title: "击杀绵羊并收集羊毛",
          skill: skill("attack", {
            target: sheep.type,
            count: 2,
            radius: 48,
            lethal: true,
            collect: true,
          }, newId),
          preconditions: ["sheep within the body's search radius", "safe footing"],
          expectedEvidence: ["white wool enters the inventory"],
          verify: (next) => next.inventory.some((slot) => WOOL_ITEMS.test(slot.item)),
        };
      }
      // A forest can be empty of sheep for a long time. Sweep a new area for
      // a real flock instead of orbiting the same clearing forever.
      return explore(facts, "shelter", "寻找绵羊", "羊", woolMissing.count ?? 2, newId, 24, 40, true);
    }
  }

  const chestNearby = nearbyHas(facts, /(^|:)chest$/u);
  const chestItem = facts.inventory.find((slot) => /(^|:)chest$/u.test(slot.item));
  const chestPlaced =
    facts.chestPlaced === true && !anchorIsUnderground(facts, facts.chest ?? null);
  const hasChest =
    chestPlaced ||
    chestNearby !== null ||
    chestItem !== undefined;
  if (!hasChest) {
    const table = ensureTable(facts, "shelter", newId);
    if (table !== null) return placeOrBuildTable(table, facts, newId, "shelter");
    const recipe = queryRecipe("minecraft:chest");
    if (recipe === null) return blocked("shelter", "craft", "制作箱子");
    const missing = missingForRecipe(recipe, facts);
    if (missing.length === 0) return craftTask(recipe, "shelter", facts, newId);
    const prerequisite = craftWithPrerequisite(recipe, "shelter", facts, newId, "制作箱子");
    if ("skill" in prerequisite) return prerequisite;
    return blockedWith("shelter", "craft", "制作箱子", missing);
  }
  if (chestItem !== undefined && chestNearby === null && facts.chestPlaced !== true) {
    return placeChestTask("shelter", facts, chestItem.item, newId);
  }

  if (
    !atCamp(facts) &&
    chestNearby === null &&
    nearbyHas(facts, BED_ITEMS) === null
  ) {
    const goHome = gotoHomeTask("shelter", facts, newId);
    if (goHome !== null) return goHome;
  }

  if (!hasBed) {
    const table = ensureTable(facts, "shelter", newId);
    if (table !== null) return placeOrBuildTable(table, facts, newId, "shelter");
    if (bedRecipe === null) return blocked("shelter", "craft", "制作床");
    return bedMissing.length === 0
      ? craftTask(bedRecipe, "shelter", facts, newId)
      : craftWithPrerequisite(bedRecipe, "shelter", facts, newId, "制作床");
  }
  if (bedItem !== undefined && bedNearby === null && facts.bedPlaced !== true) {
    return placeBedTask("shelter", facts, bedItem.item, newId);
  }
  if (isNight(facts) === true && bedNearby !== null) {
    return sleepTask("shelter", facts, newId);
  }
  return null;
}

/**
 * The camp anchor is the first durable station the body placed. Prefer the
 * chest: it is the storage destination and usually sits beside the bed.
 */
function homeAnchor(
  facts: WorldFacts,
): { readonly x: number; readonly y: number; readonly z: number } | null {
  const anchor = facts.chest ?? facts.bed ?? facts.craftingTable ?? null;
  if (anchor === null) return null;
  // A chest or bed placed while mining is an outpost, not a home. Treating
  // it as the camp is what made the body build beds and chests underground
  // and then "go home" into a hole.
  if (anchorIsUnderground(facts, anchor)) return null;
  return anchor;
}

/**
 * A camp normally has its chest and crafting table several blocks apart.
 * Measuring night safety against the chest alone made the body walk from the
 * table back to the chest, then the iron stage walked it to the table again,
 * producing a visible cross-camp ping-pong every few seconds. Any station in
 * the established camp is already "home".
 */
function campStationDistance(facts: WorldFacts): number | null {
  const position = facts.position;
  if (position === undefined || position === null) return null;
  const anchors = homeAnchors(facts);
  if (anchors.length === 0) return null;
  return Math.min(
    ...anchors.map((anchor) =>
      Math.hypot(position.x - anchor.x, position.z - anchor.z),
    ),
  );
}

/**
 * A camp is a cluster of stations, not one particular chest. The live body
 * stood at its workbench with the chest eight blocks away and repeatedly
 * decided it was "away from home", reissuing a one-block goto every cycle.
 */
function atCamp(facts: WorldFacts): boolean {
  const distance = campStationDistance(facts);
  return distance !== null && distance <= 8;
}

/**
 * Every durable station at the camp can be a walking target. Preferring one
 * remembered block made "go home" fail whenever that block sat on a raised
 * shelf or behind the body's current floor; the other stations are the same
 * home and are often the reachable approach.
 */
function homeAnchors(
  facts: WorldFacts,
): readonly { readonly x: number; readonly y: number; readonly z: number }[] {
  const candidates = [facts.chest, facts.bed, facts.craftingTable];
  const seen = new Set<string>();
  const anchors: { readonly x: number; readonly y: number; readonly z: number }[] = [];
  for (const anchor of candidates) {
    if (anchor === undefined || anchor === null) continue;
    if (anchorIsUnderground(facts, anchor)) continue;
    const key = `${anchor.x},${anchor.y},${anchor.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push(anchor);
  }
  return anchors;
}

function anchorIsUnderground(
  facts: WorldFacts,
  anchor: { readonly x: number; readonly y: number; readonly z: number } | null,
): boolean {
  if (anchor === null) return false;
  // A surface reading is only trustworthy for the current column. When the
  // body is deep under a mountain, comparing a valley camp to that column's
  // surface height would misclassify the camp as underground. That happened
  // during a live run: the body left home, stood under a higher hill, and the
  // old chest at y=85 looked "buried" relative to the new y=92 surface. The
  // planner then built a second chest at the far-away field table.
  const surface = facts.surfaceY;
  const position = facts.position;
  const nearAnchor =
    position !== undefined &&
    position !== null &&
    distanceTo(position, anchor) <= 24;
  if (
    nearAnchor &&
    facts.canSeeSky === true &&
    surface !== undefined &&
    surface !== null
  ) {
    return anchor.y < surface - 4;
  }
  // Sea level is 63; a remembered chest or bed this low is almost certainly
  // an outpost, not the surface camp.
  return anchor.y < 40;
}

/**
 * A shallow dugout with both a bed and a chest is an established home, not a
 * mineshaft. Players put furnaces and replacement stations inside a shelter
 * even when the ceiling hides the sky; forcing a surface trip from there made
 * the body abandon its own camp at the iron stage.
 */
function atEstablishedCamp(facts: WorldFacts): boolean {
  const position = facts.position;
  const bed = facts.bed ?? null;
  const chest = facts.chest ?? null;
  if (position === undefined || position === null) return false;
  if (facts.bedPlaced !== true || bed === null) return false;
  if (facts.chestPlaced !== true || chest === null) return false;
  if ((depthBelowSurface(facts) ?? 0) > 16) return false;
  return distanceTo(position, bed) <= 8 && distanceTo(position, chest) <= 8;
}

/**
 * A station at a shallow mine entrance is an outpost; a station forty blocks
 * down is a second home. The body must climb out before placing camp
 * infrastructure, even when it is currently carrying the item.
 */
function deepUnderground(facts: WorldFacts): boolean {
  if (facts.dimension === "nether" || facts.dimension === "end") return false;
  // A ravine floor can sit well below the local heightmap while still being
  // open to the sky. `returnToSurfaceTask` uses `isUnderground` (which trusts
  // canSeeSky), so the two predicates must agree; otherwise shelter asks for
  // a surface return that the navigation planner refuses to produce and the
  // goal parks as blocked forever.
  if (facts.canSeeSky === true) return false;
  if (atEstablishedCamp(facts)) return false;
  return (depthBelowSurface(facts) ?? 0) > 8;
}

function routePointBlacklisted(
  facts: WorldFacts,
  point: { readonly x: number; readonly y: number; readonly z: number },
): boolean {
  return (facts.routeBlacklist ?? []).some((entry) =>
    routeBlacklistCovers(entry, point, facts.now ?? Date.now()),
  );
}

function distanceTo(
  left: { readonly x: number; readonly y: number; readonly z: number },
  right: { readonly x: number; readonly y: number; readonly z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

/**
 * The body's natural-route search has a hard 56/64-block budget. A camp
 * ninety blocks away is still a valid destination, but one command cannot
 * cover it. Let long transfers settle on a verified partial route (at least
 * four blocks of real progress) and re-plan from the new position. Short
 * station approaches keep the strict "must arrive" contract.
 */
const PARTIAL_TRANSFER_DISTANCE = 48;

/**
 * How close the body must already be to a mine stand before a recorded route
 * rejection applies to it. Entries are written from the body's position at
 * failure time, so a rejection earned across the map says nothing about the
 * shaft itself; ignoring distant entries lets the planner walk a fresh leg
 * toward the mine instead of disabling it permanently.
 */

function transferAcceptsPartial(
  facts: WorldFacts,
  target: { readonly x: number; readonly y: number; readonly z: number },
): boolean {
  const position = facts.position;
  return position !== undefined &&
    position !== null &&
    distanceTo(position, target) > PARTIAL_TRANSFER_DISTANCE;
}

function nearbyPoint(block: NearbyBlock | null): { x: number; y: number; z: number } | undefined {
  return block !== null && blockHasLocation(block)
    ? { x: block.x!, y: block.y!, z: block.z! }
    : undefined;
}

/**
 * Exact cells are mandatory for a planned tunnel or hut blueprint, but not
 * for opportunistic gathering. A nearby-block scan can name a stone five
 * blocks under the floor with no walking route; pinning that cell makes the
 * mine skill retry an impossible approach forever. Only lock an opportunistic
 * target when it is genuinely beside the body, otherwise let the body choose
 * a reachable block of the requested type.
 */
function exactOpportunisticAt(
  block: NearbyBlock,
  facts: WorldFacts,
): { at?: { x: number; y: number; z: number } } {
  const position = facts.position;
  if (!blockHasLocation(block) || position === undefined || position === null) {
    return {};
  }
  // A visible block several floors below a pit is not a walking target.
  if (Math.abs(block.y! - position.y) > 2) return {};
  const distance = Math.hypot(
    block.x! - position.x,
    block.y! - position.y,
    block.z! - position.z,
  );
  if (distance > 6) return {};
  return { at: { x: block.x!, y: block.y!, z: block.z! } };
}

/**
 * A located ore only saves a trip when the body can actually hit it from
 * where it stands. Ores seen through a wall six blocks away are not an
 * invitation to walk there: the walking route is usually partial, and the
 * resulting "approach made no progress" failure sends the body back up the
 * staircase instead of continuing the descent.
 */
function withinInteractionReach(
  facts: WorldFacts,
  block: NearbyBlock,
  max = 4.5,
): boolean {
  const position = facts.position;
  if (position === undefined || position === null) return false;
  if (blockHasLocation(block)) {
    if (Math.abs(block.y! - position.y) > 2) return false;
    return (
      Math.hypot(block.x! - position.x, block.y! - position.y, block.z! - position.z) <=
      max
    );
  }
  return (block.distance ?? Number.POSITIVE_INFINITY) <= max;
}

export function gotoHomeTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
  options: {
    readonly anchors?: readonly { readonly x: number; readonly y: number; readonly z: number }[];
    readonly title?: string;
  } = {},
): Task | null {
  const position = facts.position;
  if (position === undefined || position === null) return null;
  const anchors = options.anchors ?? homeAnchors(facts);
  if (anchors.length === 0) return null;
  // Stand beside a station, never inside its own cell. `anchor.y` is the feet
  // level of the floor the station sits on; `anchor.y + 1` is its top face.
  // Offering both lets a chest on a raised block be approached from its own
  // level instead of asking the body to jump two blocks onto the shelf.
  const seen = new Set<string>();
  const candidates: {
    x: number;
    y: number;
    z: number;
    anchor: number;
    level: number;
  }[] = [];
  // A station can sit on a shelf: the chest is often two blocks above the
  // floor the body walks on. Offering several heights lets a raised chest be
  // approached from its own level instead of asking the body to jump onto
  // the shelf. Level-major order keeps every remembered station represented
  // in the first eight cells instead of spending them all on the chest.
  for (const [level, offset] of [0, 1, -1, -2].entries()) {
    for (const side of [0, 1, 2, 3]) {
      for (const [anchorIndex, anchor] of anchors.entries()) {
        const y = anchor.y + offset;
        const cell =
          side === 0
            ? { x: anchor.x + 1, y, z: anchor.z }
            : side === 1
              ? { x: anchor.x - 1, y, z: anchor.z }
              : side === 2
                ? { x: anchor.x, y, z: anchor.z + 1 }
                : { x: anchor.x, y, z: anchor.z - 1 };
        const key = `${cell.x},${cell.y},${cell.z}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({ ...cell, anchor: anchorIndex, level });
        }
      }
    }
  }
  /*
   * Rank by station and floor level only. The old comparator mixed in the
   * body's current distance, so walking toward the east side of the chest
   * made the west side look closer on the next tick and the body reversed.
   * That produced the visible 77 <-> 83 block oscillation on the beach. A
   * stable order lets the bridge try every side of the same station without
   * the plan changing its mind every snapshot.
   */
  candidates.sort(
    (left, right) =>
      left.level - right.level ||
      left.anchor - right.anchor,
  );
  const ranked = candidates.slice(0, 8).map(({ x, y, z }) => ({ x, y, z }));
  /*
   * A plain walk cannot leave a mine: the only way up the reusable staircase
   * is a one-block jump per step. Asking for `walk` here made the body pace
   * beside its own shaft until the ledge guard blacklisted every drop, then
   * the circuit breaker idled. `recover` turns on the body's stair-building
   * and wall-breaking escape, which is exactly what a player does to get back
   * to the surface chest.
   */
  /*
   * Use the observed mine state, not only the destination's Y delta. A body
   * eight blocks below the surface can have a chest only two blocks above it;
   * plain walking still cannot climb out of the sealed pit. `recover` enables
   * the one-block staircase/tunnel escape that a player would use.
   */
  const needsClimb =
    isUnderground(facts) || position.y + 2 < (ranked[0]?.y ?? position.y);
  const travelMode = needsClimb ? "recover" : "walk";
  const destination = ranked[0]!;
  /*
   * Long transfers are handled by the body, not by invented radial
   * waypoints. The old code picked points forty blocks away at the body's
   * current feet height; over a shoreline or a valley those cells sat in
   * water or past a cliff, the pathfinder proved a partial route to them,
   * and the thief-style "dangerous drop or water ahead" probe then failed
   * the task on every retry. Ask for the real destination with
   * `acceptPartial: true`: the bounded A* search ends on a cell it proved
   * walkable and reports that as the leg's endpoint, so the next snapshot
   * re-plans from real terrain instead of a guessed coordinate.
   */
  return {
    id: `task:${newId()}`,
    stage,
    kind: "navigate",
    title: options.title ?? "回家",
    skill: skill("goto", {
      target: ranked[0],
      candidates: ranked,
      acceptPartial: transferAcceptsPartial(facts, ranked[0]!),
      mode: travelMode,
    }, newId),
    preconditions: ["a placed home station is remembered", "a safe route home exists"],
    expectedEvidence: ["the body reaches the camp"],
    verify: (next) => {
      const arrived = next.position;
      if (arrived === undefined || arrived === null) return false;
      // "Started walking" is not "home". The old always-true verification
      // completed the task on the first snapshot while the body was still
      // several blocks away, so the planner immediately alternated between
      // the chest and the table and produced a visible back-and-forth loop.
      return (
        anchors.some(
          (anchor) =>
            Math.hypot(arrived.x - anchor.x, arrived.z - anchor.z) <= 6 &&
            arrived.y >= anchor.y - 6 &&
            arrived.y <= anchor.y + 3,
        ) ||
        ranked.some((candidate) => distanceTo(arrived, candidate) <= 1.75)
      );
    },
  };
}

/**
 * Returning from a mine is not the same as walking to a remembered table.
 * A deep staircase can leave the body below its own camp, so plan an explicit
 * climb back to the surface before hunger, a broken pickaxe or a full
 * backpack turns a productive trip into a death.
 */
export function returnToSurfaceTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  if (!isUnderground(facts)) return null;
  // Only a dimension we positively recognise as hostile to the overworld
  // heightmap may veto the climb. A snapshot without `world` reports
  // "unverified", which used to make every surface return impossible and left
  // the body sweeping for wood inside its own shaft.
  if (facts.dimension === "nether" || facts.dimension === "end") return null;
  const position = facts.position;
  const surface = facts.surfaceY;
  if (position === undefined || position === null || surface === undefined || surface === null) {
    return null;
  }
  const currentY = Math.round(position.y);
  const surfaceTargetY = Math.round(surface) + 1;
  const remaining = surfaceTargetY - currentY;
  if (remaining <= 0) return null;
  /*
   * The body already dug a walkable route on the way down. A `goto` to a cell
   * twelve blocks straight above the body is almost never on that route: the
   * recover planner then cuts a fresh vertical shaft, burns the pickaxe it was
   * trying to save, and can strand the body on a pillar it can no longer mine.
   * When the body is still beside its own stair, climb the staircase it made.
   * `acceptPartial` lets the bounded pathfinder return the highest reachable
   * step; the next snapshot continues from there instead of failing the whole
   * climb.
   */
  const entrance = facts.mine?.entrance ?? null;
  if (
    entrance !== null &&
    facts.mine?.stair !== undefined &&
    nearMineStair(facts)
  ) {
    /*
     * A long `goto` target asks the walker to solve the whole staircase at
     * once. At the bottom step that route is often rejected, and the bridge's
     * destructive escape then refuses to keep tunnelling once two side walls
     * are open. Give the pathfinder the next step up as a candidate so one
     * snapshot advances one stair cell; the following snapshot plans the next.
     */
    const stair = facts.mine.stair;
    const stand = stair.stand;
    const pending = stair.pending;
    const stepX = pending === undefined ? 0 : Math.sign(pending.x - stand.x);
    const stepZ = pending === undefined ? 0 : Math.sign(pending.z - stand.z);
    /*
     * The walker floors a one-block-high target to the cell the body already
     * stands on (`destination.y` equals the current feet Y), so a single stair
     * step completed without moving. Two steps up forces the route to end on
     * the intermediate step one block higher.
     *
     * Anchor the step on the live body, not on the remembered stand. After a
     * partial climb the snapshot often still reports the deepest recorded
     * stand, so a target derived from it can land on the body's own column
     * one block up: not standable, and previously "near" enough to complete
     * without moving. Projecting two cells forward along the climb direction
     * gives the pathfinder (and the escape planner) a real heading.
     */
    const anchorX = Math.round(position.x);
    const anchorZ = Math.round(position.z);
    const anchorY = Math.round(position.y);
    const nextStep =
      stepX === 0 && stepZ === 0
        ? null
        : {
            x: anchorX - stepX * 2,
            y: anchorY + 2,
            z: anchorZ - stepZ * 2,
          };
    return {
      id: `task:${newId()}`,
      stage,
      kind: "navigate",
      title: `沿矿道返回地表（还差 ${remaining} 格）`,
      skill: skill("goto", {
        target: nextStep ?? entrance,
        ...(nextStep === null ? {} : { candidates: [nextStep, entrance] }),
        /*
         * Recover first asks the pathfinder for the open tunnel and only
         * pillars when no walk route exists. Plain walk deadlocked a body in
         * a vertical rescue shaft with "no natural route"; the old recover
         * target twelve blocks straight above then cut a new shaft because it
         * was not on the route home. Target the real entrance instead.
         */
        mode: "recover",
      }, newId),
      preconditions: [
        "the body is underground",
        "the body is standing on the staircase it dug",
        "the route back to the entrance is still open",
      ],
      expectedEvidence: ["the body returns to the surface", "canSeeSky becomes true"],
      verify: (next) =>
        next.canSeeSky === true ||
        (next.position?.y ?? Number.NEGATIVE_INFINITY) >=
          (next.surfaceY ?? Number.POSITIVE_INFINITY) - 2 ||
        // One staged stair cell is real progress; waiting for the surface in
        // a single command turned every successful step into a failed task.
        (next.position?.y ?? Number.NEGATIVE_INFINITY) > currentY + 0.5,
    };
  }
  // A single goto from y=16 to y=80 asks the bounded pathfinder for a route
  // that usually does not exist. The body can only mine a staircase in short
  // increments; the previous exact surface target failed with "safe route
  // stopped short" and was reissued byte-identically every retry. Climb in
  // 12-block stages, then re-read the real surface height from the next
  // snapshot.
  const targetY = Math.min(surfaceTargetY, currentY + 12);
  if (targetY <= currentY) return null;
  const x = Math.round(position.x);
  const z = Math.round(position.z);
  const target = { x, y: targetY, z };
  const candidates = [
    target,
    { x: x + 1, y: targetY, z },
    { x: x - 1, y: targetY, z },
    { x, y: targetY, z: z + 1 },
    { x, y: targetY, z: z - 1 },
  ];
  return {
    id: `task:${newId()}`,
    stage,
    kind: "navigate",
    title:
      remaining > 12
        ? `挖阶梯返回地表（还差 ${remaining} 格）`
        : "返回地表，先离开矿洞",
    skill: skill("goto", {
      target: candidates[0],
      candidates,
      acceptPartial: false,
      mode: "recover",
    }, newId),
    preconditions: [
      "the body is underground",
      "the local surface height is observed",
      "a walkable staircase back exists",
    ],
    expectedEvidence: ["the body returns to the surface", "canSeeSky becomes true"],
    verify: (next) =>
      next.canSeeSky === true ||
      (next.position?.y ?? Number.NEGATIVE_INFINITY) >=
        (next.surfaceY ?? Number.POSITIVE_INFINITY) - 2,
  };
}

/**
 * Mining trips are long. Leave before the pickaxe, food or backpack runs out;
 * a body that reaches the ore layer with two durability left cannot climb
 * back out and the next plan only repeats the same failure.
 */
function miningReturnTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  // Food and tool recovery own their own surface/table trips. Returning here
  // would pre-empt the craft that makes the climb possible in the first place.
  if (stage === "food") return null;
  if (!isUnderground(facts)) return null;
  // A broken pickaxe is the strongest reason to leave, not a reason to stay.
  // The return route is the staircase already dug on the way down; it must
  // not depend on having a tool left to dig new blocks.
  if (!hasUsablePickaxe(facts)) {
    // Unless the body is standing next to its own table with the material
    // for a replacement, in which case repairing the tool in place is the
    // human move. A thirty-block climb to a surface table is not "nearby".
    if (canRepairPickaxeAtTable(facts)) return null;
    // Wood and cobblestone in the backpack are enough for a rescue table and
    // a new pickaxe. Let the stage craft locally instead of walking home
    // empty-handed or punching stone with no tool.
    if (canCraftReplacementPickaxe(facts)) return null;
    return returnToSurfaceTask(stage, facts, newId);
  }
  const depth = depthBelowSurface(facts) ?? 0;
  if (depth < 12) return null;
  const uses = pickaxeUses(facts, Math.max(1, pickaxeTier(facts)));
  const inventoryFull = !hasTripCapacity(stage, facts);
  const lowFood = (facts.food ?? 20) < 8;
  // Leaving the mine cannot heal anything by itself: eating is the remedy,
  // and criticalHealthFoodTask already hunts a meal below four hearts. Only
  // count low health when the hunger bar can actually back regeneration,
  // otherwise a five-heart body with 13 hunger walked up and straight back
  // down the same staircase.
  const lowHealth = isLowHealth(facts) && (facts.food ?? 20) >= 17;
  // Walking back up the staircase does not consume the pickaxe. Reserve only
  // enough uses to finish the current cut and handle one blocked step.
  const exhausted = uses !== null && uses < 16;
  if (!inventoryFull && !lowFood && !lowHealth && !exhausted) {
    return null;
  }
  return returnToSurfaceTask(stage, facts, newId);
}

/**
 * One cell of the reusable mine. The body snapshot owns the geometry and
 * names both the standing cell and the next block; the planner only decides
 * "walk there" or "break this block". Splitting it this way keeps a single
 * blocked step from discarding a staircase that is already half finished.
 */
function mineStepTask(
  stage: GoalId,
  facts: WorldFacts,
  targetY: number,
  title: string,
  newId: () => string,
  allowBranchAtDepth = false,
): Task | null {
  const mine = facts.mine;
  const position = facts.position;
  if (mine === undefined || mine === null || position === undefined || position === null) {
    return null;
  }
  const descending = position.y > targetY;
  /*
   * A stair whose next landing is water or void publishes a stand with no
   * pending cell. The live iron run reached y=46, hit exactly that dead end,
   * ignored the body's valid side-branch blueprint, and climbed 28 blocks
   * back to the surface only to walk down the same shaft again. When the
   * caller is deliberately mining for ore, continue on the branch at the
   * depth the body actually reached.
   *
   * The same blueprint can point at a shallow stand while the body has
   * already climbed or tunneled below it. Treating that as a request to
   * "return to the surface" produced the live y=48 climb followed by a walk
   * straight back down. A branch at the body's own level is the productive
   * way out of both cases.
   */
  const stairAbove =
    isUnderground(facts) &&
    mine.stair !== undefined &&
    position.y < mine.stair.stand.y - 2;
  const branchAtDepth =
    allowBranchAtDepth &&
    mine.branch !== undefined &&
    (stairAbove || (descending && mine.stair?.pending === undefined));
  const onBranch = !descending || branchAtDepth;
  const step = onBranch ? mine.branch : mine.stair;
	if (step === undefined) {
		/*
		 * A surface body can stand beside a remembered entrance whose stair is
		 * temporarily missing from the snapshot (a block update, or the body
		 * walked off the line). Returning null there made the whole iron stage
		 * blocked and the body idled, or worse, cut a fresh staircase wherever
		 * it happened to stand. Walk back to the fixed entrance first so the
		 * next snapshot can rebuild the blueprint.
		 */
		const entrance = mine.entrance;
		if (
			position.y >= entrance.y - 2 &&
			distanceTo(position, entrance) > 3
		) {
			const entranceBlocked = routePointBlacklisted(facts, entrance);
			return {
				id: `task:${newId()}`,
				stage,
				kind: "navigate",
				title: "返回矿道入口重新规划",
				skill: skill(
					"goto",
					{
						target: entrance,
						mode: entranceBlocked ? "recover" : "walk",
					},
					newId,
				),
				preconditions: [
					"the body remembers its fixed mine entrance",
					"the stair blueprint is temporarily unavailable",
				],
				expectedEvidence: ["the body reaches the mine entrance"],
				verify: (next) =>
					next.position !== undefined &&
					next.position !== null &&
					distanceTo(next.position, entrance) <= 3,
			};
		}
		return null;
	}
  const stand = step.stand;
  /*
   * A blueprint rebuilt from the surface can name a shallow stand while the
   * body is still deep in the old shaft. The bounded pathfinder cannot climb
   * from y=38 to that y=67 cell, so every retry mined into the nearest wall.
   * Treat an upward jump of more than one step as a broken blueprint and let
   * the caller plan a real staged climb to the surface.
   */
  if (isUnderground(facts) && position.y < stand.y - 2) {
    return null;
  }
  /*
   * A body that climbed a vertical rescue shaft can end up above its stair
   * with no walk route down. Reconnect to the stair step at the body's own
   * level first: the horizontal gap gives the recover planner a direction to
   * tunnel, while a target straight below only repeats the climb/drop loop.
   */
  if (position.y > stand.y + 2) {
    const levelCell = straightStairCell(mine, Math.round(position.y));
    if (levelCell !== null && distanceTo(position, levelCell) > 2.5) {
      return {
        id: `task:${newId()}`,
        stage,
        kind: "navigate",
        title: "打通回到复用矿道台阶",
        skill: skill("goto", {
          target: levelCell,
          mode: "recover",
        }, newId),
        preconditions: [
          "the body is above its remembered staircase",
          "a straight stair step exists at the body's level",
        ],
        expectedEvidence: ["the body reaches the stair step horizontally"],
        verify: (next) =>
          next.position !== undefined &&
          next.position !== null &&
          distanceTo(next.position, levelCell) <= 2,
      };
    }
  }
  /*
   * The blacklist records "the body could not walk to this cell from where
   * it stood", not "the shaft is invalid". Treating it as a dead end parked
   * the whole iron stage: the body's own stair stand was blacklisted after a
   * creeper death, every later plan returned no task, and the goal idled.
   * Keep the mine actionable and escalate the approach to recovery mode so
   * the body may mine or bridge the last step instead of repeating a walk.
   */
  const standBlocked = routePointBlacklisted(facts, stand);
  if (distanceTo(position, stand) > 2 || Math.abs(position.y - stand.y) > 1) {
    return {
      id: `task:${newId()}`,
      stage,
      kind: "navigate",
      title: onBranch ? "沿复用矿道前进一格" : "前往复用矿道下一阶",
      skill: skill(
        "goto",
        { target: stand, mode: standBlocked ? "recover" : "walk" },
        newId,
      ),
      preconditions: [
        "the body remembers its fixed mine entrance",
        "the staircase or branch stand cell is already open",
      ],
      expectedEvidence: ["the body reaches the next mine stand cell"],
      verify: (next) =>
        next.position !== undefined &&
        next.position !== null &&
        distanceTo(next.position, stand) <= 2,
    };
  }
  const pending = step.pending;
  if (pending === undefined) return null;
  /*
   * A staircase cell is tunnel excavation, not resource gathering. The drop
   * often lands in the pit the body just opened and is no longer reachable
   * from a safe standing cell; failing the whole step then retries the same
   * cell forever. Ores are different: their drop is the reason for the trip,
   * so only non-ore stair cells may complete on block-break evidence alone.
   */
  const requireDrop =
    onBranch || /(_ore$|ancient_debris$)/u.test(pending.id);
  return {
    id: `task:${newId()}`,
    stage,
    kind: "mine",
    title: !onBranch
      ? `${title}（复用矿道第 ${("depth" in step ? step.depth : 0) + 1} 阶）`
      : `${title}（复用矿道支线 ${("distance" in step ? step.distance : 0) + 1} 格）`,
    skill: skill("mine_block", {
      block: pending.id,
      count: 1,
      at: { x: pending.x, y: pending.y, z: pending.z },
      ...(requireDrop ? {} : { requireDrop: false }),
    }, newId),
    preconditions: [
      "a pickaxe can harvest the exact next staircase cell",
      "the cell has no fluid and a solid landing floor",
    ],
    expectedEvidence: ["the named cell becomes air", "the mine plan advances by one cell"],
    verify: (next) => {
      const nextMine = next.mine;
      if (nextMine === undefined || nextMine === null) return true;
      const nextStep = onBranch ? nextMine.branch : nextMine.stair;
      if (nextStep === undefined || nextStep.pending === undefined) return true;
      return (
        nextStep.pending.x !== pending.x ||
        nextStep.pending.y !== pending.y ||
        nextStep.pending.z !== pending.z
      );
    },
  };
}

/**
 * A body partway down its own staircase is normally one diagonal step from
 * the published stand: 2.5 blocks in 3D is the stair geometry, not evidence
 * that it wandered away from the mine. The old 2.5 threshold was also half a
 * block tighter than the 2-block arrival test in `mineStepTask`, so a body
 * at 2.53 blocks was sent to the surface entrance, walked back down one
 * step, and repeated the climb.
 */
function nearMineStair(facts: WorldFacts): boolean {
  const position = facts.position;
  const stand = facts.mine?.stair?.stand;
  if (
    position === undefined ||
    position === null ||
    stand === undefined ||
    stand === null
  ) {
    return false;
  }
  return Math.abs(position.y - stand.y) <= 2 && distanceTo(position, stand) <= 5;
}

/**
 * The entrance-relative stair cell at one Y level. A shaft that turned or has
 * a branch does not follow the entrance heading any more; in that case the
 * remembered lowest stand is off the line and this returns null instead of
 * naming a wall cell.
 */
function straightStairCell(
  mine: NonNullable<WorldFacts["mine"]>,
  levelY: number,
): { readonly x: number; readonly y: number; readonly z: number } | null {
  const stair = mine.stair;
  if (stair === undefined) return null;
  const steps = Math.round(mine.entrance.y - levelY);
  if (steps <= 0) return null;
  const dx =
    mine.direction === "west" ? -1 : mine.direction === "east" ? 1 : 0;
  const dz =
    mine.direction === "north" ? -1 : mine.direction === "south" ? 1 : 0;
  if (dx === 0 && dz === 0) return null;
  const standSteps = Math.round(mine.entrance.y - stair.stand.y);
  const lineX = mine.entrance.x + dx * standSteps;
  const lineZ = mine.entrance.z + dz * standSteps;
  if (Math.abs(stair.stand.x - lineX) > 1 || Math.abs(stair.stand.z - lineZ) > 1) {
    return null;
  }
  const x = mine.entrance.x + dx * steps;
  const z = mine.entrance.z + dz * steps;
  return { x, y: levelY, z };
}

function canRepairPickaxeAtTable(facts: WorldFacts): boolean {
  if (
    inventoryCount(facts, "minecraft:cobblestone") < 3 ||
    inventoryCount(facts, "minecraft:stick") < 2
  ) {
    return false;
  }
  if (hasStation(facts, "crafting_table") || facts.craftingTableNearby === true) {
    return true;
  }
  const table = facts.craftingTable;
  const position = facts.position;
  return (
    table !== undefined &&
    table !== null &&
    position !== undefined &&
    position !== null &&
    distanceTo(position, table) <= 16
  );
}

/**
 * Can the body build a table and a usable pickaxe from what it already holds?
 * This is deliberately about materials, not about the remembered table's
 * distance: a stranded body may be fifty blocks below its camp.
 */
function canCraftReplacementPickaxe(facts: WorldFacts): boolean {
  const planks = facts.inventory
    .filter((slot) => /(^|:)[a-z_]+_planks$/u.test(slot.item))
    .reduce((total, slot) => total + slot.count, 0);
  const tableMaterial =
    hasItem(facts, "minecraft:crafting_table") ||
    hasStation(facts, "crafting_table") ||
    facts.craftingTableNearby === true ||
    planks >= 4 ||
    logCount(facts) >= 1;
  if (!tableMaterial) return false;
  if (inventoryCount(facts, "minecraft:stick") < 2) return false;
  return (
    inventoryCount(facts, "minecraft:cobblestone") >= 3 ||
    planks >= 3 ||
    logCount(facts) >= 2
  );
}

/**
 * Builds a replacement pickaxe at the nearest reachable station. This is the
 * same "repair before the long trip" decision a player makes, and it keeps a
 * half-worn tool from parking the whole iron stage.
 */
function replacementPickaxeTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask | null {
  const planks = facts.inventory
    .filter((slot) => PLANK_ITEMS.test(slot.item))
    .reduce((total, slot) => total + slot.count, 0);
  const logs = logCount(facts);
  const stickSupply =
    inventoryCount(facts, "minecraft:stick") + planks * 4 + logs * 16;
  /*
   * One plank yields four sticks. Requiring a literal stick stack blocked a
   * body with two birch planks and 161 cobblestone behind a "pickaxe only has
   * 23 uses" wall; the tool was one craft away. Let the prerequisite chain
   * turn planks (or logs) into sticks before the pickaxe.
   */
  const stone =
    inventoryCount(facts, "minecraft:cobblestone") >= 3 &&
    stickSupply >= 2;
  const wooden =
    stickSupply >= 2 &&
    (planks >= 3 || logs >= 1);
  if (!stone && !wooden) return null;
  const table = ensureTable(facts, stage, newId);
  if (table !== null) return table;
  const recipe = queryRecipe(
    stone ? "minecraft:stone_pickaxe" : "minecraft:wooden_pickaxe",
  );
  if (recipe === null) return null;
  const missing = missingForRecipe(recipe, facts);
  if (missing.length === 0) return craftTask(recipe, stage, facts, newId);
  const prerequisite = craftWithPrerequisite(
    recipe,
    stage,
    facts,
    newId,
    "补充镐子材料",
  );
  return "skill" in prerequisite ? prerequisite : null;
}

/**
 * A deep trip can outlast one stone pickaxe. Replacing a broken tool on the
 * way up is far more expensive than carrying a spare: the live run spent a
 * whole pickaxe cutting a rescue shaft, then stood at y=48 with no tool and
 * a table it could not reach. Craft the second pickaxe while the body is
 * still beside its field table on the descent, when three cobblestone and
 * two sticks are cheap and the craft skill can actually touch the station.
 */
function sparePickaxeTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  if (stage !== "iron" && stage !== "diamond-gear") return null;
  if (pickaxeTier(facts) !== 2) return null;
  const carried = facts.inventory.filter(
    (slot) => /_pickaxe$/u.test(slot.item) && slot.durability !== 0,
  ).length;
  if (carried >= 2) return null;
  /*
   * A spare is prepared beside a usable field table, not after climbing a
   * deep shaft. The live iron run at y=45 kept ordering a second stone
   * pickaxe from a table 23 blocks above; the craft could not route up the
   * stair, recovery reissued it, and the body stopped mining with two raw
   * iron already in the pack. The spare matters less than the ore trip.
   */
  const table = facts.craftingTable;
  const position = facts.position;
  if (
    isUnderground(facts) &&
    table !== undefined &&
    table !== null &&
    position !== undefined &&
    position !== null &&
    (table.y - position.y > 8 || table.y - position.y < -1)
  ) {
    // A table several blocks above is a climb; one below the feet is a hole
    // the walker cannot enter. The live y=43 body had its old field table at
    // y=40 behind the stair wall: distance said "reachable", but every craft
    // approach made no progress and the stage alternated craft/goto forever.
    return null;
  }
  /*
   * The bridge's reachability probe is authoritative for an old table the
   * body cannot touch. A freshly placed bench can miss the crosshair ray for
   * a few ticks, so keep that one eligible; a walled-off field table must
   * not keep re-issuing a craft the body can never start. The live y=43 run
   * alternated craft/goto five times while three iron ores sat beside it.
   */
  const freshTable =
    facts.craftingTableAgeTicks !== undefined &&
    facts.craftingTableAgeTicks !== null &&
    facts.craftingTableAgeTicks <= 20 * 10;
  if (facts.craftingTableReachable === false && !freshTable) return null;
  if (
    !hasStation(facts, "crafting_table") &&
    facts.craftingTableNearby !== true &&
    !placedTableWithinWalk(facts)
  ) {
    return null;
  }
  const recipe = queryRecipe("minecraft:stone_pickaxe");
  if (recipe === null || missingForRecipe(recipe, facts).length > 0) {
    return null;
  }
  return {
    ...craftTask(recipe, stage, facts, newId),
    title: "补充备用石镐",
  };
}

/**
 * A temporary field furnace is the underground version of a rescue table:
 * place it beside the ore, smelt what is already in the backpack, then
 * reclaim it before leaving. It is only offered when there is metal worth
 * smelting and the body carries the furnace or its eight cobblestone.
 */
function fieldFurnaceTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask | null {
  if (!deepUnderground(facts)) return null;
  // Two stations in one column make the lower one impossible to open: the
  // table sits on the furnace's interaction face. A player clears the bench
  // first, places the furnace in the open cell, then puts the bench back.
  const position = facts.position;
  const table = facts.craftingTable;
  const camp = facts.chest ?? facts.bed ?? null;
  const furnaceItem = hasItem(facts, "minecraft:furnace");
  if (
    /*
     * Only clear the bench when the furnace is already in the pack. Reclaiming
     * it first while the furnace still has to be crafted removed the very
     * station the 3x3 recipe needs, so the next plan placed the table again
     * and the plan after that reclaimed it: the live place/reclaim loop.
     */
    furnaceItem &&
    facts.craftingTablePlaced === true &&
    table !== undefined &&
    table !== null &&
    position !== undefined &&
    position !== null &&
    distanceTo(position, table) <= 4 &&
    (camp === null || distanceTo(camp, table) > 12)
  ) {
    return {
      ...reclaimTask(stage, facts, "minecraft:crafting_table", newId),
      title: "收起工作台，给临时熔炉腾位置",
    };
  }
  /*
   * A furnace placed seconds ago is still the station to use, even after the
   * body steps out of interaction reach. Re-placing one every few blocks
   * buried the live staircase in furnaces: the next descent treated the
   * furnace as the block in front, broke it, and the planner put another one
   * down in the same corridor.
   */
  if (
    facts.furnacePlaced === true &&
    (facts.furnaceAgeTicks ?? Number.POSITIVE_INFINITY) < 60 * 20
  ) {
    return null;
  }
  if (furnaceItem) {
    return {
      id: `task:${newId()}`,
      stage,
      kind: "place",
      title: "在矿洞放置临时熔炉",
      skill: skill("place_block", { block: "minecraft:furnace", count: 1 }, newId),
      preconditions: [
        "furnace in inventory",
        "a safe adjacent block face exists",
        "raw metal is ready to smelt",
      ],
      expectedEvidence: ["nearbyBlocks contains furnace"],
      verify: (next) => nearbyHas(next, /furnace$/u) !== null,
    };
  }
  const recipe = queryRecipe("minecraft:furnace");
  if (recipe === null) return null;
  const missingMaterials = missingForRecipe(recipe, facts).filter(
    (entry) => entry.kind === "material",
  );
  if (missingMaterials.length > 0) return null;
  const benchTask = fieldTableTask(stage, facts, newId);
  if (benchTask !== null) return benchTask;
  return craftTask(recipe, stage, facts, newId);
}

function benchBlocksFurnace(facts: WorldFacts): boolean {
  const table = facts.craftingTable;
  const furnace = facts.furnace;
  const position = facts.position;
  return (
    table !== undefined &&
    table !== null &&
    furnace !== undefined &&
    furnace !== null &&
    position !== undefined &&
    position !== null &&
    table.x === furnace.x &&
    table.z === furnace.z &&
    table.y === furnace.y + 1 &&
    distanceTo(position, table) <= 8
  );
}

/**
 * Places a carried table underground or crafts a 2x2 one from carried wood.
 * Unlike the camp path it never walks back to a surface station: the whole
 * point is to keep a stranded mining trip moving without a forty-block climb.
 */
function fieldTableTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask | null {
  if (hasStation(facts, "crafting_table") || facts.craftingTableNearby === true) {
    return null;
  }
  if (hasItem(facts, "minecraft:crafting_table")) {
    return placeTableTask(stage, facts, newId, true);
  }
  const recipe = queryRecipe("minecraft:crafting_table");
  if (recipe === null) return null;
  const missing = missingForRecipe(recipe, facts);
  if (missing.length === 0) {
    return craftTask(recipe, stage, facts, newId);
  }
  return preparationTask(recipe, stage, facts, newId, 0);
}

/**
 * A furnace is a camp station. If one was already placed, walk back to it
 * instead of crafting and placing another wherever the body happens to be.
 */
function gotoFurnaceTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  const furnaceInReach =
    (facts.stations ?? []).includes("furnace") ||
    (facts.nearbyBlocks ?? []).some((block) =>
      /(^|:)furnace$|(^|:)blast_furnace$/u.test(block.id),
    );
  if (furnaceInReach) return null;
  const furnace = facts.furnace;
  if (furnace === undefined || furnace === null) {
    return facts.furnacePlaced === true ? gotoHomeTask(stage, facts, newId) : null;
  }
  const position = facts.position;
  // A surface furnace above a cave is not reachable by a straight goto. The
  // body's pathfinder tries the local staircase first, but a direct request
  // forty blocks up routinely ends as "could not pillar through the ceiling".
  // Climb toward daylight in bounded stages, then walk to the station.
  if (
    deepUnderground(facts) &&
    position !== undefined &&
    position !== null &&
    furnace.y - position.y > 8
  ) {
    const surface = returnToSurfaceTask(stage, facts, newId);
    if (surface !== null) return surface;
  }
  // Euclidean distance is not reachability. A furnace five blocks away
  // behind a wall is still a station to walk to; only the observed
  // `furnaceInReach` check above may claim it is usable right now.
  const y = furnace.y + 1;
  const candidates = [y, y - 1, y - 2].flatMap((level) => [
    { x: furnace.x + 1, y: level, z: furnace.z },
    { x: furnace.x - 1, y: level, z: furnace.z },
    { x: furnace.x, y: level, z: furnace.z + 1 },
    { x: furnace.x, y: level, z: furnace.z - 1 },
  ]).slice(0, 8);
  return {
    id: `task:${newId()}`,
    stage,
    kind: "navigate",
    title: "走回熔炉",
    skill: skill("goto", {
      target: candidates[0],
      candidates,
      acceptPartial: transferAcceptsPartial(facts, candidates[0]!),
      mode: "walk",
    }, newId),
    preconditions: ["a placed furnace is remembered", "a route to the station exists"],
    expectedEvidence: ["the furnace enters interaction range"],
    verify: (next) =>
      next.position !== undefined &&
      next.position !== null &&
      candidates.some((candidate) => distanceTo(next.position!, candidate) <= 2),
  };
}

/**
 * Stations belong at the camp. When a table, furnace, chest or bed is carried
 * while the body is away, walk home before placing it instead of scattering a
 * second workstation across the map.
 */
function gotoCampBeforePlacement(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  return atCamp(facts) ? null : gotoHomeTask(stage, facts, newId);
}

function placeChestTask(
  stage: GoalId,
  facts: WorldFacts,
  item: string,
  newId: () => string,
  title = "在家放置箱子",
): Task | BlockedTask {
  if (deepUnderground(facts)) {
    return returnToSurfaceTask(stage, facts, newId) ??
      blocked(stage, "navigate", "返回地表再放置箱子");
  }
  const camp = gotoCampBeforePlacement(stage, facts, newId);
  if (camp !== null) return camp;
  return {
    id: `task:${newId()}`,
    stage,
    kind: "place",
    title,
    skill: skill("place_block", { block: item, count: 1 }, newId),
    preconditions: ["a chest item is in the inventory", "a safe adjacent block face exists"],
    expectedEvidence: ["the body reports a placed camp chest"],
    verify: (next) => {
      if (next.chestPlaced !== true && nearbyHas(next, /(^|:)chest$/u) === null) {
        return false;
      }
      const before = facts.chest;
      const after = next.chest;
      if (before === undefined || before === null) return true;
      // A second chest must move the remembered chest, or the next snapshot
      // still describes the full one and the planner repeats this task.
      return (
        next.chestOpenable !== false &&
        after !== undefined &&
        after !== null &&
        (after.x !== before.x || after.y !== before.y || after.z !== before.z)
      );
    },
  };
}

/**
 * A remote base whose only remembered chest is behind a blacklisted route is
 * not a usable camp. Put down a carried chest where the body already stands
 * so storage, smelting and the local mine can resume without a long transfer.
 * This is a field cache, not the temporary shelter the planner deliberately
 * stopped building.
 */
function placeFieldChestTask(
  stage: GoalId,
  facts: WorldFacts,
  item: string,
  newId: () => string,
): Task {
  return {
    id: `task:${newId()}`,
    stage,
    kind: "place",
    title: "就地放置箱子建立新的储物点",
    skill: skill("place_block", { block: item, count: 1 }, newId),
    preconditions: [
      "a chest item is in the inventory",
      "the remembered camp is no longer reachable",
      "a safe adjacent block face exists",
    ],
    expectedEvidence: [
      "the body reports a placed chest",
      "the new chest becomes the home anchor",
    ],
    verify: (next) => {
      if (next.chestPlaced !== true || next.chest === undefined || next.chest === null) {
        return false;
      }
      const before = facts.chest;
      return (
        next.chestOpenable !== false &&
        (before === undefined ||
          before === null ||
          next.chest.x !== before.x ||
          next.chest.y !== before.y ||
          next.chest.z !== before.z)
      );
    },
  };
}

function placeBedTask(
  stage: GoalId,
  facts: WorldFacts,
  item: string,
  newId: () => string,
): Task | BlockedTask | null {
  if (deepUnderground(facts)) {
    return returnToSurfaceTask(stage, facts, newId) ??
      blocked(stage, "navigate", "返回地表再放置床");
  }
  /*
   * A bed occupies two cells. In a one-wide tree pocket or emergency shaft
   * there is no orientation that fits, so place_block can only fail with
   * "both cells must be free" forever. Skip the camp chore until the body is
   * somewhere with room instead of starving the stage task.
   */
  if (facts.enclosed === true && (facts.shaftWalls ?? 0) >= 3) return null;
  const camp = gotoCampBeforePlacement(stage, facts, newId);
  if (camp !== null) return camp;
  return {
    id: `task:${newId()}`,
    stage,
    kind: "place",
    title: "在家放置床",
    skill: skill("place_block", { block: item, count: 1 }, newId),
    preconditions: ["a bed is in inventory", "a safe two-block space exists"],
    expectedEvidence: ["the body reports a placed camp bed"],
    verify: (next) => next.bedPlaced === true || nearbyHas(next, BED_ITEMS) !== null,
  };
}

function sleepTask(stage: GoalId, facts: WorldFacts, newId: () => string): Task {
  return {
    id: `task:${newId()}`,
    stage,
    kind: "interact",
    title: "回家睡觉",
    skill: skill("sleep", {}, newId),
    preconditions: ["night time", "the camp bed is nearby"],
    expectedEvidence: ["sleeping is confirmed", "day advances"],
    verify: (next) => next.sleeping === true || (next.day ?? 0) > (facts.day ?? 0),
  };
}

/**
 * A remembered bed can sit on a lower terrace than the chest. Aim at a
 * standable cell around the bed itself instead of the generic home anchor,
 * otherwise the goto never reaches the bed's floor and night loops forever.
 */
function gotoBedTask(
  stage: GoalId,
  facts: WorldFacts,
  bed: { readonly x: number; readonly y: number; readonly z: number },
  newId: () => string,
): Task | null {
  const position = facts.position;
  if (position === undefined || position === null) return null;
  const seen = new Set<string>();
  const candidates: { x: number; y: number; z: number }[] = [];
  // The bed block's own layer is the floor a player stands on; +1 is a
  // floating cell above the mattress and must not be the first choice.
  for (const y of [bed.y, bed.y - 1, bed.y + 1]) {
    for (const cell of [
      { x: bed.x + 1, y, z: bed.z },
      { x: bed.x - 1, y, z: bed.z },
      { x: bed.x, y, z: bed.z + 1 },
      { x: bed.x, y, z: bed.z - 1 },
    ]) {
      const key = `${cell.x},${cell.y},${cell.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(cell);
    }
  }
  // Keep the bed's own floor first. Sorting by the body's current distance
  // made the preferred side flip whenever the body crossed the bed's column,
  // which showed up as pacing left and right beside the bed instead of
  // arriving. The construction order is already deterministic.
  const ranked = candidates.slice(0, 8);
  return {
    id: `task:${newId()}`,
    stage,
    kind: "navigate",
    title: "走到床边",
    skill: skill("goto", {
      target: ranked[0],
      candidates: ranked,
      acceptPartial: transferAcceptsPartial(facts, ranked[0]!),
      mode: "walk",
    }, newId),
    preconditions: ["the camp bed is remembered", "a safe route to its floor exists"],
    expectedEvidence: ["the body stands on the bed's floor"],
    verify: (next) =>
      next.position !== undefined &&
      next.position !== null &&
      ranked.some((candidate) => distanceTo(next.position!, candidate) <= 2),
  };
}

/**
 * Night is not a stage. Whatever the body was doing, it should walk back to
 * the camp and sleep rather than stand in the dark next to a creeper.
 */
function nightHomeTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask | null {
  if (isNight(facts) !== true || facts.sleeping === true) return null;
  const bedNearby = nearbyHas(facts, BED_ITEMS);
  if (bedNearby !== null) {
    // The body reports when a bed face is already inside its interaction
    // ray. A bed two blocks below the rim is then usable from here; sending
    // it to a "bed floor" cell first made it circle an unreachable pit until
    // sunrise.
    if (facts.bedInReach === true) return sleepTask(stage, facts, newId);
    // Seeing the bed is not the same as standing on its floor. A bed two
    // blocks above the body used to make the planner retry `sleep` forever
    // while every approach reported no progress.
    const bedY = facts.bed?.y ?? bedNearby.y;
    const y = facts.position?.y;
    if (bedY !== undefined && y !== undefined && Math.abs(y - bedY) > 1) {
      // The camp is often terraced: the chest shelf sits three blocks above
      // the bed. Returning null here let the house task pull the body back to
      // the hut while the next night tick pulled it home again. Walk to the
      // bed's own floor instead of pretending the two stations are level.
      const bed = facts.bed ?? nearbyPoint(bedNearby);
      if (bed !== undefined) {
        const approach = gotoBedTask(stage, facts, bed, newId);
        if (approach !== null) return approach;
      }
      return null;
    }
    return sleepTask(stage, facts, newId);
  }
  const bedItem = facts.inventory.find((slot) => BED_ITEMS.test(slot.item));
  const position = facts.position;
  const campDistance = campStationDistance(facts);
  if (bedItem !== undefined) {
    // A carried bed deep underground is not an invitation to climb a
    // forty-block staircase at night. Leave the stage task (for example a
    // pickaxe rescue) in charge instead.
    if (deepUnderground(facts)) return null;
    if (
      campDistance !== null &&
      position !== undefined &&
      position !== null &&
      campDistance > 8
    ) {
      return gotoHomeTask(stage, facts, newId);
    }
    return placeBedTask(stage, facts, bedItem.item, newId);
  }
  if (
    facts.bedPlaced === true &&
    campDistance !== null &&
    position !== undefined &&
    position !== null &&
    campDistance > 8 &&
    !deepUnderground(facts)
  ) {
    return gotoHomeTask(stage, facts, newId);
  }
  // No bed means no reason to walk home just to stand still in the dark.
  // Night work (mining, crafting, storage) stays in charge until the body
  // can actually sleep.
  return null;
}

function hasBedAccess(facts: WorldFacts): boolean {
  return (
    (facts.bed !== null && facts.bed !== undefined) ||
    facts.bedPlaced === true ||
    nearbyHas(facts, BED_ITEMS) !== null ||
    facts.inventory.some((slot) => BED_ITEMS.test(slot.item))
  );
}

function executable(task: Task | BlockedTask | null): Task | null {
  return task !== null && "skill" in task ? task : null;
}

/**
 * A body too hungry to mine and carrying nothing edible. Night hunting is
 * how the live run lost most of its health, so wait out the dark; daylight
 * hunting is the normal player answer.
 */
function hungryWithoutMealTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  if ((facts.food ?? 20) >= 8) return null;
  if (facts.inventory.some((slot) => FOOD_ITEMS.test(slot.item))) return null;
  if (isNight(facts) === true) return nightRestTask(stage, facts, newId);
  const hunt = foodTask(facts, newId);
  return hunt !== null && "skill" in hunt ? hunt : null;
}

/**
 * Night without a bed is not downtime. A player keeps the camp running:
 * smelts the ore already in the pack, makes torches and a furnace, then
 * descends a safe staircase. The order is deliberately equipment-first so a
 * body never wanders into the dark bare-handed. A mine entrance is a
 * workplace, not a shelter, and this path never builds a hut.
 */
export function nightWorkTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
  options: { readonly notBefore?: number } = {},
): Task | BlockedTask | null {
  const time = facts.timeOfDay;
  const inWorkWindow =
    options.notBefore === undefined
      ? isNight(facts) === true
      : time !== null &&
        time !== undefined &&
        time >= options.notBefore;
  if (!inWorkWindow || facts.sleeping === true) return null;
  if (hasBedAccess(facts)) return null;
  if ((facts.health ?? 20) < 10) {
    /*
     * Low health is a reason to avoid night work, not a reason to have no
     * task. Returning null here left the whole planner blocked after dark
     * whenever the body was hurt, out of food, and had no bed. Hold still
     * near the current camp until daylight instead; the safety reflex
     * still preempts this wait when a hostile closes in.
     */
    return nightRestTask(stage, facts, newId);
  }
  const workStage: GoalId = hasUsablePickaxe(facts, 2)
    ? "iron"
    : "stone-tools";

  // Underground is already the right place to be at night. Continue the
  // current mining/smelting loop instead of climbing out just because the
  // sky turned dark.
  if (isUnderground(facts)) {
    const ironPlan = iron(facts, newId);
    const mining = executable(ironPlan);
    if (mining !== null) return mining;
    const craft = nightCraftTask(stage, facts, newId);
    if (craft !== null) return craft;
    return ironPlan;
  }

  // On the surface the iron stage is the best night job: it opens with a
  // furnace/torch craft, then advances the reusable staircase. If it has
  // nothing concrete to do, fall through to a local crafting task.
  const ironPlan = iron(facts, newId);
  const surfaceWork = executable(ironPlan);
  if (surfaceWork !== null) return surfaceWork;
  const craft = nightCraftTask(stage, facts, newId);
  if (craft !== null) return craft;
  if (hasUsablePickaxe(facts, 2)) {
    // No mine geometry yet. A short, bounded walk is enough for the body's
    // next snapshot to record a safe entrance; this is not a long night
    // expedition and it never digs a temporary shelter.
    return explore(
      facts,
      workStage,
      "夜间寻找安全的矿道入口",
      "平地",
      1,
      newId,
      6,
      12,
      true,
    );
  }
  const tools = executable(stoneTools(facts, newId));
  if (tools !== null) return tools;
  return (
    ironPlan ??
    blocked(stage, "mine", "夜间没有床，也没有可执行的工作")
  );
}

/**
 * A bounded hold-still action for a hurt body that cannot safely work or
 * hunt at night. Time keeps advancing while the skill waits, so the next
 * plan sees daylight and can resume the food hunt.
 */
function nightRestTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  const time = facts.timeOfDay;
  if (time === null || time === undefined || isNight(facts) !== true) {
    return null;
  }
  /*
   * Stay below the bridge's default 600-tick action deadline. The bridge does
   * not extend its default deadline for wait commands, so any request above
   * that bound reports E_TIMEOUT every night and makes a safe hold look like a
   * failed strategy. Re-planning simply issues another bounded wait.
   */
  const untilDawn = Math.max(200, Math.min(480, 23_500 - time + 100));
  return {
    id: `task:${newId()}`,
    stage,
    kind: "interact",
    title: `原地隐蔽等待天亮（约 ${Math.ceil(untilDawn / 20)} 秒）`,
    skill: skill("wait", { ticks: untilDawn }, newId),
    preconditions: [
      "health is too low for night movement",
      "no safe night work or hunt target",
    ],
    expectedEvidence: ["time advances toward daylight", "health is not lost"],
    verify: (next) =>
      next.timeOfDay === undefined ||
      next.timeOfDay === null ||
      next.timeOfDay > time,
  };
}

/**
 * Small, immediately useful crafts that do not need a surface expedition.
 * Every branch is limited to items already in the backpack so a failed
 * search cannot turn into a night-long wood hunt.
 */
function nightCraftTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  const plankStock = facts.inventory
    .filter((slot) => PLANK_ITEMS.test(slot.item))
    .reduce((total, slot) => total + slot.count, 0);
  const woodAvailable = logCount(facts) > 0 || plankStock > 0;
  const craft = (item: string): Task | null => {
    const recipe = queryRecipe(item);
    if (recipe === null) return null;
    const task = craftWithPrerequisite(
      recipe,
      stage,
      facts,
      newId,
      `制作${shortName(item)}`,
    );
    return "skill" in task ? task : null;
  };

  if (
    woodAvailable &&
    inventoryCount(facts, "minecraft:torch") < 8 &&
    inventoryCount(facts, "minecraft:coal") +
      inventoryCount(facts, "minecraft:charcoal") >
      0
  ) {
    const torches = craft("minecraft:torch");
    if (torches !== null) return torches;
  }
  if (
    !hasStation(facts, "furnace") &&
    facts.furnacePlaced !== true &&
    inventoryCount(facts, "minecraft:cobblestone") >= 8
  ) {
    const furnace = buildFurnace(facts, newId);
    if (furnace !== null && "skill" in furnace) return furnace;
  }
  if (
    woodAvailable &&
    !facts.chestPlaced &&
    usedInventorySlots(facts) >= 20 &&
    (plankStock >= 8 || logCount(facts) >= 2)
  ) {
    const chest = craft("minecraft:chest");
    if (chest !== null) return chest;
  }
  if (woodAvailable && inventoryCount(facts, "minecraft:stick") < 4) {
    const sticks = craft("minecraft:stick");
    if (sticks !== null) return sticks;
  }
  return null;
}

/*
 * Cobblestone is a tool and building reserve, not ordinary junk. It becomes
 * storable only when the body carries more than it can use. `deposit` still
 * empties one inventory stack per transfer; the range task passes
 * `maxStacks: 1`, so the reserve survives while one slot is freed for food.
 */
const STORAGE_ITEMS =
  /(^|:)(raw_copper|dirt|oak_sapling|gravel|andesite|diorite|granite|tuff|deepslate|netherrack|cobblestone)$/u;
const COBBLESTONE_RESERVE = 32;
const COBBLESTONE_DEPOSIT_STACK = 64;
/*
 * The live pack reached 30/36 slots with 132 logs, 23 sand, 6 furnaces and
 * 14 chests, but only dirt and cobblestone counted as storable. One home
 * trip freed one slot, the body mined one block, and the next snapshot sent
 * it straight back. These reserves are deliberately generous: they protect
 * the next tool/crafting job, not every spare block.
 */
const STORAGE_EXCESS: readonly (readonly [RegExp, number])[] = [
  [/(^|:)[a-z_]+_log$/u, 16],
  [/(^|:)[a-z_]+_wood$/u, 8],
  [/(^|:)sand$/u, 8],
  [/(^|:)sandstone$/u, 8],
  [/(^|:)furnace$/u, 0],
  [/(^|:)chest$/u, 0],
  [/(^|:)leather$/u, 8],
  [/(^|:)string$/u, 6],
  [/(^|:)bone$/u, 6],
  [/(^|:)wheat_seeds$/u, 3],
  [/(^|:)[a-z_]+_sapling$/u, 4],
  [/(^|:)[a-z_]+_wool$/u, 3],
  [/(^|:)rotten_flesh$/u, 2],
  [/(^|:)flint$/u, 8],
  [/(^|:)peony$/u, 0],
  [/(^|:)egg$/u, 0],
  [/(^|:)lead$/u, 0],
  [/(^|:)spider_eye$/u, 0],
];

function storageExcess(facts: WorldFacts, item: string): number | null {
  const limit = STORAGE_EXCESS.find(([pattern]) => pattern.test(item));
  return limit === undefined ? null : inventoryCount(facts, item) - limit[1];
}

function storageChoice(facts: WorldFacts): string | null {
  const cobblestone = inventoryCount(facts, "minecraft:cobblestone");
  const candidates = facts.inventory
    .filter(
      (slot) =>
        slot.count > 0 &&
        (STORAGE_ITEMS.test(slot.item)
          ? !/(^|:)cobblestone$/u.test(slot.item) ||
            cobblestone > COBBLESTONE_RESERVE + COBBLESTONE_DEPOSIT_STACK
          : (storageExcess(facts, slot.item) ?? 0) > 0),
    )
    .sort((left, right) => right.count - left.count);
  const preferred = candidates[0];
  if (preferred !== undefined) return preferred.item;
  /*
   * At 36/36 there is no slot to pick up the next drop, so freeing even a
   * reserved bulk stack is better than refusing to deposit. The reserve exists
   * to keep building material during normal trips, not to deadlock a full
   * pack at camp.
   */
  if (usedInventorySlots(facts) < 36) return null;
  return (
    facts.inventory
      .filter((slot) => STORAGE_ITEMS.test(slot.item) && slot.count > 0)
      .sort((left, right) => right.count - left.count)[0]?.item ?? null
  );
}

/**
 * Surface crafting keeps a four-slot reserve, but an active iron or diamond
 * mine needs only one free slot: stone, dirt, coal and ore merge into stacks
 * the body already carries. Reserving four slots there made the live run
 * surface after one or two mined blocks, deposit a single stack, and walk
 * straight back down.
 */
function hasTripCapacity(stage: GoalId, facts: WorldFacts): boolean {
  /*
   * A chest below the body is not a surface camp. The live mine placed its
   * only chest in the shaft, so at y=61 above a y=56 chest the old test called
   * the body "above camp" and demanded the four-slot surface reserve. At
   * 32/36 slots it then abandoned a productive iron stair, dug back down to
   * the unreachable chest, and repeated the trip after every few blocks.
   * Being underground is the actual signal for a working mine; a surface camp
   * is already excluded by `isUnderground`.
   */
  const workingMine =
    (stage === "iron" || stage === "diamond-gear") &&
    isUnderground(facts);
  /*
   * A remembered mine does not make the camp surface a working mine. Treating
   * the chest platform as one let a 35/36 pack pass the capacity check after a
   * single deposit, so the body mined one new stack, returned home, deposited
   * one stack, and repeated that commute forever. Only a body actually below
   * the surface may start a trip with one free slot; at home it must first
   * free the four-slot surface reserve.
   */
  // A working mine only has to be able to pick up the next drop. Passing a
  // reserve of one made `hasInventoryCapacity` demand two free slots, so a
  // 35/36 pack was called full and the body walked sixty blocks home to
  // deposit one stack after every one or two mined blocks.
  return hasInventoryCapacity(facts, workingMine ? 0 : 4);
}

/**
 * A full backpack is a real blocker: the body cannot pick up iron or food.
 * When the camp chest is close, offload one bulk material per task. The
 * whitelist deliberately excludes tools, food, coal, planks and logs.
 */
function homeStorageTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  const chestNearby = nearbyHas(facts, /(^|:)chest$/u);
  const rememberedChest = anchorIsUnderground(facts, facts.chest ?? null)
    ? undefined
    : facts.chest;
  const container = rememberedChest ?? nearbyPoint(chestNearby);
  const position = facts.position;
  /*
   * Standing at the chest with a nearly full pack is the cheap moment to
   * clear several junk stacks. Waiting for the next "no free slot" plan made
   * the body deposit exactly one stack, walk back to the mine, mine one
   * block, and return. Tidy down to 30 used slots so the next trip has
   * breathing room; the per-item reserves still protect tools and fuel.
   * Underground the pack can still take a full ore stack, and the live run
   * abandoned a productive iron stair at 32 slots to place a field chest and
   * then failed to open it for minutes. Require a genuinely full pack there.
   */
  const tidyThreshold = isUnderground(facts) ? 34 : 30;
  const tidying =
    position !== undefined &&
    position !== null &&
    container !== undefined &&
    distanceTo(position, container) <= 6 &&
    Math.abs(position.y - container.y) <= 2 &&
    usedInventorySlots(facts) >= tidyThreshold;
  /*
   * The bounded pathfinder cannot walk from a deep stair back to a surface
   * chest: the live body sat at y=38, was given a goto to y=67, and recovery
   * tunnelled south into the wall for minutes. The mine return task already
   * owns the staged 12-block climb up the shaft; let it run and store again
   * once the body is at the surface.
   */
  if (
    position !== undefined &&
    position !== null &&
    container !== undefined &&
    position.y < container.y - 1 &&
    isUnderground(facts)
  ) {
    return null;
  }
  if (hasTripCapacity(stage, facts) && !tidying) return null;
  // A full chest cannot accept a new stack. Walking there only to fail the
  // same deposit made the body commute between storage and the table.
  if (facts.chestEmptySlots === 0) return null;
  /*
   * Capacity alone does not prove that a trip home is useful. Once the last
   * storable stack was deposited, a body at 35/36 still failed the four-slot
   * surface reserve, so every plan walked back to the chest, found nothing to
   * store, returned to the mine entrance, and repeated. Check the inventory
   * before spending the walk instead of discovering the empty result at camp.
   */
  const item = storageChoice(facts);
  if (item === null) return null;
  const carriedChest = facts.inventory.find((slot) =>
    /(^|:)chest$/u.test(slot.item),
  );
  /*
   * Vanilla refuses to create a chest menu when a solid block covers the lid.
   * The client-side use packet still predicts SUCCESS, so retrying the same
   * chest looks like a lost packet forever. A carried chest is cheaper than
   * tearing up the shelter roof: place a new cache beside the body and let the
   * placement task move the remembered storage anchor.
   */
  if (facts.chestOpenable === false) {
    if (carriedChest !== undefined) {
      return placeFieldChestTask(stage, facts, carriedChest.item, newId);
    }
    return null;
  }
  // A remembered chest may be one floor above the body. Euclidean distance
  // does not prove that it is reachable or that the body is standing at the
  // container, so travel home first when the chest is not on this level.
  if (container === undefined) {
    if (facts.chestPlaced !== true) return null;
    return gotoHomeTask(stage, facts, newId);
  }
  if (
    position !== undefined &&
    position !== null &&
    position.y > container.y + 1
  ) {
    // A long staircase can wear out the only pickaxe. Do not fall through to
    // a plain goto: the surface route cannot reach a camp dozens of blocks
    // below, and the body has enough wood/cobblestone to restore its tools.
    // Let the current survival stage craft that pickaxe first, then storage
    // will plan the descent again from the fresher observation.
    if (pickaxeTier(facts) < 1) return null;
    // A wooden pickaxe is a bad staircase tool: a full backpack can force a
    // forty-block descent, which is close to its whole durability. When the
    // carried cobblestone can make a stone pickaxe, let the tool stage do
    // that first instead of preempting it with the urgent storage trip.
    if (
      pickaxeTier(facts) < 2 &&
      inventoryCount(facts, "minecraft:cobblestone") >= 3
    ) {
      return null;
    }
    return mineStepTask(
      stage,
      facts,
      container.y + 1,
      "沿复用矿道回营地",
      newId,
    );
  }
  /*
   * A camp chest can sit on a shelf the walker cannot climb: the live body
   * circled below a chest nine blocks above it for minutes while carrying
   * thirteen spare chests. Placing a field cache on the reachable floor is
   * what a player does. It is a one-way placement, so this cannot become the
   * table place/reclaim loop.
   */
  if (
    carriedChest !== undefined &&
    position !== undefined &&
    position !== null &&
    Math.hypot(position.x - container.x, position.z - container.z) <= 16 &&
    position.y < container.y - 2
  ) {
    return placeFieldChestTask(stage, facts, carriedChest.item, newId);
  }
  if (
    position !== undefined &&
    position !== null &&
    (distanceTo(position, container) > 6 ||
      Math.abs(position.y - container.y) > 2)
  ) {
    return gotoHomeTask(stage, facts, newId, {
      anchors: [container],
      title: "回家打开箱子存放物资",
    });
  }
  return {
    id: `task:${newId()}`,
    stage,
    kind: "gather",
    title: `把 ${shortName(item)} 存进家里箱子`,
    skill: skill("deposit", {
      item,
      container,
      maxStacks: 1,
    }, newId),
    preconditions: ["the camp chest is remembered", "a bulk material is filling the backpack"],
    expectedEvidence: ["the item count in the inventory decreases", "the chest receives the items"],
    verify: (next) => inventoryCount(next, item) < inventoryCount(facts, item),
  };
}

/**
 * A full backpack with no usable chest still has a home anchor. Walking away
 * to "search" with every slot occupied cannot produce a pickup and scattered
 * the live camp across a hillside. Return to the established camp and let the
 * next observation repair storage there.
 */
function fullBackpackCampTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  if (hasTripCapacity(stage, facts)) return null;
  if (atCamp(facts)) return null;
  const home = homeAnchor(facts);
  if (home === null) return null;
  return gotoHomeTask(stage, facts, newId, {
    anchors: [home],
    title: "背包已满，先回营地整理",
  });
}

/**
 * A camp chest with zero empty slots is full for any new stack. Repeating the
 * same deposit looped the body between the camp and an unchangeable failure,
 * so the next storage action is to make room: place a carried chest or craft
 * another one from the wood already in the backpack.
 */
function overflowStorageTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask | null {
  if (hasTripCapacity(stage, facts)) return null;
  if (facts.chestEmptySlots !== 0) return null;
  if (facts.chest === undefined || facts.chest === null) return null;
  // The chest is full: a trip to it cannot free a slot. Make room first by
  // placing or crafting another chest at the camp. The old unconditional
  // walk to the chest alternated with the table trip every few seconds.
  const spot = campStorageSpot(facts);
  if (spot === null) return null;
  const carried = facts.inventory.find((slot) => /(^|:)chest$/u.test(slot.item));
  if (carried !== undefined) {
    return placeChestAtTask(stage, facts, carried.item, spot, newId);
  }
  const recipe = queryRecipe("minecraft:chest");
  if (recipe === null) return null;
  const table = ensureTable(facts, stage, newId);
  if (table !== null) return placeOrBuildTable(table, facts, newId);
  if (missingForRecipe(recipe, facts).length === 0) {
    return craftTask(recipe, stage, facts, newId);
  }
  return craftWithPrerequisite(recipe, stage, facts, newId, "制作第二个箱子");
}

/**
 * A fixed indoor storage slot for the second chest. Candidates stay inside
 * the 3x3 interior of the starter hut; anything already occupied by the
 * body, bed, table or furnace is skipped so the next chest has one permanent
 * home instead of being dropped wherever the body stops.
 */
function campStorageSpot(
  facts: WorldFacts,
): { readonly x: number; readonly y: number; readonly z: number } | null {
  const chest = facts.chest;
  if (chest === undefined || chest === null) return null;
  // The hut may sit on a flatter cell a few blocks from the old chest
  // instead of being centred on it. Once a shelter exists, its floor-level
  // origin is the authoritative interior frame; anchoring storage to the old
  // outdoor chest would drop the second chest next to a wall or outside.
  const interior = facts.shelter ?? chest;
  const blocked = new Set<string>();
  const block = (position: { readonly x: number; readonly y: number; readonly z: number } | null | undefined) => {
    if (position === null || position === undefined) return;
    blocked.add(
      `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`,
    );
  };
  block(facts.position);
  /*
   * The body occupies two cells. Blocking only its feet let the planner pick
   * the head cell as the second chest spot; the Java place task then refused
   * with "overlaps the body" and reissued the identical task forever.
   */
  if (facts.position !== undefined && facts.position !== null) {
    block({
      x: facts.position.x,
      y: facts.position.y + 1,
      z: facts.position.z,
    });
    /*
     * A body standing in a two-deep dip reaches the chest floor at y+2.
     * Choosing that cell put the chest directly above its head: Java had no
     * support face and repeated the same refused placement.
     */
    block({
      x: facts.position.x,
      y: facts.position.y + 2,
      z: facts.position.z,
    });
  }
  block(facts.bed);
  block(facts.craftingTable);
  block(facts.furnace);
  const offsets: readonly (readonly [number, number])[] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];
  for (const [dx, dz] of offsets) {
    const spot = { x: interior.x + dx, y: interior.y, z: interior.z + dz };
    if (!blocked.has(`${spot.x},${spot.y},${spot.z}`)) return spot;
  }
  return null;
}

function placeChestAtTask(
  stage: GoalId,
  facts: WorldFacts,
  item: string,
  at: { readonly x: number; readonly y: number; readonly z: number },
  newId: () => string,
): Task | BlockedTask {
  if (deepUnderground(facts)) {
    return returnToSurfaceTask(stage, facts, newId) ??
      blocked(stage, "navigate", "返回地表再整理储物");
  }
  const position = facts.position;
  /*
   * The fixed indoor slot is only trustworthy when the body actually knows
   * its shelter frame. A live camp under a tree had no shelter coordinate,
   * so `chest + offset` named a floating cell over a slope; every placement
   * failed with "no reachable support face". Without a frame, let the body
   * place the chest beside itself (the Java task finds a real support).
   */
  const anchored = facts.shelter !== undefined && facts.shelter !== null;
  if (
    position !== undefined &&
    position !== null &&
    (distanceTo(position, at) > 4 ||
      (anchored && Math.abs(position.y - at.y) > 1))
  ) {
    return (
      gotoHomeTask(stage, facts, newId, {
        anchors: [at],
        title: "回到家里的固定储物位",
      }) ?? blocked(stage, "navigate", "回到家里的固定储物位")
    );
  }
  return {
    id: `task:${newId()}`,
    stage,
    kind: "place",
    title: "把第二个箱子放进家里的储物位",
    skill: skill(
      "place_block",
      anchored
        ? { block: item, count: 1, at }
        : { block: item, count: 1 },
      newId,
    ),
    preconditions: [
      "a chest item is in the inventory",
      "the fixed indoor storage slot is free",
      "a safe support face is within reach",
    ],
    expectedEvidence: ["the chest item count decreases", "the new chest is inside the camp"],
    verify: (next) =>
      inventoryCount(next, item) < inventoryCount(facts, item) &&
      next.chestOpenable !== false &&
      (next.chestEmptySlots === undefined ||
        next.chestEmptySlots === null ||
        next.chestEmptySlots > 0),
  };
}

/**
 * Storage is a cross-stage need. A full backpack during an iron trip is the
 * point where a player walks home and makes a chest; waiting for the shelter
 * stage would mean mining cannot pick up any more ore.
 */
function campChestTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask | null {
  if (isUnderground(facts)) return null;
  const chestNearby = nearbyHas(facts, /(^|:)chest$/u);
  const chestItem = facts.inventory.find((slot) => /(^|:)chest$/u.test(slot.item));
  const anchors = homeAnchors(facts);
  const rememberedCampUnreachable =
    anchors.length > 0 &&
    anchors.every((anchor) => routePointBlacklisted(facts, anchor));
  const chestPlaced =
    facts.chestPlaced === true &&
    !anchorIsUnderground(facts, facts.chest ?? null) &&
    !rememberedCampUnreachable;
  if (chestPlaced || chestNearby !== null) return null;
  if (chestItem !== undefined) {
    if (rememberedCampUnreachable || atCamp(facts)) {
      return placeFieldChestTask(stage, facts, chestItem.item, newId);
    }
    const home = gotoHomeTask(stage, facts, newId);
    if (home !== null) return home;
    return placeFieldChestTask(stage, facts, chestItem.item, newId);
  }
  // Do not turn an empty backpack into a chest project. Once the body is
  // carrying a real load, storage is worth the wood and table time.
  if (usedInventorySlots(facts) < 24) return null;
  const table = ensureTable(facts, stage, newId);
  if (table !== null) return placeOrBuildTable(table, facts, newId, stage);
  const recipe = queryRecipe("minecraft:chest");
  if (recipe === null) return null;
  const missing = missingForRecipe(recipe, facts);
  if (missing.length === 0) return craftTask(recipe, stage, facts, newId);
  const prerequisite = craftWithPrerequisite(recipe, stage, facts, newId, "制作箱子");
  return "skill" in prerequisite ? prerequisite : null;
}

/**
 * A bed is also useful before the shelter stage: if the flock is already
 * dead and the wool is in the backpack, craft and place the bed at home as
 * soon as a table is reachable rather than carrying three wool for hours.
 */
function campBedTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask | null {
  if (isUnderground(facts)) return null;
  const bedPlaced =
    facts.bedPlaced === true && !anchorIsUnderground(facts, facts.bed ?? null);
  if (bedPlaced || nearbyHas(facts, BED_ITEMS) !== null) return null;
  const bedItem = facts.inventory.find((slot) => BED_ITEMS.test(slot.item));
  if (bedItem !== undefined) {
    /*
     * A bed belongs at the main camp, not at a field workbench. `atCamp`
     * accepts any station within eight blocks, so a table placed under a tree
     * made that pocket "home" and the body retried an impossible two-cell
     * placement there. When the chest is known, anchor the bed task to it.
     */
    const position = facts.position;
    const chest = facts.chest;
    const atMainCamp =
      position !== undefined &&
      position !== null &&
      chest !== undefined &&
      chest !== null
        ? distanceTo(position, chest) <= 8
        : atCamp(facts);
    if (!atMainCamp) {
      return (
        gotoHomeTask(
          stage,
          facts,
          newId,
          chest === undefined || chest === null
            ? {}
            : { anchors: [chest], title: "回主营地放置床" },
        ) ?? gotoHomeTask(stage, facts, newId)
      );
    }
    return placeBedTask(stage, facts, bedItem.item, newId);
  }
  const wool = facts.inventory
    .filter((slot) => WOOL_ITEMS.test(slot.item))
    .reduce((total, slot) => total + slot.count, 0);
  if (wool < 3) return null;
  const table = ensureTable(facts, stage, newId);
  if (table !== null) return placeOrBuildTable(table, facts, newId, stage);
  const recipe = queryRecipe("minecraft:white_bed");
  if (recipe === null) return null;
  const missing = missingForRecipe(recipe, facts);
  if (missing.length === 0) return craftTask(recipe, stage, facts, newId);
  const prerequisite = craftWithPrerequisite(recipe, stage, facts, newId, "制作床");
  return "skill" in prerequisite ? prerequisite : null;
}

function iron(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  const nextGearItem = IRON_GEAR_ITEMS.find((item) => !hasIronGear(facts, item));
  const ingots = inventoryCount(facts, "minecraft:iron_ingot");
  const rawIron = inventoryCount(facts, "minecraft:raw_iron");
  /*
   * A smelt that died after loading the furnace leaves the ore (or the
   * finished ingots) inside the block. The backpack alone then looks empty
   * and the planner mines a fresh batch while three ingots sit one block
   * away. Count what the furnace already holds as available metal; the
   * smelt task opens it and collects the output before asking for more.
   */
  const storedIngots =
    facts.furnaceContents?.output === "minecraft:iron_ingot"
      ? facts.furnaceContents.outputCount ?? 0
      : 0;
  const storedRawIron =
    facts.furnaceContents?.input === "minecraft:raw_iron"
      ? facts.furnaceContents.inputCount ?? 0
      : 0;
  const availableIngots = ingots + storedIngots;
  const availableRawIron = rawIron + storedRawIron;
  /** Metal still needed for the next equipment upgrade, not the whole season. */
  const neededMetal = nextGearItem === undefined ? 0 : ingredientCount(nextGearItem, "minecraft:iron_ingot");
  const metalDeficit = Math.max(0, neededMetal - availableIngots - availableRawIron);
  const visibleOre = locatedNearby(facts, /iron_ore$/u);
  const visibleOreTarget =
    visibleOre !== null &&
    // A surveyed ore behind a wall has a location but no face the body can
    // hit. Selecting it produced a repeating "approach made no progress"
    // failure three blocks from the staircase, because no standable cell can
    // interact with it. Only a real line-of-sight ore is a direct target; the
    // rest stay useful as a reason to keep the mining branch advancing.
    visibleOre.visible === true &&
    facts.inWater !== true &&
    blockHasLocation(visibleOre) &&
    withinInteractionReach(facts, visibleOre)
      ? visibleOre
      : null;
  // A visible ore three blocks away is the highest-value action in the iron
  // stage. Walking home to a furnace with one raw iron first produced a long,
  // failing climb while ten iron ores sat inside interaction range.
  if (
    metalDeficit > 0 &&
    visibleOreTarget !== null &&
    hasUsablePickaxe(facts, 2)
  ) {
    return {
      id: `task:${newId()}`,
      stage: "iron",
      kind: "mine",
      title: "先挖眼前 1 块铁矿石",
      skill: skill("mine_block", {
        block: visibleOreTarget.id,
        count: 1,
        ...exactOpportunisticAt(visibleOreTarget, facts),
      }, newId),
      preconditions: [
        "stone pickaxe or better",
        "a visible iron ore is inside the body's search radius",
      ],
      expectedEvidence: ["raw_iron count increases by 1"],
      verify: (next) =>
        inventoryCount(next, "minecraft:raw_iron") > rawIron,
    };
  }
  // A bench placed on top of the furnace blocks the body's view of the
  // furnace's interaction face. The body keeps "approaching" a furnace it
  // can never open. Clearing the bench is the missing step.
  if (benchBlocksFurnace(facts)) {
    return {
      ...reclaimTask("iron", facts, "minecraft:crafting_table", newId),
      title: "收起挡住熔炉口的工作台",
    };
  }
  // When a narrow cave blocks the staircase back to the surface, a player
  // does not keep ramming the ceiling. With enough raw iron in the pack, put
  // down a temporary field furnace, smelt locally, and recycle it on the way
  // out. This is the same equipment-first behavior as a rescue table.
  if (
    !hasStation(facts, "furnace") &&
    deepUnderground(facts) &&
    rawIron > 0 &&
    (neededMetal === 0 || rawIron >= neededMetal)
  ) {
    const field = fieldFurnaceTask("iron", facts, newId);
    if (field !== null) return field;
  }
  if (!hasStation(facts, "furnace")) {
    // A remembered furnace that is out of reach is not an emergency. Mining
    // the raw iron first is valid; walking home before there is anything to
    // smelt turned a broken ravine route into hours of back-and-forth.
    // Only make the trip when the carried metal can actually finish the next
    // tool. One raw iron is not a smelting trip; it is two more ores.
    const rememberedFurnace =
      rawIron > 0 && (neededMetal === 0 || rawIron >= neededMetal)
        ? gotoFurnaceTask("iron", facts, newId)
        : null;
    if (rememberedFurnace !== null) return rememberedFurnace;
    // Do not put the field furnace down while the pack carries partial ore.
    // With no raw iron at all, placing it for charcoal/torch work is still
    // useful and must remain allowed.
    const waitingForMoreOre = rawIron > 0 && metalDeficit > 0;
    const carriedFurnace = hasItem(facts, "minecraft:furnace");
    if (carriedFurnace && !waitingForMoreOre) {
      // Carrying the furnace in a deep cave is not a reason to climb out.
      // Keep it for the next local smelt and continue the mining task.
      if (!deepUnderground(facts)) {
        const camp = gotoCampBeforePlacement("iron", facts, newId);
        if (camp !== null) return camp;
        return {
          id: `task:${newId()}`,
          stage: "iron",
          kind: "place",
          title: "放置熔炉",
          skill: skill("place_block", { block: "minecraft:furnace", count: 1 }, newId),
          preconditions: ["furnace in inventory", "a safe adjacent block face exists"],
          expectedEvidence: ["nearbyBlocks contains furnace"],
          verify: (next) => nearbyHas(next, /furnace$/u) !== null,
        };
      }
    } else if (!carriedFurnace) {
      // The furnace already exists somewhere on the map. Do not spend eight
      // more cobblestone rebuilding it; continue with torches and ore mining,
      // then return with something to smelt.
      const furnaceExistsElsewhere = facts.furnacePlaced === true;
      if (!furnaceExistsElsewhere) {
        return buildFurnace(facts, newId);
      }
    }
  }
  if (inventoryCount(facts, "minecraft:torch") < 4) {
    const coal =
      inventoryCount(facts, "minecraft:coal") +
      inventoryCount(facts, "minecraft:charcoal");
    const torchRecipe = queryRecipe("minecraft:torch");
    if (coal > 0 && torchRecipe !== null) {
      return craftWithPrerequisite(
        torchRecipe,
        "iron",
        facts,
        newId,
        "制作火把",
      );
    }
    const coalOre = locatedNearby(facts, /coal_ore$/u);
    if (coalOre !== null && blockHasLocation(coalOre)) {
      return {
        id: `task:${newId()}`,
        stage: "iron",
        kind: "mine",
        title: "挖煤制作火把",
        skill: skill("mine_block", {
          block: coalOre.id,
          count: 1,
          ...exactOpportunisticAt(coalOre, facts),
        }, newId),
        preconditions: ["stone pickaxe or better", "coal ore nearby"],
        expectedEvidence: ["coal count increases"],
        verify: (next) => inventoryCount(next, "minecraft:coal") > inventoryCount(facts, "minecraft:coal"),
      };
    }
    const log = facts.inventory.find((slot) => WOOD_ITEMS.test(slot.item));
    const fuel = fuelChoice(facts, log?.item, 1);
    if (log !== undefined && fuel !== null && hasStation(facts, "furnace")) {
      const furnaceTrip = gotoFurnaceTask("iron", facts, newId);
      if (furnaceTrip !== null) return furnaceTrip;
      return smeltTask(
        "iron",
        log.item,
        "minecraft:charcoal",
        1,
        fuel,
        facts,
        newId,
      );
    }
    return miningLayerTask(
      "iron",
      facts,
      newId,
      shallowMiningTarget(facts),
      8,
      "就近开挖矿道寻找煤炭",
    );
  }
  /**
   * A player upgrades the pickaxe as soon as three ingots exist; waiting for
   * the sword's two extra ingots made the body keep branch-mining while four
   * usable raw iron sat in the backpack. Each tool is therefore its own gate.
   */
  const toolPlan = (neededIngots: number): Task | BlockedTask | null => {
    const missingMetal = Math.max(0, neededIngots - availableIngots - availableRawIron);
    if (missingMetal > 0) {
      if (visibleOreTarget === null) {
        return miningLayerTask(
          "iron",
          facts,
          newId,
          16,
          12,
          "开挖矿道寻找铁矿石",
        );
      }
      return {
        id: `task:${newId()}`,
        stage: "iron",
        kind: "mine",
        title: "挖 1 块铁矿石",
        skill: skill("mine_block", {
          block: visibleOreTarget.id,
          count: 1,
          ...exactOpportunisticAt(visibleOreTarget, facts),
        }, newId),
        preconditions: ["stone pickaxe or better", "iron ore nearby"],
        expectedEvidence: ["raw_iron count increases by 1"],
        verify: (next) =>
          inventoryCount(next, "minecraft:raw_iron") >= rawIron + missingMetal,
      };
    }
    if (ingots < neededIngots) {
      const recipe = smeltingFor("minecraft:iron_ingot").find(
        (entry) => entry.station === "furnace",
      );
      if (recipe === undefined) return blocked("iron", "smelt", "熔炼铁锭");
      const fuel = fuelChoice(facts);
      if (fuel === null) {
        return explore(facts, "iron", "寻找熔炉燃料", "燃料", 1, newId);
      }
      const furnaceTrip = gotoFurnaceTask("iron", facts, newId);
      if (furnaceTrip !== null) return furnaceTrip;
      const batch = Math.max(
        1,
        Math.min(
          neededIngots - ingots,
          availableRawIron + storedIngots,
        ),
      );
      return smeltTask(
        "iron",
        "minecraft:raw_iron",
        "minecraft:iron_ingot",
        batch,
        fuel,
        facts,
        newId,
      );
    }
    return null;
  };
  if (nextGearItem === undefined) return null;
  const preparation = toolPlan(neededMetal);
  if (preparation !== null) return preparation;
  const table = fieldTableTask("iron", facts, newId) ?? ensureTable(facts, "iron", newId);
  if (table !== null) return table;
  const recipe = queryRecipe(nextGearItem);
  const title = `制作${gearLabel(nextGearItem)}`;
  if (recipe === null) return blocked("iron", "craft", title);
  const missing = missingForRecipe(recipe, facts);
  return missing.length === 0
    ? craftTask(recipe, "iron", facts, newId)
    : craftWithPrerequisite(recipe, "iron", facts, newId, title);
}

/**
 * The diamond tier is a separate long-running stage rather than a side effect
 * of portal preparation. It keeps one equipment objective in flight, mines at
 * the 1.20.1 diamond layer when the pack is short, and only then crafts.
 */
function diamondGear(
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask | null {
  const nextItem = DIAMOND_GEAR_ITEMS.find(
    (item) => !hasItem(facts, item),
  );
  if (nextItem === undefined) return null;
  if (!hasUsablePickaxe(facts, 3)) {
    return blockedWith("diamond-gear", "mine", `准备制作${gearLabel(nextItem)}`, [
      {
        kind: "tool",
        item: "minecraft:iron_pickaxe",
        detail: "钻石层需要铁镐或更好的镐",
      },
    ]);
  }
  const recipe = queryRecipe(nextItem);
  if (recipe === null) {
    return blocked("diamond-gear", "craft", `制作${gearLabel(nextItem)}`);
  }
  const missing = missingForRecipe(recipe, facts);
  const diamondDeficit = missing.find(
    (entry) => entry.item === "minecraft:diamond",
  )?.count ?? 0;
  if (diamondDeficit > 0) {
    const diamondOre = locatedNearby(facts, /diamond_ore$/u);
    if (diamondOre !== null && blockHasLocation(diamondOre)) {
      return {
        id: `task:${newId()}`,
        stage: "diamond-gear",
        kind: "mine",
        title: `挖 ${diamondDeficit} 块钻石矿石`,
        skill: skill("mine_block", {
          block: diamondOre.id,
          count: diamondDeficit,
          ...exactOpportunisticAt(diamondOre, facts),
        }, newId),
        preconditions: ["iron pickaxe or better", "diamond ore nearby"],
        expectedEvidence: [`diamond count increases by ${diamondDeficit}`],
        verify: (next) =>
          inventoryCount(next, "minecraft:diamond") >=
            inventoryCount(facts, "minecraft:diamond") + diamondDeficit,
      };
    }
    return miningLayerTask(
      "diamond-gear",
      facts,
      newId,
      -53,
      16,
      `下潜到钻石层采集${gearLabel(nextItem)}所需钻石`,
    );
  }
  const table = fieldTableTask("diamond-gear", facts, newId) ??
    ensureTable(facts, "diamond-gear", newId);
  if (table !== null) return table;
  const currentMissing = missingForRecipe(recipe, facts);
  const title = `制作${gearLabel(nextItem)}`;
  return currentMissing.length === 0
    ? craftTask(recipe, "diamond-gear", facts, newId)
    : craftWithPrerequisite(recipe, "diamond-gear", facts, newId, title);
}

function hasIronGear(
  facts: WorldFacts,
  item: (typeof IRON_GEAR_ITEMS)[number],
): boolean {
  if (item === "minecraft:iron_pickaxe") return hasUsablePickaxe(facts, 3);
  if (item === "minecraft:iron_sword") return hasSword(facts, 3);
  return hasItem(facts, item);
}

function hasSword(facts: WorldFacts, minimumTier: number): boolean {
  const ranks: Readonly<Record<string, number>> = {
    iron: 3,
    diamond: 4,
    netherite: 5,
  };
  return facts.inventory.some((slot) => {
    if (slot.durability === 0) return false;
    const match = /^minecraft:([a-z]+)_sword$/u.exec(slot.item);
    return match !== null && (ranks[match[1] ?? ""] ?? 0) >= minimumTier;
  });
}

function ingredientCount(item: string, ingredient: string): number {
  const recipe = queryRecipe(item);
  return recipe?.ingredients
    .filter((entry) => entry.choices.includes(ingredient))
    .reduce((total, entry) => total + entry.count, 0) ?? 0;
}

function gearLabel(item: string): string {
  const match = /^minecraft:(iron|diamond)_(pickaxe|sword|helmet|chestplate|leggings|boots)$/u.exec(item);
  if (match === null) return shortName(item);
  const material = match[1] === "iron" ? "铁" : "钻石";
  const piece: Readonly<Record<string, string>> = {
    pickaxe: "镐",
    sword: "剑",
    helmet: "头盔",
    chestplate: "胸甲",
    leggings: "护腿",
    boots: "靴子",
  };
  return `${material}${piece[match[2] ?? ""] ?? shortName(item)}`;
}

/** Crafts or mines the eight cobblestone for this run's first furnace. */
function buildFurnace(
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask | null {
  const table = ensureTable(facts, "iron", newId);
  if (table !== null) return table;
  const recipe = queryRecipe("minecraft:furnace");
  if (recipe === null) return blocked("iron", "craft", "制作熔炉");
  const missing = missingForRecipe(recipe, facts);
  if (missing.length === 0) return craftTask(recipe, "iron", facts, newId);
  const prerequisite = craftWithPrerequisite(recipe, "iron", facts, newId, "制作熔炉");
  if ("skill" in prerequisite) return prerequisite;
  const cobblestoneMissing = recipe.ingredients
    .filter((ingredient) => ingredient.choices.includes("minecraft:cobblestone"))
    .reduce(
      (total, ingredient) =>
        total +
        Math.max(
          0,
          ingredient.count -
            ingredient.choices.reduce(
              (available, choice) => available + inventoryCount(facts, choice),
              0,
            ),
        ),
      0,
    );
  if (cobblestoneMissing > 0) {
    // Eight furnace cobblestone are not a reason to dig a staircase. On
    // the surface, the nearby stone face is the human source; only go
    // underground when no stone is exposed around the body.
    const nearbyStone = locatedNearby(facts, /^minecraft:(stone|cobblestone)$/u);
    const nearSurface =
      (facts.position?.y ?? -Infinity) >= (facts.surfaceY ?? Infinity) - 4;
    if (nearbyStone !== null && blockHasLocation(nearbyStone) && nearSurface) {
      return {
        id: `task:${newId()}`,
        stage: "iron",
        kind: "mine",
        title: `在地表挖 ${cobblestoneMissing} 块圆石`,
        skill: skill("mine_block", {
          block: nearbyStone.id,
          count: cobblestoneMissing,
          ...exactOpportunisticAt(nearbyStone, facts),
        }, newId),
        preconditions: ["stone pickaxe or better", "surface stone nearby"],
        expectedEvidence: [`cobblestone count reaches ${cobblestoneMissing}`],
        verify: (next) =>
          inventoryCount(next, "minecraft:cobblestone") >=
            inventoryCount(facts, "minecraft:cobblestone") + cobblestoneMissing,
      };
    }
    // A furnace needs eight cobblestone. Surface exploration cannot create
    // stone, and the body already carries a pickaxe by this stage, so go
    // down and mine it. The staircase also exposes coal and iron for the
    // following milestones instead of wandering across the same clearing.
    return miningLayerTask(
      "iron",
      facts,
      newId,
      shallowMiningTarget(facts),
      8,
      `就近下矿采集 ${cobblestoneMissing} 块圆石`,
    );
  }
  return missing.some((entry) => entry.kind === "station")
    ? prerequisite
    : explore(facts, "iron", "寻找熔炉材料", "圆石", 8, newId);
}

function smeltTask(
  stage: GoalId,
  input: string,
  output: string,
  count: number,
  fuel: string,
  facts: WorldFacts,
  newId: () => string,
): Task {
  return {
    id: `task:${newId()}`,
    stage,
    kind: "smelt",
    title: `熔炼 ${shortName(output)} ×${count}`,
    skill: skill("smelt", { input, output, count, fuel }, newId),
    preconditions: ["furnace in reach", `${fuel} as fuel`, `${input} in inventory`],
    expectedEvidence: [`${output} count increases by ${count}`],
    verify: (next) =>
      inventoryCount(next, output) >= inventoryCount(facts, output) + count,
  };
}

function fuelChoice(
  facts: WorldFacts,
  reservedItem?: string,
  reservedCount = 0,
): string | null {
  const preferred = [
    "minecraft:coal",
    "minecraft:charcoal",
    "minecraft:coal_block",
    "minecraft:blaze_rod",
    "minecraft:dried_kelp_block",
    "minecraft:oak_planks",
    "minecraft:oak_log",
    "minecraft:stick",
  ];
  for (const item of preferred) {
    const reserved = item === reservedItem ? reservedCount : 0;
    if (item === "minecraft:oak_planks") {
      // Any plank burns in a furnace. Returning the literal oak id while the
      // body carried birch planks made the smelt task fail its precondition
      // with "no minecraft:oak_planks", even though a valid fuel stack was
      // sitting in the backpack.
      const planks = facts.inventory.find(
        (slot) =>
          PLANK_ITEMS.test(slot.item) &&
          slot.count > (slot.item === reservedItem ? reservedCount : 0),
      );
      if (planks !== undefined) return planks.item;
      continue;
    }
    if (inventoryCount(facts, item) > reserved) return item;
  }
  const found = facts.inventory.find(
    (slot) =>
      FURNACE_FUEL_ITEMS.test(slot.item) &&
      inventoryCount(facts, slot.item) > (slot.item === reservedItem ? reservedCount : 0),
  );
  return found?.item ?? null;
}

/**
 * A surface sweep cannot expose buried coal, iron or diamonds. Once the body
 * has a pickaxe, the reliable move is a safe staircase to the right layer and
 * a short branch tunnel there; the next snapshot then sees the fresh faces.
 */
function shallowMiningTarget(facts: WorldFacts): number {
  const current = facts.position?.y ?? 64;
  const surface = facts.surfaceY ?? current;
  if (current < surface - 12) return Math.max(0, Math.round(current) - 8);
  return Math.max(32, Math.round(surface) - 16);
}

export function miningLayerTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
  targetY: number,
  branchLength: number,
  title: string,
): Task | BlockedTask {
  const surface = facts.surfaceY ?? facts.position?.y ?? targetY;
  const depth = Math.max(0, surface - targetY);
  const tier = pickaxeTier(facts);
  if (!hasUsablePickaxe(facts)) {
    return blockedWith(stage, "mine", title, [
      { kind: "tool", item: "minecraft:stone_pickaxe", detail: "没有可用镐子，不能下矿" },
    ]);
  }
  // A wooden pickaxe cannot survive a real staircase and cannot mine iron;
  // sending it down was the "one wooden pickaxe and a dream" failure.
  if (depth > 8 && tier < 2) {
    return blockedWith(stage, "mine", title, [
      { kind: "tool", item: "minecraft:stone_pickaxe", detail: `下潜 ${Math.round(depth)} 格需要石镐或更好` },
    ]);
  }
  // Diamond ore needs an iron pickaxe in 1.20.1. A stone pickaxe can reach
  // the deepslate layer but cannot harvest what it went there for.
  if (targetY < 0 && tier < 3) {
    return blockedWith(stage, "mine", title, [
      { kind: "tool", item: "minecraft:iron_pickaxe", detail: "钻石层需要铁镐才能获得掉落" },
    ]);
  }
  const spare = sparePickaxeTask(stage, facts, newId);
  if (spare !== null) return spare;
  // Every descent must start from the same surface cell. Starting where the
  // body happens to stand is what cut a new staircase beside the camp on
  // every trip; the old one was still open and perfectly reusable.
  const entrance = facts.mineEntrance;
  if (
    (entrance === undefined || entrance === null) &&
    !isUnderground(facts) &&
    facts.position !== undefined &&
    facts.position !== null
  ) {
    const camp = homeAnchor(facts);
    if (camp !== null && distanceTo(facts.position, camp) > 16) {
      return (
        gotoHomeTask(stage, facts, newId, {
          anchors: [camp],
          title: "先回营地固定矿道入口",
        }) ??
        blockedWith(stage, "mine", title, [
          { kind: "safety", detail: "首个矿道入口必须建在营地附近" },
        ])
      );
    }
  }
  // Travel can use any pickaxe the body carries; the tier gate above only
  // decides whether the destination's drops are harvestable.
  const uses = pickaxeUses(facts, 1);
  // The staircase is the return route; only the descent and branch cut
  // consume durability. Reserving a second full descent stranded perfectly
  // usable stone pickaxes at the surface.
  // One stair step consumes at least one block that is not already open, and
  // each branch cell consumes up to two. Count only the layers still below
  // the body, not the whole depth from the surface, or a body already at y=20
  // is asked for a full trip's worth of durability to dig four more blocks.
  // The return leg is a walk back up the same staircase, so the reserve does
  // not need to pay for a second descent.
  const currentY = facts.position?.y ?? surface;
  const remainingDepth = Math.max(0, Math.round(currentY - targetY));
  const neededUses = Math.max(12, remainingDepth + branchLength * 2 + 8);
  if (uses !== null && uses < 24 && uses < neededUses) {
    // A worn pickaxe is not a reason to stop the run when the body already
    // carries cobblestone, sticks and a table. Players make a fresh pickaxe
    // before a long descent instead of declaring the mine blocked.
    const replacement = replacementPickaxeTask(stage, facts, newId);
    if (replacement !== null) return replacement;
    return blockedWith(stage, "mine", title, [
      {
        kind: "tool",
        item: "minecraft:stone_pickaxe",
        detail: `预计需要 ${neededUses} 次挖掘，当前镐子只剩 ${uses} 次`,
      },
    ]);
  }
  // A stone pickaxe cannot cut all the way from the surface to the diamond
  // layer in one trip. Plan a safe segment instead of refusing the whole
  // descent; the next observation can continue, replace the tool, or branch
  // from the new depth. This is the same short-trip behaviour as a player.
  const safeDepth = uses === null ? remainingDepth : Math.max(0, uses - 8);
  if (
    uses !== null &&
    remainingDepth > 0 &&
    safeDepth < Math.min(12, remainingDepth)
  ) {
    const replacement = replacementPickaxeTask(stage, facts, newId);
    if (replacement !== null) return replacement;
    return blockedWith(stage, "mine", title, [
      {
        kind: "tool",
        item: "minecraft:stone_pickaxe",
        detail: `当前镐子只剩 ${uses} 次，无法安全挖下一段矿道`,
      },
    ]);
  }
  const reachesTarget = uses === null || remainingDepth <= safeDepth;
  const plannedTargetY = reachesTarget
    ? targetY
    : Math.max(targetY, Math.round(currentY - safeDepth));
  const remainingUses =
    uses === null
      ? Number.POSITIVE_INFINITY
      : uses - Math.min(remainingDepth, safeDepth) - 8;
  const plannedBranchLength = reachesTarget
    ? Math.min(branchLength, Math.max(0, Math.floor(remainingUses / 2)))
    : 0;
  /*
   * Tool replacement has to beat the walk back to the entrance. The live run
   * reached its remembered table with a nearly spent pickaxe, but this
   * entrance leg fired first and sent it straight back to the mine; at the
   * entrance the same check sent it to the table again. The two locations
   * ping-ponged for minutes without ever crafting the replacement.
   */
  if (
    entrance !== undefined &&
    entrance !== null &&
    !isUnderground(facts) &&
    facts.position !== undefined &&
    facts.position !== null &&
    /*
     * `isUnderground` can be fooled by a stale or canopy-inflated surface
     * reading. A body nineteen blocks below the entrance, under solid stone,
     * is not a surface body that should walk back up. This guard stopped the
     * live stair run from climbing to the entrance after every few steps.
     */
    !(facts.canSeeSky !== true && facts.position.y < entrance.y - 12) &&
    /*
     * An open staircase lets a body near its mouth see the sky eight blocks
     * down, so `isUnderground` is false even though the blueprint already
     * names a stand far below. Walking back to the entrance there made the
     * live body climb and descend the same intact stair forever. At the
     * shaft mouth the mine task owns the descent.
     */
    !(
      facts.mine?.stair !== undefined &&
      facts.mine?.stair !== null &&
      facts.mine.stair.stand.y < facts.position.y - 2 &&
      distanceTo(facts.position, entrance) <= 12
    ) &&
    /*
     * A body one step down the staircase is farther than three blocks from
     * the surface entrance by design. Sending it back "to the entrance" here
     * made every descent restart at the top; the stair-stand check below
     * handles that case. Comparing absolute Y against a distant entrance
     * instead stranded a body that woke on lower ground: it was neither at
     * the entrance nor allowed to start a new shaft, so the mine plan blocked
     * forever. Any surface body away from the remembered entrance walks back.
     */
    !nearMineStair(facts) &&
    distanceTo(facts.position, entrance) > 3
  ) {
    return gotoMineEntranceTask(stage, facts, entrance, newId);
  }
  if (depth > 24 && inventoryCount(facts, "minecraft:torch") < 4) {
    return blockedWith(stage, "mine", title, [
      { kind: "material", item: "minecraft:torch", count: 4, detail: "深层矿道至少需要 4 支火把" },
    ]);
  }
  /*
   * Torches were only ever crafted, never placed. The staircase therefore
   * stayed at light 0, mobs spawned on every landing and the live run died
   * at y=20 after a five-minute descent. `lightLevel` is already reported by
   * the body; a player lights the tunnel every few blocks, so do the same.
   */
  const light = facts.lightLevel;
  if (
    light !== undefined &&
    light !== null &&
    light <= 3 &&
    isUnderground(facts) &&
    inventoryCount(facts, "minecraft:torch") > 0
  ) {
    return {
      id: `task:${newId()}`,
      stage,
      kind: "place",
      title: "点亮矿道",
      skill: skill("place_block", { block: "minecraft:torch", count: 1 }, newId),
      preconditions: ["the tunnel has no local light", "a torch is in the backpack"],
      expectedEvidence: ["a torch is placed", "the local light level rises"],
      verify: (next) =>
        next.lightLevel !== undefined &&
        next.lightLevel !== null &&
        next.lightLevel > light,
    };
  }
  if ((facts.food ?? 20) < 8) {
    return blockedWith(stage, "mine", title, [
      { kind: "safety", detail: "饥饿值过低，先补充食物再下矿" },
    ]);
  }
  if (!hasTripCapacity(stage, facts)) {
    return blockedWith(stage, "mine", title, [
      { kind: "safety", detail: "背包已满，先回营地存放再下矿" },
    ]);
  }
  const y = facts.position?.y;
  const descending =
    y === undefined || y === null || y > plannedTargetY + 1;
  // At the target layer the descend skill's branch cut can refuse a tight
  // cave ("no safe mining direction") even when a plain stone face is within
  // reach. Mining that exact reachable face is the simple human move and lets
  // the next cycle re-evaluate the new opening.
  const reachable = facts.reachableBlock;
  /*
   * An `openStairEnd` blueprint has a stand but no pending cell: the next
   * landing is a drop, water or lava. The old plan then fell through to
   * "return to the surface" even though the body was standing at the bottom
   * of a perfectly open shaft. A player starts a side branch there, so mine
   * the reachable face instead of climbing sixty blocks and coming back.
   */
  const stairDeadEnd =
    facts.mine?.stair !== undefined && facts.mine.stair.pending === undefined;
  /*
   * A body deep below a stale, shallow stair blueprint can lose its branch
   * blueprint for a single frame (the next cell is water, a drop or a solid
   * landing floor). Falling through to `returnToSurfaceTask` then made the
   * live y=44 body climb thirty blocks, lose its mine, and walk home. When the
   * branch is momentarily missing but a rock face is within reach, keep
   * cutting forward at the current depth; the next snapshot can resume the
   * real branch.
   */
  const stairAboveBody =
    isUnderground(facts) &&
    facts.mine?.stair !== undefined &&
    y !== undefined &&
    y !== null &&
    y < facts.mine.stair.stand.y - 2;
  const branchless = stairAboveBody && facts.mine?.branch === undefined;
  if (
    (!descending || stairDeadEnd || branchless) &&
    plannedBranchLength > 0 &&
    reachable !== undefined &&
    reachable !== null &&
    y !== undefined &&
    y !== null &&
    Math.abs(reachable.y - Math.round(y)) <= 1 &&
    /(^|:)(stone|andesite|diorite|granite|deepslate|tuff|calcite|[a-z_]+_ore)$/u.test(
      reachable.id,
    )
  ) {
    return {
      id: `task:${newId()}`,
      stage,
      kind: "mine",
      title: stairDeadEnd
        ? "在矿道尽头向侧面开掘"
        : branchless
          ? "矿梯在上方，就地向前掘进"
          : "顺着面前岩面挖开矿道",
      // The snapshot named one exact tunnel cell. Omitting `at` let the body
      // rescan and mine a different block of the same type, so the opening
      // drifted and the planner kept re-deciding the same face. Exact cells
      // now use the same one-block contract as the reusable stair.
      skill: skill("mine_block", {
        block: reachable.id,
        count: 1,
        at: { x: reachable.x, y: reachable.y, z: reachable.z },
      }, newId),
      preconditions: ["a pickaxe can harvest the reachable face", "the face is on the body's floor"],
      expectedEvidence: ["the face becomes air", "a new tunnel cell is walkable"],
      verify: (next) =>
        next.reachableBlock === undefined ||
        next.reachableBlock === null ||
        next.reachableBlock.id !== reachable.id ||
        next.reachableBlock.x !== reachable.x ||
        next.reachableBlock.y !== reachable.y ||
        next.reachableBlock.z !== reachable.z,
    };
  }
  const step = mineStepTask(
    stage,
    facts,
    plannedTargetY,
    plannedTargetY === targetY
      ? title
      : `${title}（本轮先到 y=${plannedTargetY}）`,
    newId,
    true,
  );
  if (step !== null) return step;
  /*
   * A body in a cave with no usable shaft is not out of options. Blocking
   * there left the goal idle after a night's sleep: it was too deep for the
   * surface-entrance branch and had no stair snapshot to continue. Climb the
   * current column back to daylight, then let the next plan walk to the
   * remembered entrance.
   */
  if (isUnderground(facts)) {
    const surface = returnToSurfaceTask(stage, facts, newId);
    if (surface !== null) return surface;
  }
  /*
   * A surface body with no usable stair blueprint is not out of work. The
   * bridge rebuilds a mine entrance asynchronously, and a single snapshot
   * without one used to block the whole stage with no task: the run idled on
   * the surface forever while the entrance-loop bug rebuilt and rejected the
   * same site. Sweep nearby ground for an exposed ore or cave mouth in the
   * meantime; the next snapshot can resume the fixed entrance if it returns.
   */
  if (!isUnderground(facts)) {
    return explore(
      facts,
      stage,
      "附近寻找矿脉或洞穴",
      "矿脉",
      1,
      newId,
      /*
       * Keep the sweep local. A wide fallback leg walked the body another
       * twenty blocks from camp, which put it outside the mine-site radius
       * and made the next plan walk home again: an explore/home ping-pong
       * while the bridge was rebuilding the entrance.
       */
      6,
      10,
      true,
    );
  }
  return blockedWith(stage, "mine", title, [
    {
      kind: "safety",
      detail: "没有找到可安全踏入的复用矿道下一格；先清理入口或换一块平地",
    },
  ]);
}

function gotoMineEntranceTask(
  stage: GoalId,
  facts: WorldFacts,
  entrance: { readonly x: number; readonly y: number; readonly z: number },
  newId: () => string,
): Task {
  const position = facts.position;
  // A remembered entrance inside the walk budget is a normal destination,
  // not a camp transfer. Delegating to gotoHomeTask here ranked the cells
  // *beside* the entrance and made the body stand one block off the shaft,
  // then re-plan forever. Only long approaches need segmented legs.
  if (
    position !== undefined &&
    position !== null &&
    distanceTo(position, entrance) > PARTIAL_TRANSFER_DISTANCE
  ) {
    const transfer = gotoHomeTask(stage, facts, newId, {
      anchors: [entrance],
      title: "前往固定矿道入口",
    });
    if (transfer !== null) return transfer;
  }
  return {
    id: `task:${newId()}`,
    stage,
    kind: "navigate",
    title: "前往固定矿道入口",
    skill: skill("goto", {
      target: entrance,
      candidates: [entrance, { x: entrance.x, y: entrance.y + 1, z: entrance.z }],
      acceptPartial: transferAcceptsPartial(facts, entrance),
      /*
       * The camp's own old shaft, hut and chest platform can cut the straight
       * line to a new entrance. A plain walk then reports "no natural route"
       * even though the entrance is seven blocks away. Recovery may bridge
       * the pit or clear one blocking face, which is what a player does.
       */
      mode: "recover",
    }, newId),
    preconditions: ["the body remembers its reusable mine entrance", "a safe surface route exists"],
    expectedEvidence: ["the body reaches the fixed mine entrance"],
    verify: (next) =>
      next.position === undefined ||
      next.position === null ||
      distanceTo(next.position, entrance) <= 3,
  };
}

function nether(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  if (!hasUsablePickaxe(facts, 4)) {
    const table = ensureTable(facts, "nether", newId);
    if (table !== null) return table;
    const recipe = queryRecipe("minecraft:diamond_pickaxe");
    if (recipe === null) return blocked("nether", "craft", "制作钻石镐");
    const missing = missingForRecipe(recipe, facts);
    if (missing.length === 0) return craftTask(recipe, "nether", facts, newId);
    const prerequisite = craftWithPrerequisite(recipe, "nether", facts, newId, "制作钻石镐");
    if ("skill" in prerequisite) return prerequisite;
    const diamond = missing.find((entry) => /diamond$/u.test(entry.item ?? ""));
    if (diamond === undefined) return prerequisite;
    const diamondOre = locatedNearby(facts, /diamond_ore$/u);
    if (diamondOre !== null && blockHasLocation(diamondOre)) {
      return {
        id: `task:${newId()}`,
        stage: "nether",
        kind: "mine",
        title: "挖 3 块钻石矿石",
        skill: skill("mine_block", {
          block: diamondOre.id,
          count: 3,
          ...exactOpportunisticAt(diamondOre, facts),
        }, newId),
        preconditions: ["iron pickaxe or better", "diamond ore nearby"],
        expectedEvidence: ["diamond count reaches 3"],
        verify: (next) => inventoryCount(next, "minecraft:diamond") >= 3,
      };
    }
    return miningLayerTask(
      "nether",
      facts,
      newId,
      // 1.20.1 diamond distribution peaks in the deepslate layer around
      // y=-59..-53. The old y=11 target was a pre-1.18 habit and spends much
      // longer branch-mining for the same three diamonds.
      -53,
      16,
      "下潜到钻石层并开挖矿道",
    );
  }
  if (inventoryCount(facts, "minecraft:obsidian") < 10) {
    const obsidian = locatedNearby(facts, /obsidian$/u) ?? nearbyHas(facts, /obsidian$/u);
    if (obsidian === null) {
      return explore(facts, "nether", "寻找黑曜石", "黑曜石", 10, newId);
    }
    return {
      id: `task:${newId()}`,
      stage: "nether",
      kind: "mine",
      title: "挖 10 块黑曜石",
      skill: skill("mine_block", {
        block: "minecraft:obsidian",
        count: 10,
        ...exactOpportunisticAt(obsidian, facts),
      }, newId),
      preconditions: ["diamond pickaxe equipped", "obsidian nearby"],
      expectedEvidence: ["obsidian count reaches 10"],
      verify: (next) => inventoryCount(next, "minecraft:obsidian") >= 10,
    };
  }
  if (dimension(facts) !== "nether" && !hasStation(facts, "portal")) {
    return {
      id: `task:${newId()}`,
      stage: "nether",
      kind: "place",
      title: "建造并点燃下界传送门",
      skill: skill("place_block", { block: "minecraft:obsidian", count: 10 }, newId),
      preconditions: ["10 obsidian", "flint and steel", "safe 4x5 frame location"],
      expectedEvidence: ["nearbyBlocks contains nether_portal"],
      verify: (next) => hasStation(next, "portal"),
    };
  }
  if (dimension(facts) !== "nether") {
    return {
      id: `task:${newId()}`,
      stage: "nether",
      kind: "navigate",
      title: "进入下界",
      skill: skill("use_block", { block: "minecraft:nether_portal" }, newId),
      preconditions: ["portal is in reach"],
      expectedEvidence: ["world dimension becomes the nether"],
      verify: (next) => dimension(next) === "nether",
    };
  }
  if (inventoryCount(facts, "minecraft:blaze_rod") < 6) {
    const blaze = nearestEntity(facts, /blaze$/u, 32);
    if (blaze === null) {
      return blockedWith("nether", "combat", "寻找烈焰人", [
        { kind: "resource", detail: "附近没有烈焰人；需要寻找下界要塞" },
      ]);
    }
    return {
      id: `task:${newId()}`,
      stage: "nether",
      kind: "combat",
      title: "击杀烈焰人并收集 6 根烈焰棒",
      skill: skill("attack", { target: "minecraft:blaze" }, newId),
      preconditions: ["blaze within 32 blocks", "safe footing"],
      expectedEvidence: ["blaze_rod count increases toward 6"],
      verify: (next) => inventoryCount(next, "minecraft:blaze_rod") >= 6,
    };
  }
  return null;
}

function eyes(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  if (inventoryCount(facts, "minecraft:ender_eye") >= 12) return null;
  if (inventoryCount(facts, "minecraft:blaze_powder") < 12) {
    const recipe = queryRecipe("minecraft:blaze_powder");
    if (recipe === null) return blocked("eyes", "craft", "制作烈焰粉");
    const missing = missingForRecipe(recipe, facts);
    if (missing.length === 0) return craftTask(recipe, "eyes", facts, newId, 12);
    const blazeRod = missing.find((entry) => /blaze_rod$/u.test(entry.item ?? ""));
    if (blazeRod !== undefined) {
      return explore(facts, "eyes", "寻找烈焰人", "烈焰棒", 12, newId);
    }
    return blockedWith("eyes", "craft", "制作烈焰粉", missing);
  }
  if (inventoryCount(facts, "minecraft:ender_pearl") < 12) {
    const enderman = nearestEntity(facts, /enderman$/u, 32);
    if (enderman === null) {
      return explore(facts, "eyes", "寻找末影人", "末影珍珠", 12, newId);
    }
    return {
      id: `task:${newId()}`,
      stage: "eyes",
      kind: "combat",
      title: "击杀末影人收集末影珍珠",
      skill: skill("attack", { target: "minecraft:enderman" }, newId),
      preconditions: ["enderman within 32 blocks", "safe retreat path"],
      expectedEvidence: ["ender_pearl count increases"],
      verify: (next) => inventoryCount(next, "minecraft:ender_pearl") > inventoryCount(facts, "minecraft:ender_pearl"),
    };
  }
  const recipe = queryRecipe("minecraft:ender_eye");
  if (recipe === null) return blocked("eyes", "craft", "制作末影之眼");
  const missing = missingForRecipe(recipe, facts);
  return missing.length === 0
    ? craftTask(recipe, "eyes", facts, newId, 12)
    : blockedWith("eyes", "craft", "制作末影之眼", missing);
}

function stronghold(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  if (nearbyHas(facts, /end_portal_frame$/u) !== null) return null;
  if (!hasItem(facts, "minecraft:ender_eye")) {
    return blockedWith("stronghold", "interact", "使用末影之眼定位要塞", [
      { kind: "material", item: "minecraft:ender_eye", count: 12, detail: "背包没有末影之眼" },
    ]);
  }
  return {
    id: `task:${newId()}`,
    stage: "stronghold",
    kind: "navigate",
    title: "投掷末影之眼定位要塞",
    skill: skill("use_block", { block: "minecraft:ender_eye" }, newId),
    preconditions: ["ender_eye in inventory", "outdoor open sky"],
    expectedEvidence: ["eye flight direction recorded", "stronghold coordinates reached"],
    verify: (next) => nearbyHas(next, /end_portal_frame$/u) !== null,
  };
}

function dragon(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  if (facts.dragonDefeated === true) return null;
  if (dimension(facts) !== "end") {
    return {
      id: `task:${newId()}`,
      stage: "dragon",
      kind: "interact",
      title: "进入末地传送门",
      skill: skill("use_block", { block: "minecraft:end_portal" }, newId),
      preconditions: ["all 12 end portal frames filled", "portal in reach"],
      expectedEvidence: ["dimension becomes end"],
      verify: (next) => dimension(next) === "end",
    };
  }
  if (!facts.entities?.some((entity) => /dragon/iu.test(entity.type))) {
    return explore(facts, "dragon", "在末地寻找末影龙", "末影龙", 1, newId);
  }
  return {
    id: `task:${newId()}`,
    stage: "dragon",
    kind: "combat",
    title: "摧毁末影水晶并攻击末影龙",
    skill: skill("attack", { target: "minecraft:ender_dragon" }, newId),
    preconditions: ["in the end", "dragon within engagement range", "crystals or bow available"],
    expectedEvidence: ["dragon health reaches zero", "dragon death event"],
    verify: (next) =>
      next.dragonDefeated === true ||
      !next.entities?.some((entity) => /dragon/iu.test(entity.type)),
  };
}

function blocked(stage: GoalId, kind: TaskKind, title: string): BlockedTask {
  return { stage, kind, title, missing: [] };
}

/**
 * No target is visible from the current position. Issue a bounded walk to a
 * different nearby area instead of declaring the stage blocked: entity and
 * block snapshots are local, so "not nearby" is not "does not exist". The
 * direction is derived from the body's position and the missing resource, so
 * a replan after the walk searches a different sector without depending on
 * hidden randomness.
 */
export function explore(
  facts: WorldFacts,
  stage: GoalId,
  title: string,
  resource: string,
  count: number,
  newId: () => string,
  minRadius = 8,
  maxRadius = 16,
  steady = false,
  headingOffset = 0,
): Task {
  const origin = facts.position ?? { x: 0, y: 64, z: 0 };
  let hash = 0;
  for (const character of `${stage}:${resource}`) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  // A wedged body that cannot move keeps the same position, so a heading
  // derived from position alone re-issues byte-identical destinations forever:
  // the same strategy key fails again after every backoff. In-game time keeps
  // advancing while the body is stuck, so rotate the sweep slowly with it.
  // Planning stays pure: identical facts still produce an identical task, and
  // therefore an identical idempotency key.
  const clock = Math.floor((facts.timeOfDay ?? 0) / 1_000);
  // Stay inside the body's bounded path budget. Long headings in broken
  // terrain exhaust the A* node budget and produce only a partial route, so
  // the agent never moves and retries the same unreachable destination. A
  // short repeated sweep still changes the observation area every step. Offer
  // eight headings because a single destination may be water, a cliff, or a
  // wall; the body chooses the first one with a complete safe route.
  const steps = Math.max(1, Math.trunc((maxRadius - minRadius) / 4) + 1);
  // A resource sweep may re-randomise its heading from the current cell, but
  // a hunt for a mob that is not in sight needs to actually travel. Mixing
  // the position into the angle turned every 30-block leg in a different
  // direction, so the body random-walked inside a small clearing for minutes.
  const drift = steady ? 0 : Math.trunc(origin.x) + Math.trunc(origin.z);
  const radius = minRadius + ((hash + drift + clock) % steps) * 4;
  // Prefer the direction the body is already facing. A pure hash/time
  // heading made consecutive explore legs point at unrelated compass
  // directions, so a long walk was immediately followed by a long walk back.
  // The eight candidates still cover every direction; the pathfinder picks
  // the first safe one, starting with straight ahead.
  // Body yaw is the current movement intent; the camera yaw is a spring
  // follower and can still point at the previous leg when the next plan is
  // made. Prefer the body so a new leg does not immediately reverse.
  // A steady sweep is the exception: re-reading yaw after a failed or partial
  // leg made the body alternate east/west inside the same twelve blocks.
  const facing = facts.yaw ?? facts.cameraYaw;
  const baseAngle =
    !steady && typeof facing === "number" && Number.isFinite(facing)
      ? (facing + 90 + headingOffset + 360) % 360
      : ((hash % 360) +
          (steady ? 0 : Math.trunc(origin.x) * 7 + Math.trunc(origin.z) * 13) +
          clock * 45 +
          headingOffset) %
        360;
  const generated = Array.from({ length: 8 }, (_, index) => {
    const radians = ((baseAngle + index * 45) * Math.PI) / 180;
    return {
      x: Math.round((origin.x + Math.cos(radians) * radius) * 10) / 10,
      y: Math.round(origin.y * 10) / 10,
      z: Math.round((origin.z + Math.sin(radians) * radius) * 10) / 10,
    };
  });
  const suggestedLock =
    facts.targetLock?.kind === "explore"
      ? {
          x: facts.targetLock.x,
          y: facts.targetLock.y,
          z: facts.targetLock.z,
        }
      : null;
  const lockedExplore =
    suggestedLock !== null &&
    /*
     * A lock is a direction, not a destination the body may stand on
     * forever. Once the body is already at the locked point, re-issuing it
     * produced a tight loop of `goto completed` frames every few hundred
     * milliseconds until the thirty-second lock expired. Treat "arrived" as
     * satisfied and choose the next heading.
     *
     * A lock also cannot outlive the walk budget. A 262-block explore target
     * persisted across a drift to the coast and every hunt re-issued the same
     * unreachable goto, so the body alternated between failed sweeps and
     * recovery walks. Anything beyond one bounded leg is stale direction
     * data; re-sweep locally instead.
     */
    Math.hypot(
      suggestedLock.x - origin.x,
      suggestedLock.z - origin.z,
    ) > 4 &&
    Math.hypot(
      suggestedLock.x - origin.x,
      suggestedLock.z - origin.z,
    ) <= 64 &&
    !(facts.routeBlacklist ?? []).some((entry) =>
      routeBlacklistCovers(entry, suggestedLock, facts.now),
    )
      ? suggestedLock
      : null;
  const unblocked = generated.filter(
    (candidate) =>
      !(facts.routeBlacklist ?? []).some((entry) =>
        routeBlacklistCovers(entry, candidate, facts.now),
      ),
  );
  const candidates =
    lockedExplore === null
      ? unblocked.length > 0
        ? unblocked
        : generated
      : [
          lockedExplore,
          ...unblocked.filter(
            (candidate) =>
              Math.hypot(
                candidate.x - lockedExplore.x,
                candidate.z - lockedExplore.z,
              ) > 1,
          ),
        ];
  // A sticky lock plus eight sweep headings produced nine destinations,
  // which the bridge schema caps at eight. The whole plan then failed with
  // `invalid args for goto` on every tick until the lock expired. Keep the
  // locked target first and trim the sweep to the remaining slots.
  const boundedCandidates = candidates.slice(0, 8);
  return {
    id: `task:${newId()}`,
    stage,
    kind: "navigate",
    title: `${title}（搜索 ${resource}）`,
    skill: skill("goto", {
      target: boundedCandidates[0]!,
      candidates: boundedCandidates,
      acceptPartial: true,
      mode: "walk",
    }, newId),
    targetLock: {
      kind: "explore",
      ref: `explore:${stage}:${resource}`,
      dimension: facts.dimension ?? "minecraft:overworld",
      x: boundedCandidates[0]!.x,
      y: boundedCandidates[0]!.y,
      z: boundedCandidates[0]!.z,
    },
    preconditions: [
      "a safe bounded route exists from the current position",
      "the target resource is not already visible in the local snapshot",
    ],
    expectedEvidence: [
      "the body reaches a new observation area",
      `a later snapshot contains ${resource}`,
    ],
    verify: () => true,
  };
}

/**
 * A mob snapshot includes its coordinates, but the attack skill's own path
 * finder only knows how to walk. When a sheep stands across a ravine or a
 * gap, attack fails with "no reachable route" forever. Approach with the
 * navigation skill first: `goto` owns the staircase/bridge escape, and the
 * next planning cycle can attack once the body is actually nearby.
 */
function approachEntity(
  facts: WorldFacts,
  stage: GoalId,
  entity: NearbyEntity,
  label: string,
  newId: () => string,
): Task | null {
  if (entity.distance <= 6) return null;
  if (entity.x === undefined || entity.y === undefined || entity.z === undefined) return null;
  const target = { x: entity.x, y: entity.y, z: entity.z };
  return {
    id: `task:${newId()}`,
    stage,
    kind: "navigate",
    title: `接近${label}`,
    skill: skill("goto", {
      target,
      acceptPartial: false,
      mode: "walk",
    }, newId),
    targetLock: {
      kind: "entity",
      ref: `${entity.type}:${entity.name}`,
      dimension: facts.dimension ?? "minecraft:overworld",
      x: entity.x,
      y: entity.y,
      z: entity.z,
    },
    preconditions: ["the target entity reported coordinates", "no safe attack route from here"],
    expectedEvidence: ["the body reaches the target's observation area", "a later attack can close the last few blocks"],
    verify: (next) =>
      next.position === undefined ||
      next.position === null ||
      Math.hypot(
        next.position.x - target.x,
        next.position.y - target.y,
        next.position.z - target.z,
      ) <= 8,
  };
}

function blockedWith(
  stage: GoalId,
  kind: TaskKind,
  title: string,
  missing: readonly Missing[],
): BlockedTask {
  return { stage, kind, title, missing };
}

function skill(name: SkillCall["name"], args: SkillCall["args"], newId: () => string): SkillCall {
  // The key is derived from the action, so re-planning after a reconnect
  // reuses the same bridge idempotency instead of duplicating a completed
  // craft. `newId` remains the source of the task id for tracing.
  return { name, args, idempotencyKey: `survival:${name}:${stableArgs(args)}` };
}

function stableArgs(args: SkillCall["args"]): string {
  const entries = Object.entries(args).sort(([left], [right]) => left.localeCompare(right));
  return entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("&");
}

function hasStation(
  facts: WorldFacts,
  station: "crafting_table" | "furnace" | "blast_furnace" | "bed" | "portal",
): boolean {
  if ((facts.stations ?? []).includes(station)) return true;
  // A remembered furnace is *not* in reach. `gotoFurnaceTask` owns walking
  // back to it; reporting it here made the planner skip that trip and then
  // insist it could smelt from eighty blocks away, which usually ended in a
  // pointless torch or second-furnace detour.
  // Direct domain fixtures may not run the snapshot projection; the observed
  // nearby blocks are authoritative on their own.
  return (facts.nearbyBlocks ?? []).some((block) => {
    const id = block.id;
    if (station === "crafting_table") return id === "minecraft:crafting_table";
    if (station === "furnace") return id === "minecraft:furnace" || id === "minecraft:blast_furnace";
    if (station === "blast_furnace") return id === "minecraft:blast_furnace";
    if (station === "bed") return BED_ITEMS.test(id);
    return id === "minecraft:nether_portal";
  });
}

/**
 * A station is infrastructure, not a disposable item. Prefer walking back to
 * the table this run already placed; only rebuild when it is genuinely out of
 * range, and never build a new one deep underground where it anchors the
 * body's "home" in a hole.
 */
function ensureTable(
  facts: WorldFacts,
  stage: GoalId,
  newId: () => string,
): Task | BlockedTask | null {
  const table = facts.craftingTable;
  const position = facts.position;
  const distance =
    table === undefined || table === null || position === undefined || position === null
      ? null
      : Math.hypot(table.x - position.x, table.y - position.y, table.z - position.z);
  const tableInReach =
    hasStation(facts, "crafting_table") || facts.craftingTableNearby === true;
  const carried = hasItem(facts, "minecraft:crafting_table");
  const overworldUnderground = deepUnderground(facts);
  const tableAbove =
    table !== undefined && table !== null && position !== undefined && position !== null
      ? table.y - position.y
      : 0;

  if (tableInReach) {
    // `nearby=true` only means the block is inside the observation window.
    // The craft skill's own approach refuses ledges and then reports
    // "dangerous drop on the route to the crafting table". Use the full
    // navigation skill first: it can staircase, bridge and test several
    // approach cells. The next observation decides whether the table really
    // became usable or a replacement is needed.
    if (
      facts.craftingTableReachable === false &&
      table !== undefined &&
      table !== null
    ) {
      if (overworldUnderground && tableAbove > 8) {
        return returnToSurfaceTask(stage, facts, newId) ??
          blocked(stage, "navigate", "返回地表");
      }
      return gotoCraftingTableTask(stage, facts, newId);
    }
    return null;
  }

  // `reachable=false` means the bridge could not interact with the remembered
  // table, not that the table is a valid walking destination. The live run
  // kept asking for a stone pickaxe and failing with "no safe route to the
  // crafting table" while carrying enough planks to build a 2x2 table on the
  // spot. Prefer the local rebuild when the materials are already in the pack;
  // otherwise keep the existing walk-home behaviour for partially observed
  // tables.
  // A table this body just placed beside itself is not "missing" merely
  // because the crosshair ray did not reach it. Rebuilding in that state was
  // the visible table place/reclaim loop: every snapshot saw the fresh table
  // as unreachable, crafted another, and placed it on a newer ledge. Let the
  // craft skill walk to a same-level table first; only rebuild when the
  // remembered station is genuinely out of walking range.
  if (
    facts.craftingTableReachable === false &&
    !placedTableWithinWalk(facts)
  ) {
    const rescue = rescueTableTask(stage, facts, newId);
    if (rescue !== null) return rescue;
  }

  // A lost pickaxe deep underground is a tool rescue, not a commute. When
  // the remembered table is far above and the body already carries wood and
  // cobblestone, build a local 2×2 table and replace the pickaxe on the spot.
  // Otherwise the body walks home (or punches stone bare-handed) with a full
  // inventory of perfectly usable material.
  if (
    overworldUnderground &&
    Math.abs(tableAbove) > MAX_WALK_TABLE_VERTICAL &&
    !hasUsablePickaxe(facts)
  ) {
    const rescue = rescueTableTask(stage, facts, newId);
    if (rescue !== null) return rescue;
  }

  // A carried table is a portable station. If the remembered one is not
  // already underfoot, place the carried copy here instead of trusting a
  // coordinate that may now be behind a wall. The live run had a table in the
  // inventory but kept walking to a remembered one that had no route.
  if (carried && (distance === null || distance > 6)) {
    return placeTableTask(stage, facts, newId, true);
  }

  if (facts.craftingTablePlaced === true && table !== undefined && table !== null) {
    // A remembered table on another floor is not a walking target. The
    // live run had a field table at y=18 and a body at y=65; `goto` cannot
    // descend a mineshaft, so it mined a horizontal tunnel until the budget
    // expired. Place a local table from carried planks/table instead.
    if (Math.abs(tableAbove) > MAX_WALK_TABLE_VERTICAL) {
      const rescue = rescueTableTask(stage, facts, newId);
      if (rescue !== null) return rescue;
      if (overworldUnderground) {
        return returnToSurfaceTask(stage, facts, newId) ??
          blocked(stage, "navigate", "返回地表重新建立工作台");
      }
    }
    // The body's craft skill walks to the remembered table itself. Crafting
    // a replacement whenever the body wandered away is what left workbenches
    // across the map: the old table still existed, it was simply out of the
    // observation radius. The only honest reason to build another is that
    // the bridge observed the remembered block is gone.
    // A table inside the bounded walk is left to the craft skill, which
    // approaches it itself. Only a genuinely distant station needs an
    // explicit navigation leg; either way, never craft a second table.
    if (distance === null || distance <= WALK_BACK_TABLE_DISTANCE) {
      // The craft skill only walks. A surface table more than eight blocks
      // above a mine needs the navigation skill's staircase escape first.
      if (overworldUnderground && tableAbove > 8) {
        return returnToSurfaceTask(stage, facts, newId) ?? blocked(stage, "navigate", "返回地表");
      }
      return null;
    }
    if (overworldUnderground) {
      return returnToSurfaceTask(stage, facts, newId) ?? blocked(stage, "navigate", "返回地表");
    }
    return gotoCraftingTableTask(stage, facts, newId) ??
      blocked(stage, "navigate", "走回工作台");
  }

  if (carried) {
    if (overworldUnderground) {
      return returnToSurfaceTask(stage, facts, newId) ?? blocked(stage, "navigate", "返回地表");
    }
    const camp = gotoCampBeforePlacement(stage, facts, newId);
    if (camp !== null) return camp;
    return placeTableTask(stage, facts, newId);
  }

  if (overworldUnderground) {
    return returnToSurfaceTask(stage, facts, newId) ?? blocked(stage, "navigate", "返回地表");
  }

  const recipe = queryRecipe("minecraft:crafting_table");
  if (recipe !== null) {
    const replacement = craftWithPrerequisite(recipe, stage, facts, newId, "制作工作台");
    if ("skill" in replacement) return replacement;
  }
  if (hasCraftingTableProduct(facts)) return null;
  return blockedWith(stage, "craft", "制作工作台", [
    { kind: "station", item: "minecraft:crafting_table", detail: "3×3 配方需要工作台" },
  ]);
}

function placeTableTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
  allowUnderground = false,
): Task | BlockedTask {
  if (!allowUnderground && deepUnderground(facts)) {
    return returnToSurfaceTask(stage, facts, newId) ??
      blocked(stage, "navigate", "返回地表再放置工作台");
  }
  return {
    id: `task:${newId()}`,
    stage,
    kind: "place",
    title: "放下工作台",
    skill: skill("place_block", { block: "minecraft:crafting_table", count: 1 }, newId),
    preconditions: ["crafting_table in inventory", "a safe adjacent block face exists"],
    expectedEvidence: ["nearbyBlocks contains crafting_table"],
    verify: (next) => nearbyHas(next, /crafting_table$/u) !== null,
  };
}

/**
 * Builds the table needed to restore a broken pickaxe where the body stands.
 * Only offered when the material for a 2×2 table is already in the backpack;
 * otherwise the normal surface-return decision wins.
 */
function rescueTableTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask | null {
  if (hasItem(facts, "minecraft:crafting_table")) {
    return placeTableTask(stage, facts, newId, true);
  }
  const planks = facts.inventory
    .filter((slot) => /(^|:)[a-z_]+_planks$/u.test(slot.item))
    .reduce((total, slot) => total + slot.count, 0);
  if (planks < 4 && logCount(facts) < 1) return null;
  const recipe = queryRecipe("minecraft:crafting_table");
  if (recipe === null) return null;
  const missing = missingForRecipe(recipe, facts);
  if (missing.length === 0) return craftTask(recipe, stage, facts, newId);
  const prerequisite = preparationTask(recipe, stage, facts, newId, 0);
  return prerequisite;
}

function gotoCraftingTableTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  const table = facts.craftingTable;
  if (table === undefined || table === null) return null;
  const candidates = [table.y + 1, table.y, table.y - 1].flatMap((level) => [
    { x: table.x + 1, y: level, z: table.z },
    { x: table.x - 1, y: level, z: table.z },
    { x: table.x, y: level, z: table.z + 1 },
    { x: table.x, y: level, z: table.z - 1 },
  ]).slice(0, 8);
  return {
    id: `task:${newId()}`,
    stage,
    kind: "navigate",
    title: "走回工作台",
    skill: skill("goto", {
      target: candidates[0],
      candidates,
      acceptPartial: transferAcceptsPartial(facts, candidates[0]!),
      mode: "walk",
    }, newId),
    preconditions: ["a placed crafting table is remembered", "a route to the station exist"],
    expectedEvidence: ["the crafting table enters interaction range"],
    verify: (next) =>
      next.position !== undefined &&
      next.position !== null &&
      candidates.some((candidate) => distanceTo(next.position!, candidate) <= 2),
  };
}

/**
 * A same-level placed table within a bounded walk is a usable station even
 * while it is outside interaction range. The body's `reachable` flag only
 * describes the nearest touchable face, not whether a path exists.
 */
function placedTableWithinWalk(facts: WorldFacts): boolean {
  const table = facts.craftingTable;
  const position = facts.position;
  if (
    facts.craftingTablePlaced !== true ||
    table === undefined ||
    table === null ||
    position === undefined ||
    position === null
  ) {
    return false;
  }
  if (Math.abs(table.y - position.y) > REPLACE_TABLE_VERTICAL) return false;
  return (
    Math.hypot(
      table.x - position.x,
      table.y - position.y,
      table.z - position.z,
    ) <= JUST_PLACED_TABLE_DISTANCE
  );
}

function dimension(facts: WorldFacts): string {
  return facts.dimension ?? "unverified";
}

function shortName(id: string): string {
  return normalizeItemId(id).replace(/^minecraft:/u, "");
}

export function toolProblem(block: string, facts: WorldFacts): Missing | null {
  const requirement = requiredTool(block);
  const tools = facts.inventory.filter((slot) => /_pickaxe$|_axe$|_shovel$|_hoe$|shears$/u.test(slot.item));
  for (const tool of tools) {
    if (tool.durability !== 0 && canMine(tool.item, block)) return null;
  }
  return {
    kind: "tool",
    item: requirement.tool,
    detail: `${shortName(block)} 需要 ${requirement.minimumTier} 级 ${requirement.tool}`,
  };
}

export function dropsForBlock(block: string): readonly { item: string; min: number; max: number }[] {
  return dropsFor(block);
}

export function missingFood(facts: WorldFacts): boolean {
  return isHungry(facts) && !facts.inventory.some((slot) => FOOD_ITEMS.test(slot.item));
}

export function countFood(facts: WorldFacts): number {
  return countAny(
    facts,
    facts.inventory.filter((slot) => FOOD_ITEMS.test(slot.item)).map((slot) => slot.item),
  );
}
