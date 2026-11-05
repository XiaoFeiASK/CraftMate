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
} from "./facts.ts";
import type {
  BlockedTask,
  GoalId,
  Missing,
  NearbyBlock,
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

/**
 * Builds the single next executable task for a stage. When no task is ready,
 * returns a blocked description that names the first missing dependency
 * instead of inventing an action.
 */
export function nextTaskForStage(context: TaskContext): Task | BlockedTask | null {
  const { stage, facts, newId } = context;
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
    ) &&
    nearbyHas(facts, WOOD_ITEMS) !== null
  ) {
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
  if (!hasItem(facts, "minecraft:wooden_pickaxe")) {
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
      return blockedWith("stone-tools", "mine", "寻找石头", [
        { kind: "resource", detail: "附近没有可瞄准的石头；存在不等于可挖" },
      ]);
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
  if (!hasItem(facts, "minecraft:stone_pickaxe")) {
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

function foodTask(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  const food = facts.inventory.find((slot) => FOOD_ITEMS.test(slot.item));
  if (food !== undefined) {
    return {
      id: `task:${newId()}`,
      stage: "food",
      kind: "interact",
      title: `吃 ${shortName(food.item)}`,
      skill: skill("eat", { item: food.item }, newId),
      preconditions: ["food in inventory", "edible item selected"],
      // A full hunger bar still counts as a meal in Minecraft: eating a
      // golden apple or a food item at 20/20 is legal. The body must prove
      // the held stack changed; the runtime's completion gate checks the
      // `food_consumed` change independently.
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
  const foodAnimals = /(^|:)(cow|pig|chicken|rabbit|sheep)$/u;
  const nearby = nearestEntity(facts, foodAnimals, 16);
  if (nearby !== null) {
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
  // Fish are food too. A river or ocean start may have no land animal within
  // reach at all; a fish is a legitimate, observable hunt target and lets the
  // body prove a meal instead of blocking the whole survival chain.
  const fish = nearestEntity(facts, /(^|:)(cod|salmon|tropical_fish)$/u, 16);
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
  // There is no visible animal. This is a search, not a dead end: the body's
  // attack task has a bounded radius and will walk to a passive animal it can
  // see, while still proving every hit. The target list mirrors the edible
  // animal families rather than scanning for arbitrary entities.
  return {
    id: `task:${newId()}`,
    stage: "food",
    kind: "combat",
    title: "探索并寻找可猎取的被动生物",
    skill: skill("attack", {
      target: "minecraft:cow",
      targets: ["cow", "pig", "chicken", "rabbit", "sheep"].map((name) => `minecraft:${name}`),
      count: 2,
      radius: 48,
      lethal: true,
      collect: true,
    }, newId),
    preconditions: ["a passive animal exists within the bounded search radius"],
    expectedEvidence: [
      "the body searches for a visible passive animal",
      "the task fails honestly when none is reachable",
    ],
    verify: (next) => next.inventory.some((slot) => FOOD_ITEMS.test(slot.item)),
  };
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
      const sheep = nearestEntity(facts, /(^|:)sheep$/u, 40);
      if (sheep !== null) {
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
    return missing.length === 0
      ? craftTask(recipe, "iron", facts, newId)
      : craftWithPrerequisite(recipe, "iron", facts, newId, "制作熔炉");
  }
  if (inventoryCount(facts, "minecraft:raw_iron") < 3 && inventoryCount(facts, "minecraft:iron_ingot") < 3) {
    const ore = nearbyHas(facts, /iron_ore$/u);
    if (ore === null) {
      return blockedWith("iron", "mine", "寻找铁矿石", [
        { kind: "resource", detail: "附近没有铁矿石；需要下矿或探索" },
      ]);
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
    return missing.length === 0
      ? craftTask(recipe, "nether", facts, newId)
      : craftWithPrerequisite(recipe, "nether", facts, newId, "制作钻石镐");
  }
  if (inventoryCount(facts, "minecraft:obsidian") < 10) {
    const obsidian = nearbyHas(facts, /obsidian$/u);
    if (obsidian === null) {
      return blockedWith("nether", "mine", "寻找黑曜石", [
        { kind: "resource", detail: "附近没有黑曜石；需要寻找岩浆源附近的水流交界" },
      ]);
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
    return craftTask(recipe, "eyes", facts, newId, 12);
  }
  if (inventoryCount(facts, "minecraft:ender_pearl") < 12) {
    const enderman = nearestEntity(facts, /enderman$/u, 32);
    if (enderman === null) {
      return blockedWith("eyes", "combat", "寻找末影人", [
        { kind: "resource", detail: "附近没有末影人；夜晚或下界更有机会" },
      ]);
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
    return blockedWith("dragon", "combat", "确认末影龙位置", [
      { kind: "resource", detail: "末地内没有报告末影龙实体" },
    ]);
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
