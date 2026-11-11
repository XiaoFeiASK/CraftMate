import type { SkillCall } from "@craftmate/contracts";
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
  hasCraftingTableProduct,
  hasItem,
  hasUsablePickaxe,
  inventoryCount,
  isHungry,
  isNight,
  isUnderground,
  nearbyHas,
  nearestEntity,
  nearestEntityWithinHeight,
  pickaxeTier,
  pickaxeUses,
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

export interface TaskContext {
  readonly stage: GoalId;
  readonly facts: WorldFacts;
  readonly newId: () => string;
}

const WOOD_ITEMS = /(^|:)[a-z_]+_(log|wood|stem|hyphae)$/u;
const PLANK_ITEMS = /(^|:)[a-z_]+_planks$/u;
const BED_ITEMS = /(^|:)[a-z_]+_bed$/u;
const WOOL_ITEMS = /(^|:)[a-z_]+_wool$/u;
const FOOD_ITEMS =
  /(^|:)apple$|(^|:)baked_potato$|(^|:)bread$|(^|:)carrot$|(^|:)potato$|(^|:)beetroot$|(^|:)sweet_berries$|(^|:)melon_slice$|(^|:)cookie$|(^|:)golden_apple$|(^|:)golden_carrot$|(^|:)pumpkin_pie$|(^|:)honey_bottle$|(^|:)(cooked_)?(beef|chicken|cod|mutton|porkchop|rabbit|salmon)$/u;
/**
 * Rotten flesh is a last-resort meal. It restores hunger at the cost of a
 * short hunger effect, so it is only worth planning when the body is already
 * hungry and has no proper food. Refusing it entirely can leave a hurt body
 * unable to eat while it keeps failing hunts.
 */
const EMERGENCY_FOOD_ITEMS = /(^|:)rotten_flesh$/u;
/** Items vanilla allows even when the hunger bar is already full. */
const ALWAYS_EDIBLE_ITEMS =
  /(^|:)golden_apple$|(^|:)enchanted_golden_apple$|(^|:)golden_carrot$|(^|:)honey_bottle$/u;
/**
 * Item entities carry the localized display name, not their registry id.
 * The body reports "苹果" in a Chinese client and "Apple" in an English one,
 * so the planner has to accept both spellings when deciding whether a
 * dropped meal is worth a pickup walk.
 */
const DROPPED_FOOD_NAME =
  /苹果|apple|腐肉|rotten flesh|牛肉|beef|鸡肉|chicken|猪肉|porkchop|羊肉|mutton|兔肉|rabbit|鳕鱼|cod|鲑鱼|salmon|面包|bread|胡萝卜|carrot|马铃薯|potato|甜菜根|beetroot|甜浆果|sweet berries/iu;
const HOSTILE_ENTITIES =
  /zombie|husk|drowned|skeleton|stray|creeper|spider|witch|pillager|vindicator|evoker|ravager|enderman|slime|magma_cube|blaze|ghast|wither|piglin|hoglin|phantom|warden/iu;
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
 * A remembered table on the same floor is a real station even when it is
 * outside interaction range. Walking back a short tunnel is cheaper and far
 * more reliable than exploring 48 blocks for wood to build a replacement --
 * especially underground, where no tree exists at all.
 */
const WALK_BACK_TABLE_DISTANCE = 64;

/**
 * Builds the single next executable task for a stage. When no task is ready,
 * returns a blocked description that names the first missing dependency
 * instead of inventing an action.
 */
export function nextTaskForStage(context: TaskContext): Task | BlockedTask | null {
  const { stage, facts, newId } = context;
  const safety = immediateSafetyTask(stage, facts, newId);
  if (safety !== null) return safety;
  // Hunger is a survival need in every stage, not only while the food stage
  // happens to be the current milestone. This keeps a later mining trip from
  // ignoring a steak in the backpack until the body starves.
  const meal = immediateFoodTask(stage, facts, newId);
  if (meal !== null) return meal;
  // Night and a full backpack are cross-stage needs too. Going home must win
  // over a mining or exploration task, and offloading bulk items has to win
  // before a full inventory silently blocks every pickup.
  const nightHome = nightHomeTask(stage, facts, newId);
  if (nightHome !== null) return nightHome;
  const campChest = campChestTask(stage, facts, newId);
  if (campChest !== null) return campChest;
  const campBed = campBedTask(stage, facts, newId);
  if (campBed !== null) return campBed;
  const storage = homeStorageTask(stage, facts, newId);
  if (storage !== null) return storage;
  const miningReturn = miningReturnTask(stage, facts, newId);
  if (miningReturn !== null) return miningReturn;
  let task: Task | BlockedTask | null;
  switch (stage) {
    case "wood-and-table":
      task = woodAndTable(facts, newId);
      break;
    case "stone-tools":
      task = stoneTools(facts, newId);
      break;
    case "food":
      task = foodTask(facts, newId);
      break;
    case "shelter":
      task = shelter(facts, newId);
      break;
    case "iron":
      task = iron(facts, newId);
      break;
    case "nether":
      task = nether(facts, newId);
      break;
    case "eyes":
      task = eyes(facts, newId);
      break;
    case "stronghold":
      task = stronghold(facts, newId);
      break;
    case "dragon":
      task = dragon(facts, newId);
      break;
  }
  return nightMobility(stage, facts, task, newId);
}

function immediateFoodTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  if (!isHungry(facts)) return null;
  const food =
    facts.inventory.find((slot) => FOOD_ITEMS.test(slot.item)) ??
    facts.inventory.find((slot) => EMERGENCY_FOOD_ITEMS.test(slot.item));
  if (food === undefined) return null;
  return {
    id: `task:${newId()}`,
    stage,
    kind: "interact",
    title: `进食补充饥饿：${shortName(food.item)}`,
    skill: skill("eat", { item: food.item }, newId),
    preconditions: ["hunger is below the safe threshold", "food in inventory"],
    expectedEvidence: [`${food.item} count decreases`, "food_consumed evidence"],
    verify: (next) => inventoryCount(next, food.item) < inventoryCount(facts, food.item),
  };
}

/**
 * Without a bed, standing still to chop or mine all night is how every run
 * ended: a zombie walked up while the body was locked into a destroy loop.
 * Keep the body moving between observation points after dusk instead. Eating,
 * crafting and a melee answer to a mob already in range stay available; only
 * long stationary work is deferred to daylight.
 */
function nightMobility(
  stage: GoalId,
  facts: WorldFacts,
  task: Task | BlockedTask | null,
  newId: () => string,
): Task | BlockedTask | null {
  if (isNight(facts) !== true) return task;
  if (
    facts.inventory.some((slot) => BED_ITEMS.test(slot.item)) ||
    nearbyHas(facts, BED_ITEMS) !== null
  ) {
    return task;
  }
  if (task === null || !("skill" in task)) return task;
  if (!/^(goto|mine_block|chop_tree|collect_items)$/u.test(task.skill.name)) {
    return task;
  }
  // A goto already keeps the body moving, and collecting a drop is a short
  // nearby action. Only stationary work needs the safety override. Even then
  // do not erase the whole night: two out of three in-game hour windows keep
  // the real task so wood, stone and food can still progress, while the
  // remaining window sweeps a new area instead of standing under a tree.
  if (task.skill.name === "goto") {
    const target = task.skill.args["target"] as
      | { readonly x: number; readonly y: number; readonly z: number }
      | undefined;
    const position = facts.position;
    // A station return is not a local resource sweep. The table can sit
    // directly above the mine, so measuring only x/z would misclassify a
    // 30-block vertical climb as "nearby" and cancel it every night window.
    if (task.skill.args["acceptPartial"] === false) return task;
    // A hunt or a shelter search already travels a wide ring; keep it.
    // A targeted goto (no candidate list) is an approach to a specific
    // entity or station; replacing it with a random sweep loses the sheep
    // that prompted it. Only the local resource sweeps need widening.
    if (
      target != null &&
      position != null &&
      (task.skill.args["candidates"] === undefined ||
        Math.hypot(
          target.x - position.x,
          target.y - (position.y ?? target.y),
          target.z - position.z,
        ) >= 20)
    ) {
      return task;
    }
    return explore(facts, stage, "夜间保持移动，避免被围攻", "安全地带", 2, newId, 20, 32, true);
  }
  if (task.skill.name === "collect_items") {
    return task;
  }
  const clock = Math.floor((facts.timeOfDay ?? 0) / 1_000);
  if (clock % 3 !== 0) return task;
  return explore(facts, stage, "夜间保持移动，避免被围攻", "安全地带", 2, newId, 20, 32, true);
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
  const urgent = close || (health < RETREAT_HEALTH && threat.distance <= 10);
  if (!urgent) return null;
  const mustRetreat = health < RETREAT_HEALTH || /creeper/iu.test(threat.type);

  if (mustRetreat && position !== null && position !== undefined && threatPosition !== null) {
    const dx = position.x - threatPosition.x;
    const dz = position.z - threatPosition.z;
    const length = Math.hypot(dx, dz);
    const baseAngle = length < 0.01
      ? Math.PI / 2
      : Math.atan2(dz, dx);
    const candidates = Array.from({ length: 7 }, (_, index) => {
      const offset = (index - 3) * (Math.PI / 6);
      const radians = baseAngle + offset;
      const distance = index === 3 ? 16 : 12;
      return {
        x: Math.round((position.x + Math.cos(radians) * distance) * 10) / 10,
        y: Math.round(position.y * 10) / 10,
        z: Math.round((position.z + Math.sin(radians) * distance) * 10) / 10,
      };
    });
    return {
      id: `task:${newId()}`,
      stage,
      kind: "navigate",
      title: `低血量撤离 ${threat.name}`,
      skill: skill("goto", {
        target: candidates[3]!,
        candidates,
        acceptPartial: true,
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

  if (health >= RETREAT_HEALTH && threat.distance <= 5.5) {
    return {
      id: `task:${newId()}`,
      stage,
      kind: "combat",
      title: `击退近身威胁 ${threat.name}`,
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
    skill: skill("goto", { target, acceptPartial: true }, newId),
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
      skill: skill("mine_block", { block: nearbyStone.id, count: 3 }, newId),
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
 * Only `stone` drops cobblestone. `deepslate` is a different block and drops
 * `cobbled_deepslate`, so accepting it here would make the cobblestone
 * milestone impossible to satisfy.
 */
function reachableStone(facts: WorldFacts): NearbyBlock | null {
  const target = facts.reachableBlock;
  if (target !== undefined && target !== null && /(^|:)stone$/u.test(target.id)) {
    return { id: target.id };
  }
  // `reachableBlock` is only the block under the current crosshair. The body
  // can turn and walk toward a nearby stone block on its own, so nearby
  // observation is enough to issue the task; the body still has to prove it
  // reached and mined it.
  return nearbyHas(facts, /(^|:)stone$/u);
}

function blockHasLocation(block: NearbyBlock): boolean {
  return block.x !== undefined && block.y !== undefined && block.z !== undefined;
}

function logCount(facts: WorldFacts): number {
  return facts.inventory.reduce(
    (total, slot) => (WOOD_ITEMS.test(slot.item) ? total + slot.count : total),
    0,
  );
}

function foodTask(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  const food = facts.inventory.find((slot) => FOOD_ITEMS.test(slot.item));
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
    facts.food >= 18 &&
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
    facts.canSeeSky === false
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
    facts.canSeeSky === false &&
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
  // A coastal or cleared forest can have no passive animals in the hunt
  // window while oak trees are everywhere. Exploring the same ring forever
  // cannot create a cow, but chopping an oak does create a real food chance:
  // the canopy decays, apples drop, and the body's pickup pass collects them.
  // The logs are useful for tools and shelter either way. This must be
  // species-specific; `chop_tree` could pick a birch and produce no apples.
  const oakLog = nearbyHas(facts, /(^|:)(dark_oak|oak)_log$/u);
  const oakLeaves = nearbyHas(facts, /(^|:)(dark_oak|oak)_leaves$/u);
  const hasWoodReserve = logCount(facts) >= 16;
  if (oakLeaves !== null && (hasWoodReserve || oakLog === null)) {
    // A healthy log reserve does not need another tree. Sweep the canopy for
    // the only food drop it can produce instead of filling the backpack with
    // more construction wood.
    return {
      id: `task:${newId()}`,
      stage: "food",
      kind: "gather",
      title: "打落橡树叶寻找苹果",
      skill: skill("mine_block", { block: oakLeaves.id, count: 32 }, newId),
      preconditions: ["oak leaves are nearby", "no passive animal is in the hunt window"],
      expectedEvidence: ["oak leaves are broken", "the leaf drop table may produce an apple"],
      verify: (next) =>
        next.foodAcquired === true ||
        next.inventory.some((slot) => FOOD_ITEMS.test(slot.item)),
    };
  }
  if (oakLog !== null) {
    // Chopping logs is the reliable half of the apple strategy. It produces
    // a drop at the body's feet, so the mining task can confirm pickup and
    // complete. The canopy then decays on its own and rolls the apple drop
    // table. Breaking leaves directly was faster in theory but the body could
    // not confirm their sapling/apple drops, so every attempt failed with
    // "block was broken but pickup was not confirmed" and the runtime looped.
    // Six logs is enough to fell most oak trees; a taller one simply takes a
    // second task.
    return {
      id: `task:${newId()}`,
      stage: "food",
      kind: "gather",
      title: "砍橡树寻找苹果",
      skill: skill("mine_block", { block: oakLog.id, count: 6 }, newId),
      preconditions: ["an oak tree is nearby", "no passive animal is in the hunt window"],
      expectedEvidence: ["oak logs enter the inventory", "decaying leaves may drop an apple"],
      verify: (next) => logCount(next) > logCount(facts),
    };
  }
  // There is no visible animal. An attack with no target fails in the same
  // tick and the runtime then retries byte-identical work after every
  // backoff, which looks exactly like an idle agent. Walking to a new
  // observation area is the action that can actually create a hunt target.
  // A passive mob is rarely inside the 16-block observation that failed
  // above. Sweep further than the generic resource search so a full loop
  // actually covers new ground instead of orbiting the same clearing.
  return explore(facts, "food", "寻找可猎取的动物", "动物", 2, newId, 24, 36, true);
}

function shelter(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  if (facts.sleeping === true) return null;
  // A camp is a surface home. Building it in a mineshaft is how the body
  // ended up sleeping and storing loot underground, then treating the hole
  // as "home" on every later trip.
  if (deepUnderground(facts)) {
    return returnToSurfaceTask("shelter", facts, newId) ??
      blocked("shelter", "navigate", "返回地表建立营地");
  }

  const bedNearby = nearbyHas(facts, BED_ITEMS);
  const bedItem = facts.inventory.find((slot) => BED_ITEMS.test(slot.item));
  const bedPlaced =
    facts.bedPlaced === true && !anchorIsUnderground(facts, facts.bed ?? null);
  const hasBed =
    bedPlaced ||
    bedNearby !== null ||
    bedItem !== undefined;
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

  const home = homeAnchor(facts);
  if (
    home !== null &&
    facts.position !== undefined &&
    facts.position !== null &&
    distanceTo(facts.position, home) > 6 &&
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

function anchorIsUnderground(
  facts: WorldFacts,
  anchor: { readonly x: number; readonly y: number; readonly z: number } | null,
): boolean {
  if (anchor === null) return false;
  // A surface reading is only trustworthy for the current column. When the
  // body is deep under a mountain, comparing a valley camp to that column's
  // surface height would misclassify the camp as underground.
  const surface = facts.surfaceY;
  if (facts.canSeeSky === true && surface !== undefined && surface !== null) {
    return anchor.y < surface - 4;
  }
  // Sea level is 63; a remembered chest or bed this low is almost certainly
  // an outpost, not the surface camp.
  return anchor.y < 40;
}

/**
 * A station at a shallow mine entrance is an outpost; a station forty blocks
 * down is a second home. The body must climb out before placing camp
 * infrastructure, even when it is currently carrying the item.
 */
function deepUnderground(facts: WorldFacts): boolean {
  if (facts.dimension !== undefined && facts.dimension !== "overworld") return false;
  return (depthBelowSurface(facts) ?? 0) > 8;
}

function distanceTo(
  left: { readonly x: number; readonly y: number; readonly z: number },
  right: { readonly x: number; readonly y: number; readonly z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function nearbyPoint(block: NearbyBlock | null): { x: number; y: number; z: number } | undefined {
  return block !== null && blockHasLocation(block)
    ? { x: block.x!, y: block.y!, z: block.z! }
    : undefined;
}

function gotoHomeTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  const home = homeAnchor(facts);
  const position = facts.position;
  if (home === null || position === undefined || position === null) return null;
  // Stand beside the station, never inside its own cell. The top face of a
  // chest/table is one block above the block coordinate.
  const y = home.y + 1;
  const candidates = [
    { x: home.x + 1, y, z: home.z },
    { x: home.x - 1, y, z: home.z },
    { x: home.x, y, z: home.z + 1 },
    { x: home.x, y, z: home.z - 1 },
  ];
  return {
    id: `task:${newId()}`,
    stage,
    kind: "navigate",
    title: "回家",
    skill: skill("goto", {
      target: candidates[0],
      candidates,
      acceptPartial: false,
    }, newId),
    preconditions: ["a placed home station is remembered", "a safe route home exists"],
    expectedEvidence: ["the body reaches the camp"],
    verify: () => true,
  };
}

/**
 * Returning from a mine is not the same as walking to a remembered table.
 * A deep staircase can leave the body below its own camp, so plan an explicit
 * climb back to the surface before hunger, a broken pickaxe or a full
 * backpack turns a productive trip into a death.
 */
function returnToSurfaceTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  if (!isUnderground(facts)) return null;
  if (facts.dimension !== undefined && facts.dimension !== "overworld") return null;
  const position = facts.position;
  const surface = facts.surfaceY;
  if (position === undefined || position === null || surface === undefined || surface === null) {
    return null;
  }
  const home = homeAnchor(facts);
  const target = { x: Math.round(position.x), y: Math.round(surface) + 1, z: Math.round(position.z) };
  const candidates = [
    ...(home === null ? [] : [{ x: home.x + 1, y: home.y + 1, z: home.z }]),
    target,
  ];
  return {
    id: `task:${newId()}`,
    stage,
    kind: "navigate",
    title: "返回地表，先离开矿洞",
    skill: skill("goto", {
      target: candidates[0],
      candidates,
      acceptPartial: false,
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
    return returnToSurfaceTask(stage, facts, newId);
  }
  const depth = depthBelowSurface(facts) ?? 0;
  if (depth < 12) return null;
  const uses = pickaxeUses(facts, Math.max(1, pickaxeTier(facts)));
  const inventoryFull = usedInventorySlots(facts) >= 28;
  const lowFood = (facts.food ?? 20) < 10;
  const lowHealth = (facts.health ?? 20) < 12;
  // Walking back up the staircase does not consume the pickaxe. Reserve only
  // enough uses to finish the current cut and handle one blocked step.
  const exhausted = uses !== null && uses < 16;
  if (!inventoryFull && !lowFood && !lowHealth && !exhausted) {
    return null;
  }
  return returnToSurfaceTask(stage, facts, newId);
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
  // Euclidean distance is not reachability. A furnace five blocks away
  // behind a wall is still a station to walk to; only the observed
  // `furnaceInReach` check above may claim it is usable right now.
  const y = furnace.y + 1;
  const candidates = [
    { x: furnace.x + 1, y, z: furnace.z },
    { x: furnace.x - 1, y, z: furnace.z },
    { x: furnace.x, y, z: furnace.z + 1 },
    { x: furnace.x, y, z: furnace.z - 1 },
  ];
  return {
    id: `task:${newId()}`,
    stage,
    kind: "navigate",
    title: "走回熔炉",
    skill: skill("goto", {
      target: candidates[0],
      candidates,
      acceptPartial: false,
    }, newId),
    preconditions: ["a placed furnace is remembered", "a route to the station exists"],
    expectedEvidence: ["the furnace enters interaction range"],
    verify: () => true,
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
  const home = homeAnchor(facts);
  const position = facts.position;
  if (home === null || position === undefined || position === null) return null;
  return distanceTo(position, home) > 6 ? gotoHomeTask(stage, facts, newId) : null;
}

function placeChestTask(
  stage: GoalId,
  facts: WorldFacts,
  item: string,
  newId: () => string,
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
    title: "在家放置箱子",
    skill: skill("place_block", { block: item, count: 1 }, newId),
    preconditions: ["a chest item is in the inventory", "a safe adjacent block face exists"],
    expectedEvidence: ["the body reports a placed camp chest"],
    verify: (next) => next.chestPlaced === true || nearbyHas(next, /(^|:)chest$/u) !== null,
  };
}

function placeBedTask(
  stage: GoalId,
  facts: WorldFacts,
  item: string,
  newId: () => string,
): Task | BlockedTask {
  if (deepUnderground(facts)) {
    return returnToSurfaceTask(stage, facts, newId) ??
      blocked(stage, "navigate", "返回地表再放置床");
  }
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
  if (bedNearby !== null) return sleepTask(stage, facts, newId);
  const bedItem = facts.inventory.find((slot) => BED_ITEMS.test(slot.item));
  const home = homeAnchor(facts);
  const position = facts.position;
  if (bedItem !== undefined) {
    if (
      home !== null &&
      position !== undefined &&
      position !== null &&
      distanceTo(position, home) > 6
    ) {
      return gotoHomeTask(stage, facts, newId);
    }
    return placeBedTask(stage, facts, bedItem.item, newId);
  }
  if (
    facts.bedPlaced === true &&
    home !== null &&
    position !== undefined &&
    position !== null &&
    distanceTo(position, home) > 6
  ) {
    return gotoHomeTask(stage, facts, newId);
  }
  return null;
}

const STORAGE_ITEMS =
  /(^|:)(cobblestone|raw_copper|dirt|oak_sapling|gravel|andesite|diorite|granite|tuff|deepslate|netherrack)$/u;

function usedInventorySlots(facts: WorldFacts): number {
  return facts.inventory.filter((slot) => slot.count > 0).length;
}

function storageChoice(facts: WorldFacts): string | null {
  const candidates = facts.inventory
    .filter((slot) => STORAGE_ITEMS.test(slot.item) && slot.count > 0)
    .filter(
      (slot) =>
        !(
          slot.item === "minecraft:cobblestone" &&
          pickaxeTier(facts) < 2 &&
          slot.count < 32
        ),
    )
    .sort((left, right) => right.count - left.count);
  return candidates[0]?.item ?? null;
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
  if (usedInventorySlots(facts) < 28) return null;
  const chestNearby = nearbyHas(facts, /(^|:)chest$/u);
  const rememberedChest = anchorIsUnderground(facts, facts.chest ?? null)
    ? undefined
    : facts.chest;
  const container = rememberedChest ?? nearbyPoint(chestNearby);
  // A remembered chest may be one floor above the body. Euclidean distance
  // does not prove that it is reachable or that the body is standing at the
  // container, so travel home first when the chest is not on this level.
  if (container === undefined) {
    if (facts.chestPlaced !== true) return null;
    return gotoHomeTask(stage, facts, newId);
  }
  const position = facts.position;
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
    return {
      id: `task:${newId()}`,
      stage,
      kind: "mine",
      title: "挖安全阶梯下到营地",
      skill: skill("descend", {
        targetY: container.y + 1,
        branchLength: 0,
      }, newId),
      preconditions: [
        "the remembered camp is below the body",
        "a pickaxe is available",
        "a safe staircase can keep a return route",
      ],
      expectedEvidence: ["the body reaches the camp layer"],
      verify: (next) =>
        (next.position?.y ?? Number.POSITIVE_INFINITY) <= container.y + 1,
    };
  }
  if (
    position !== undefined &&
    position !== null &&
    (distanceTo(position, container) > 6 ||
      Math.abs(position.y - container.y) > 2)
  ) {
    return gotoHomeTask(stage, facts, newId);
  }
  const item = storageChoice(facts);
  if (item === null) return null;
  return {
    id: `task:${newId()}`,
    stage,
    kind: "gather",
    title: `把 ${shortName(item)} 存进家里箱子`,
    skill: skill("deposit", {
      item,
      container,
    }, newId),
    preconditions: ["the camp chest is remembered", "a bulk material is filling the backpack"],
    expectedEvidence: ["the item count in the inventory decreases", "the chest receives the items"],
    verify: (next) => inventoryCount(next, item) < inventoryCount(facts, item),
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
  const chestPlaced =
    facts.chestPlaced === true && !anchorIsUnderground(facts, facts.chest ?? null);
  if (chestPlaced || chestNearby !== null) return null;
  if (chestItem !== undefined) {
    const home = homeAnchor(facts);
    if (
      home !== null &&
      facts.position !== undefined &&
      facts.position !== null &&
      distanceTo(facts.position, home) > 6
    ) {
      return gotoHomeTask(stage, facts, newId);
    }
    return placeChestTask(stage, facts, chestItem.item, newId);
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
    const home = homeAnchor(facts);
    if (
      home !== null &&
      facts.position !== undefined &&
      facts.position !== null &&
      distanceTo(facts.position, home) > 6
    ) {
      return gotoHomeTask(stage, facts, newId);
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
  if (!hasStation(facts, "furnace")) {
    // Reuse the furnace this run already placed before spending eight more
    // cobblestone on another one. Walking away from a station is not the
    // same as losing it, and the bridge remembers its coordinates.
    const rememberedFurnace = gotoFurnaceTask("iron", facts, newId);
    if (rememberedFurnace !== null) return rememberedFurnace;
    if (hasItem(facts, "minecraft:furnace")) {
      if (deepUnderground(facts)) {
        return returnToSurfaceTask("iron", facts, newId) ?? blocked("iron", "navigate", "返回地表");
      }
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
      const nearbyStone = nearbyHas(facts, /^minecraft:(stone|cobblestone)$/u);
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
    const coalOre = nearbyHas(facts, /coal_ore$/u);
    if (coalOre !== null && blockHasLocation(coalOre)) {
      return {
        id: `task:${newId()}`,
        stage: "iron",
        kind: "mine",
        title: "挖煤制作火把",
        skill: skill("mine_block", { block: coalOre.id, count: 1 }, newId),
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
  const pickaxeMissing = !hasUsablePickaxe(facts, 3);
  const swordMissing = !hasItem(facts, "minecraft:iron_sword");
  const ingots = inventoryCount(facts, "minecraft:iron_ingot");
  const rawIron = inventoryCount(facts, "minecraft:raw_iron");
  /**
   * A player upgrades the pickaxe as soon as three ingots exist; waiting for
   * the sword's two extra ingots made the body keep branch-mining while four
   * usable raw iron sat in the backpack. Each tool is therefore its own gate.
   */
  const toolPlan = (neededIngots: number): Task | BlockedTask | null => {
    const missingMetal = Math.max(0, neededIngots - ingots - rawIron);
    if (missingMetal > 0) {
      const ore = nearbyHas(facts, /iron_ore$/u);
      if (ore === null || !blockHasLocation(ore)) {
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
        title: `挖 ${missingMetal} 块铁矿石`,
        skill: skill("mine_block", { block: ore.id, count: missingMetal }, newId),
        preconditions: ["stone pickaxe or better", "iron ore nearby"],
        expectedEvidence: [`raw_iron count increases by ${missingMetal}`],
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
      return smeltTask(
        "iron",
        "minecraft:raw_iron",
        "minecraft:iron_ingot",
        neededIngots - ingots,
        fuel,
        facts,
        newId,
      );
    }
    return null;
  };
  if (pickaxeMissing) {
    const preparation = toolPlan(3);
    if (preparation !== null) return preparation;
    const table = ensureTable(facts, "iron", newId);
    if (table !== null) return table;
    const recipe = queryRecipe("minecraft:iron_pickaxe");
    if (recipe === null) return blocked("iron", "craft", "制作铁镐");
    const missing = missingForRecipe(recipe, facts);
    return missing.length === 0
      ? craftTask(recipe, "iron", facts, newId)
      : craftWithPrerequisite(recipe, "iron", facts, newId, "制作铁镐");
  }
  if (swordMissing) {
    const preparation = toolPlan(2);
    if (preparation !== null) return preparation;
    const table = ensureTable(facts, "iron", newId);
    if (table !== null) return table;
    const recipe = queryRecipe("minecraft:iron_sword");
    if (recipe === null) return blocked("iron", "craft", "制作铁剑");
    const missing = missingForRecipe(recipe, facts);
    return missing.length === 0
      ? craftTask(recipe, "iron", facts, newId)
      : craftWithPrerequisite(recipe, "iron", facts, newId, "制作铁剑");
  }
  return null;
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
      const planks = facts.inventory
        .filter((slot) => PLANK_ITEMS.test(slot.item))
        .reduce((total, slot) => total + slot.count, 0);
      if (planks > reserved) return item;
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

function miningLayerTask(
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
  const uses = pickaxeUses(facts, Math.max(1, tier));
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
  if (uses !== null && uses < neededUses) {
    return blockedWith(stage, "mine", title, [
      {
        kind: "tool",
        item: "minecraft:stone_pickaxe",
        detail: `预计需要 ${neededUses} 次挖掘，当前镐子只剩 ${uses} 次`,
      },
    ]);
  }
  if (depth > 24 && inventoryCount(facts, "minecraft:torch") < 4) {
    return blockedWith(stage, "mine", title, [
      { kind: "material", item: "minecraft:torch", count: 4, detail: "深层矿道至少需要 4 支火把" },
    ]);
  }
  if ((facts.food ?? 20) < 10) {
    return blockedWith(stage, "mine", title, [
      { kind: "safety", detail: "饥饿值过低，先补充食物再下矿" },
    ]);
  }
  if (usedInventorySlots(facts) >= 30) {
    return blockedWith(stage, "mine", title, [
      { kind: "safety", detail: "背包已满，先回营地存放再下矿" },
    ]);
  }
  const y = facts.position?.y;
  const descending = y === undefined || y === null || y > targetY + 1;
  return {
    id: `task:${newId()}`,
    stage,
    kind: "mine",
    title,
    skill: skill("descend", {
      targetY,
      branchLength: descending ? 0 : branchLength,
    }, newId),
    preconditions: [
      "a pickaxe is in the hotbar",
      "solid floor below the landing of each staircase step",
      "no fluid in the mining path",
    ],
    expectedEvidence: [
      "the body reaches the target mining layer",
      "fresh branch blocks are broken",
      "ore or stone drops enter the inventory",
    ],
    // Breaking one block and picking up its drop is not reaching the mining
    // layer. Only the body's height proves the descent; the branch work is
    // reported by the descend task's own evidence.
    verify: (next) =>
      (next.position?.y ?? Number.POSITIVE_INFINITY) <= targetY,
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
    const diamondOre = nearbyHas(facts, /diamond_ore$/u);
    if (diamondOre !== null && blockHasLocation(diamondOre)) {
      return {
        id: `task:${newId()}`,
        stage: "nether",
        kind: "mine",
        title: "挖 3 块钻石矿石",
        skill: skill("mine_block", { block: diamondOre.id, count: 3 }, newId),
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
    const obsidian = nearbyHas(facts, /obsidian$/u);
    if (obsidian === null) {
      return explore(facts, "nether", "寻找黑曜石", "黑曜石", 10, newId);
    }
    return {
      id: `task:${newId()}`,
      stage: "nether",
      kind: "mine",
      title: "挖 10 块黑曜石",
      skill: skill("mine_block", { block: "minecraft:obsidian", count: 10 }, newId),
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
    verify: (next) => !next.entities?.some((entity) => /dragon/iu.test(entity.type)),
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
  const facing = facts.yaw ?? facts.cameraYaw;
  const baseAngle =
    typeof facing === "number" && Number.isFinite(facing)
      ? (facing + 90 + headingOffset + 360) % 360
      : ((hash % 360) +
          (steady ? 0 : Math.trunc(origin.x) * 7 + Math.trunc(origin.z) * 13) +
          clock * 45 +
          headingOffset) %
        360;
  const candidates = Array.from({ length: 8 }, (_, index) => {
    const radians = ((baseAngle + index * 45) * Math.PI) / 180;
    return {
      x: Math.round((origin.x + Math.cos(radians) * radius) * 10) / 10,
      y: Math.round(origin.y * 10) / 10,
      z: Math.round((origin.z + Math.sin(radians) * radius) * 10) / 10,
    };
  });
  return {
    id: `task:${newId()}`,
    stage,
    kind: "navigate",
    title: `${title}（搜索 ${resource}）`,
    skill: skill("goto", { target: candidates[0]!, candidates, acceptPartial: true }, newId),
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
    skill: skill("goto", { target, acceptPartial: false }, newId),
    preconditions: ["the target entity reported coordinates", "no safe attack route from here"],
    expectedEvidence: ["the body reaches the target's observation area", "a later attack can close the last few blocks"],
    verify: (next) =>
      next.position === undefined ||
      next.position === null ||
      Math.hypot(next.position.x - target.x, next.position.z - target.z) <= 8,
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

  if (tableInReach) return null;

  if (facts.craftingTablePlaced === true && table !== undefined && table !== null) {
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
): Task | BlockedTask {
  if (deepUnderground(facts)) {
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

function gotoCraftingTableTask(
  stage: GoalId,
  facts: WorldFacts,
  newId: () => string,
): Task | null {
  const table = facts.craftingTable;
  if (table === undefined || table === null) return null;
  const candidates = [
    { x: table.x + 1, y: table.y, z: table.z },
    { x: table.x - 1, y: table.y, z: table.z },
    { x: table.x, y: table.y, z: table.z + 1 },
    { x: table.x, y: table.y, z: table.z - 1 },
  ];
  return {
    id: `task:${newId()}`,
    stage,
    kind: "navigate",
    title: "走回工作台",
    skill: skill("goto", {
      target: candidates[0],
      candidates,
      acceptPartial: false,
    }, newId),
    preconditions: ["a placed crafting table is remembered", "a route to the station exist"],
    expectedEvidence: ["the crafting table enters interaction range"],
    verify: () => true,
  };
}

/**
 * A same-level placed table within a bounded walk is a usable station even
 * while it is outside interaction range. The body's `reachable` flag only
 * describes the current crosshair, not whether a path exists.
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
    ) <= WALK_BACK_TABLE_DISTANCE
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
