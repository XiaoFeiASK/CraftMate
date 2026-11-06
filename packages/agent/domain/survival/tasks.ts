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
  hasAny,
  hasCraftingTableProduct,
  hasItem,
  inventoryCount,
  isHungry,
  isNight,
  nearbyHas,
  nearestEntity,
  nearestEntityWithinHeight,
  pickaxeTier,
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
/** Below this health a ranged mob is an immediate retreat, not a fair fight. */
const RETREAT_HEALTH = 14;

/**
 * Builds the single next executable task for a stage. When no task is ready,
 * returns a blocked description that names the first missing dependency
 * instead of inventing an action.
 */
export function nextTaskForStage(context: TaskContext): Task | BlockedTask | null {
  const { stage, facts, newId } = context;
  const safety = immediateSafetyTask(stage, facts, newId);
  if (safety !== null) return safety;
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
    // A hunt or a shelter search already travels a wide ring; keep it.
    // A targeted goto (no candidate list) is an approach to a specific
    // entity or station; replacing it with a random sweep loses the sheep
    // that prompted it. Only the local resource sweeps need widening.
    if (
      target != null &&
      position != null &&
      (task.skill.args["candidates"] === undefined ||
        Math.hypot(target.x - position.x, target.z - position.z) >= 20)
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
      return {
        id: `task:${newId()}`,
        stage,
        kind: "gather",
        title: "补充原木",
        skill: skill("chop_tree", { count: 1 }, newId),
        preconditions: ["a log block is nearby", "no screen is open"],
        expectedEvidence: ["a log enters the inventory"],
        verify: (next) => next.inventory.some((slot) => WOOD_ITEMS.test(slot.item)),
      };
    }
    // No tree in this observation is not proof that the recipe is
    // impossible. Walk one bounded step and look again instead of parking
    // the whole season goal on an unseen log.
    return explore(facts, stage, "寻找原木", "原木", 1, newId);
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
 * A missing table is itself a dependency. If planks are available on the
 * spot, turn the log/plank stock into the table first; otherwise keep the
 * explicit "need a station" reason.
 */
function placeOrBuildTable(
  table: Task | BlockedTask,
  facts: WorldFacts,
  newId: () => string,
): Task | BlockedTask {
  if ("skill" in table) return table;
  if (!hasItem(facts, "minecraft:crafting_table")) {
    const tableRecipe = queryRecipe("minecraft:crafting_table");
    if (tableRecipe !== null && missingForRecipe(tableRecipe, facts).length === 0) {
      return craftTask(tableRecipe, "stone-tools", facts, newId);
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
        return {
          id: `task:${newId()}`,
          stage: "wood-and-table",
          kind: "gather",
          title: "砍树补齐工作台材料",
          skill: skill("chop_tree", { count: 1 }, newId),
          preconditions: ["a log block is nearby", "no screen is open"],
          expectedEvidence: ["a log enters the inventory"],
          verify: (next) => next.inventory.some((slot) => WOOD_ITEMS.test(slot.item)),
        };
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
        return {
          id: `task:${newId()}`,
          stage: "wood-and-table",
          kind: "gather",
          title: "砍树并获得原木",
          skill: skill("chop_tree", { count: 1 }, newId),
          preconditions: ["a log block is nearby", "no screen is open"],
          expectedEvidence: ["a log enters the inventory"],
          verify: (next) => next.inventory.some((slot) => WOOD_ITEMS.test(slot.item)),
        };
      }
      return blockedWith("wood-and-table", "gather", "寻找并砍原木", [
        { kind: "resource", detail: "背包没有原木，附近也没有可观察到的原木" },
      ]);
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
  if (planks < 4 && !tableInInventory) {
    if (log === undefined) {
      const nearbyLog = nearbyHas(facts, WOOD_ITEMS);
      if (nearbyLog !== null) {
        return {
          id: `task:${newId()}`,
          stage: "wood-and-table",
          kind: "gather",
          title: "砍树并获得原木",
          skill: skill("chop_tree", { count: 1 }, newId),
          preconditions: ["a log block is nearby", "no screen is open"],
          expectedEvidence: ["a log enters the inventory"],
          verify: (next) => next.inventory.some((slot) => WOOD_ITEMS.test(slot.item)),
        };
      }
      return blockedWith("wood-and-table", "gather", "寻找并砍原木", [
        { kind: "resource", detail: "工作台已存在，但背包还没有木板或原木" },
      ]);
    }
    const recipe = planksRecipeFor(facts);
    if (recipe === null) return blocked("wood-and-table", "craft", "制作木板");
    return craftTask(recipe, "wood-and-table", facts, newId, Math.max(1, Math.ceil((4 - planks) / recipe.output.count)));
  }
  return null;
}

function stoneTools(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  // A crafted table in the backpack must be placed before a 3x3 recipe can
  // consume materials. Otherwise the planner might ask for sticks first and
  // discover only afterwards that the table is still not in reach.
  const table = ensureTable(facts, "stone-tools", newId);
  if (table !== null) {
    return placeOrBuildTable(table, facts, newId);
  }
  // Never ask for a tier the body has already surpassed. The previous
  // `hasItem(wooden_pickaxe)` check stranded a body carrying only a stone or
  // iron pickaxe: it demanded a wooden downgrade, needed logs for it, and
  // then failed every replan because no log was nearby.
  if (pickaxeTier(facts) < 1) {
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
  if (oakLeaves !== null) {
    // No trunk is reachable, but a canopy is. This is the last land-food
    // chance; a failed pickup still leaves the body somewhere new, and the
    // runtime's bounded backoff prevents a tight retry loop.
    return {
      id: `task:${newId()}`,
      stage: "food",
      kind: "gather",
      title: "打落橡树叶寻找苹果",
      skill: skill("mine_block", { block: oakLeaves.id, count: 48 }, newId),
      preconditions: ["oak leaves are nearby", "no reachable oak trunk"],
      expectedEvidence: ["oak leaves are broken", "the leaf drop table may produce an apple"],
      verify: (next) =>
        next.foodAcquired === true ||
        next.inventory.some((slot) => FOOD_ITEMS.test(slot.item)),
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
  const hasBed =
    facts.inventory.some((slot) => BED_ITEMS.test(slot.item)) ||
    nearbyHas(facts, BED_ITEMS) !== null;
  if (!hasBed) {
    const recipe = queryRecipe("minecraft:white_bed");
    if (recipe === null) return blocked("shelter", "craft", "制作床");
    const missing = missingForRecipe(recipe, facts);
    const woolMissing = missing.find((entry) => /_wool$/u.test(entry.item ?? ""));
    if (woolMissing !== undefined) {
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
      // A wool shortage is not a dead end when no sheep is in the bounded
      // observation. Search a new area, then re-plan from the new facts.
      // A forest can be empty of sheep for a long time. The generic 8–16
      // block sweep kept the body orbiting the same clearing; a bed needs a
      // real trip to a new biome, so use the same longer, steady heading as
      // the animal hunt instead of re-observing the same trees.
      return explore(facts, "shelter", "寻找绵羊", "羊", woolMissing.count ?? 2, newId, 24, 40, true);
    }
    return missing.length === 0
      ? craftTask(recipe, "shelter", facts, newId)
      : blockedWith("shelter", "craft", "制作床", missing);
  }
  if (facts.sleeping === true) return null;
  if (isNight(facts) === false) {
    return blockedWith("shelter", "interact", "等待夜晚后睡觉", [
      { kind: "resource", detail: "白天无法睡觉；先继续准备铁器或等待入夜" },
    ]);
  }
  if (nearbyHas(facts, BED_ITEMS) === null) {
    return {
      id: `task:${newId()}`,
      stage: "shelter",
      kind: "place",
      title: "放置床",
      skill: skill("place_block", {
        block: facts.inventory.find((slot) => BED_ITEMS.test(slot.item))?.item ?? "minecraft:white_bed",
        count: 1,
      }, newId),
      preconditions: ["a bed is in inventory", "a safe two-block space exists"],
      expectedEvidence: ["nearbyBlocks contains a bed"],
      verify: (next) => nearbyHas(next, BED_ITEMS) !== null,
    };
  }
  return {
    id: `task:${newId()}`,
    stage: "shelter",
    kind: "interact",
    title: "睡到第二天",
    skill: skill("sleep", {}, newId),
    preconditions: ["night time", "bed is nearby"],
    expectedEvidence: ["sleeping is confirmed", "day advances"],
    verify: (next) => next.sleeping === true || (next.day ?? 0) > (facts.day ?? 0),
  };
}

function iron(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  const table = ensureTable(facts, "iron", newId);
  if (table !== null) return table;
  if (!hasItem(facts, "minecraft:furnace") && !hasStation(facts, "furnace")) {
    const recipe = queryRecipe("minecraft:furnace");
    if (recipe === null) return blocked("iron", "craft", "制作熔炉");
    const missing = missingForRecipe(recipe, facts);
    if (missing.length === 0) return craftTask(recipe, "iron", facts, newId);
    const prerequisite = craftWithPrerequisite(recipe, "iron", facts, newId, "制作熔炉");
    if ("skill" in prerequisite) return prerequisite;
    return missing.some((entry) => entry.kind === "station")
      ? prerequisite
      : explore(facts, "iron", "寻找熔炉材料", "圆石", 8, newId);
  }
  if (inventoryCount(facts, "minecraft:raw_iron") < 3 && inventoryCount(facts, "minecraft:iron_ingot") < 3) {
    const ore = nearbyHas(facts, /iron_ore$/u);
    if (ore === null) {
      return explore(facts, "iron", "寻找铁矿石", "铁矿石", 3, newId);
    }
    return {
      id: `task:${newId()}`,
      stage: "iron",
      kind: "mine",
      title: "挖 3 块铁矿石",
      skill: skill("mine_block", { block: ore.id, count: 3 }, newId),
      preconditions: ["stone pickaxe or better", "iron ore nearby"],
      expectedEvidence: ["raw_iron count reaches 3"],
      verify: (next) => inventoryCount(next, "minecraft:raw_iron") >= 3,
    };
  }
  if (inventoryCount(facts, "minecraft:iron_ingot") < 3) {
    const recipe = smeltingFor("minecraft:iron_ingot").find((entry) => entry.station === "furnace");
    if (recipe === undefined) return blocked("iron", "smelt", "熔炼铁锭");
    return {
      id: `task:${newId()}`,
      stage: "iron",
      kind: "smelt",
      title: "熔炼 3 个铁锭",
      skill: skill("use_block", { block: "minecraft:furnace" }, newId),
      preconditions: ["furnace in reach", "fuel available", "raw iron in inventory"],
      expectedEvidence: ["iron_ingot count increases"],
      verify: (next) => inventoryCount(next, "minecraft:iron_ingot") > inventoryCount(facts, "minecraft:iron_ingot"),
    };
  }
  if (!hasItem(facts, "minecraft:iron_pickaxe")) {
    const recipe = queryRecipe("minecraft:iron_pickaxe");
    if (recipe === null) return blocked("iron", "craft", "制作铁镐");
    const missing = missingForRecipe(recipe, facts);
    return missing.length === 0
      ? craftTask(recipe, "iron", facts, newId)
      : craftWithPrerequisite(recipe, "iron", facts, newId, "制作铁镐");
  }
  return null;
}

function nether(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  const table = ensureTable(facts, "nether", newId);
  if (table !== null) return table;
  if (!hasAny(facts, ["minecraft:diamond_pickaxe", "minecraft:netherite_pickaxe"])) {
    const recipe = queryRecipe("minecraft:diamond_pickaxe");
    if (recipe === null) return blocked("nether", "craft", "制作钻石镐");
    const missing = missingForRecipe(recipe, facts);
    if (missing.length === 0) return craftTask(recipe, "nether", facts, newId);
    const prerequisite = craftWithPrerequisite(recipe, "nether", facts, newId, "制作钻石镐");
    if ("skill" in prerequisite) return prerequisite;
    const diamond = missing.find((entry) => /diamond$/u.test(entry.item ?? ""));
    return diamond === undefined
      ? prerequisite
      : explore(facts, "nether", "寻找钻石矿石", "钻石矿石", 3, newId);
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
  const baseAngle =
    ((hash % 360) + (steady ? 0 : Math.trunc(origin.x) * 7 + Math.trunc(origin.z) * 13) + clock * 45) %
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
 * 3x3 recipes need a reachable table. A table in the inventory is not enough:
 * re-planning from the world must produce a place task rather than hand the
 * body a craft it cannot complete.
 */
function ensureTable(
  facts: WorldFacts,
  stage: GoalId,
  newId: () => string,
): Task | BlockedTask | null {
  if (hasStation(facts, "crafting_table")) return null;
  /**
   * A table on a tree platform or across a ravine can be visible in the
   * snapshot while having no legal route. Walking at it forever is the
   * failure mode the operator sees as a frozen body. When the body carries
   * the wood for a replacement, make a fresh table here instead.
   */
  if (!hasItem(facts, "minecraft:crafting_table") && facts.craftingTablePlaced === true) {
    const table = facts.craftingTable;
    const position = facts.position;
    const distance =
      table === undefined || table === null || position === undefined || position === null
        ? null
        : Math.hypot(table.x - position.x, table.y - position.y, table.z - position.z);
    if (facts.craftingTableNearby !== true && distance !== null && distance > 12) {
      const recipe = queryRecipe("minecraft:crafting_table");
      if (recipe !== null) {
        const replacement = craftWithPrerequisite(
          recipe,
          stage,
          facts,
          newId,
          "制作备用工作台",
        );
        if ("skill" in replacement) return replacement;
      }
    }
  }
  // A table the body already placed is a known station. Do not demand a
  // second table simply because the agent walked away. If its exact position
  // is known, walk back first so the 3x3 craft has a real station in reach.
  // The body's craft skill will walk to its remembered table itself; a
  // separate goto would only arrive at the block's own cell and leave the
  // menu out of reach.
  if (!hasItem(facts, "minecraft:crafting_table")) {
    if (facts.craftingTablePlaced === true) {
      // The table exists in the world and the body remembers where it is.
      // There is nothing for the planner to build; the craft skill owns the
      // walk back to the station.
      return null;
    }
    // A 3x3 product in the backpack proves that this run already owned a
    // usable table. After a reconnect the session coordinate is gone, so do
    // not send the body back to the wood stage merely because the table is
    // out of the snapshot's observation range.
    if (hasCraftingTableProduct(facts)) return null;
    return blockedWith(stage, "craft", "制作工作台", [
      { kind: "station", item: "minecraft:crafting_table", detail: "3×3 配方需要工作台" },
    ]);
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
    if (canMine(tool.item, block)) return null;
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
