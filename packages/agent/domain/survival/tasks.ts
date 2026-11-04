import type { SkillCall } from "@craftmate/contracts";
import {
  canMine,
  dropsFor,
  normalizeItemId,
  queryRecipe,
  requiredTool,
  smeltingFor,
  type CraftingRecipe,
} from "../knowledge/src/index.ts";
import {
  countAny,
  hasAny,
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
const BED_ITEMS = /(^|:)[a-z_]+_bed$/u;
const FOOD_ITEMS =
  /(^|:)apple$|(^|:)baked_potato$|(^|:)bread$|(^|:)carrot$|(^|:)potato$|(^|:)beetroot$|(^|:)sweet_berries$|(^|:)melon_slice$|(^|:)cookie$|(^|:)golden_apple$|(^|:)golden_carrot$|(^|:)pumpkin_pie$|(^|:)honey_bottle$|(^|:)(cooked_)?(beef|chicken|cod|mutton|porkchop|rabbit|salmon)$/u;

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

function woodAndTable(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  const tableInInventory = hasItem(facts, "minecraft:crafting_table");
  const tableStation = hasStation(facts, "crafting_table");
  const planks = facts.inventory
    .filter((slot) => /(^|:)[a-z_]+_planks$/u.test(slot.item))
    .reduce((total, slot) => total + slot.count, 0);
  const log = facts.inventory.find((slot) => WOOD_ITEMS.test(slot.item));

  if (!tableInInventory && !tableStation && planks < 4) {
    if (planks > 0) {
      return blockedWith("wood-and-table", "craft", "补齐工作台材料", [
        {
          kind: "material",
          item: "minecraft:oak_planks",
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
    const planksRecipe = queryRecipe("minecraft:oak_planks");
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
  if (planks < 4) {
    const recipe = queryRecipe("minecraft:oak_planks");
    if (recipe === null) return blocked("wood-and-table", "craft", "制作木板");
    return craftTask(recipe, "wood-and-table", facts, newId, Math.max(1, Math.ceil((4 - planks) / recipe.output.count)));
  }
  return null;
}

function stoneTools(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  if (
    hasItem(facts, "minecraft:wooden_pickaxe") &&
    inventoryCount(facts, "minecraft:cobblestone") >= 3
  ) {
    const table = ensureTable(facts, "stone-tools", newId);
    if (table !== null) return table;
  }
  if (!hasItem(facts, "minecraft:wooden_pickaxe")) {
    const pickaxe = queryRecipe("minecraft:wooden_pickaxe");
    if (pickaxe === null) return blocked("stone-tools", "craft", "制作木镐");
    const missing = missingForRecipe(pickaxe, facts);
    if (missing.length > 0) {
      const sticks = queryRecipe("minecraft:stick");
      if (sticks !== null && inventoryCount(facts, "minecraft:stick") < 2) {
        const ingredients = missingForRecipe(sticks, facts);
        if (ingredients.length === 0) {
          return craftTask(sticks, "stone-tools", facts, newId);
        }
      }
      return blockedWith("stone-tools", "craft", "制作木镐", missing);
    }
    const table = ensureTable(facts, "stone-tools", newId);
    return table ?? craftTask(pickaxe, "stone-tools", facts, newId);
  }
  if (inventoryCount(facts, "minecraft:cobblestone") < 3) {
    const nearbyStone = nearbyHas(facts, /(^|:)stone$|(^|:)cobblestone$|(^|:)deepslate$/u);
    if (nearbyStone === null) {
      return blockedWith("stone-tools", "mine", "寻找石头", [
        { kind: "resource", detail: "附近没有可观察到的石头" },
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
    if (missing.length > 0) return blockedWith("stone-tools", "craft", "制作石镐", missing);
    const table = ensureTable(facts, "stone-tools", newId);
    return table ?? craftTask(pickaxe, "stone-tools", facts, newId);
  }
  return null;
}

function foodTask(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  const food = facts.inventory.find((slot) => FOOD_ITEMS.test(slot.item));
  if (food !== undefined) {
    if (facts.food !== undefined && facts.food !== null && facts.food >= 18) {
      return blockedWith("food", "interact", "等待饥饿后再吃", [
        { kind: "resource", detail: `饥饿值 ${facts.food}/20，尚不需要进食` },
      ]);
    }
    return {
      id: `task:${newId()}`,
      stage: "food",
      kind: "interact",
      title: `吃 ${shortName(food.item)}`,
      skill: skill("eat", { item: food.item }, newId),
      preconditions: ["food in inventory", "food level below maximum"],
      expectedEvidence: [`${food.item} count decreases`, "food level increases"],
      verify: (next) => {
        if (next.food !== undefined && next.food !== null) return next.food > (facts.food ?? 0);
        return inventoryCount(next, food.item) < inventoryCount(facts, food.item);
      },
    };
  }
  const cow = nearestEntity(facts, /(^|:)(cow|pig|chicken|sheep|rabbit)$/u, 24);
  if (cow !== null) {
    return {
      id: `task:${newId()}`,
      stage: "food",
      kind: "combat",
      title: `猎取 ${shortName(cow.type)}`,
      skill: skill("attack", { target: cow.type }, newId),
      preconditions: ["passive animal within 24 blocks"],
      expectedEvidence: ["an edible drop enters the inventory"],
      verify: (next) => next.inventory.some((slot) => FOOD_ITEMS.test(slot.item)),
    };
  }
  const wheat = inventoryCount(facts, "minecraft:wheat");
  if (wheat >= 3) {
    const recipe = queryRecipe("minecraft:bread");
    return recipe === null ? blocked("food", "craft", "制作面包") : craftTask(recipe, "food", facts, newId);
  }
  return blockedWith("food", "gather", "寻找食物", [
    { kind: "resource", detail: "背包没有食物，附近也没有可猎取的被动生物" },
  ]);
}

function shelter(facts: WorldFacts, newId: () => string): Task | BlockedTask | null {
  const hasBed =
    facts.inventory.some((slot) => BED_ITEMS.test(slot.item)) ||
    nearbyHas(facts, BED_ITEMS) !== null;
  if (!hasBed) {
    const recipe = queryRecipe("minecraft:white_bed");
    if (recipe === null) return blocked("shelter", "craft", "制作床");
    const missing = missingForRecipe(recipe, facts);
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
      : blockedWith("iron", "craft", "制作熔炉", missing);
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
      : blockedWith("iron", "craft", "制作铁镐", missing);
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
      : blockedWith("nether", "craft", "制作钻石镐", missing);
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
  if (!hasItem(facts, "minecraft:crafting_table")) {
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
