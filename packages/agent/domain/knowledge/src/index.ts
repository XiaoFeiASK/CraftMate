import blockDropData from "../generated/block-drops.json" with { type: "json" };
import entityDropData from "../generated/entity-drops.json" with { type: "json" };
import recipeData from "../generated/recipes.json" with { type: "json" };
import smeltingData from "../generated/smelting.json" with { type: "json" };
import toolTierData from "../generated/tool-tiers.json" with { type: "json" };
import type {
  BlockDrop,
  BlockToolRequirement,
  CookingRecipe,
  CraftingRecipe,
  DropStack,
  EntityDrop,
  Fuel,
  Ingredient,
  ItemStack,
  KnowledgeMeta,
  ToolInfo,
  ToolTier,
  ToolTiersData,
} from "../scripts/schema.ts";

export type {
  BlockDrop,
  BlockToolRequirement,
  CookingRecipe,
  CraftingRecipe,
  DropStack,
  EntityDrop,
  Fuel,
  Ingredient,
  ItemStack,
  KnowledgeMeta,
  ToolInfo,
  ToolTier,
};

export interface KnowledgeVersion {
  readonly minecraftVersion: string;
  readonly sourceTag: string;
  readonly dataVersion: number;
  readonly schemaVersion: number;
}

export const KNOWLEDGE_VERSION: KnowledgeVersion = {
  minecraftVersion: recipeData.meta.minecraftVersion,
  sourceTag: recipeData.meta.sourceTag,
  dataVersion: recipeData.meta.dataVersion,
  schemaVersion: recipeData.meta.schemaVersion,
};

export const CRAFTING_RECIPES: readonly CraftingRecipe[] =
  recipeData.recipes as readonly CraftingRecipe[];
export const COOKING_RECIPES: readonly CookingRecipe[] =
  smeltingData.recipes as readonly CookingRecipe[];
export const FUELS: readonly Fuel[] = smeltingData.fuels;
export const BLOCK_DROPS: readonly BlockDrop[] = blockDropData.blocks;
export const ENTITY_DROPS: readonly EntityDrop[] = entityDropData.entities;
export const TOOL_TIERS: ToolTiersData = toolTierData as ToolTiersData;

const recipesByOutput = new Map<string, readonly CraftingRecipe[]>();
const cookingByOutput = new Map<string, readonly CookingRecipe[]>();
const blockDropsById = new Map(BLOCK_DROPS.map((entry) => [entry.block, entry]));
const entityDropsById = new Map(ENTITY_DROPS.map((entry) => [entry.entity, entry]));
const toolRequirements = new Map(
  TOOL_TIERS.blocks.map((entry) => [entry.block, entry] as const),
);

for (const recipe of CRAFTING_RECIPES) {
  const list = recipesByOutput.get(recipe.output.item) ?? [];
  recipesByOutput.set(recipe.output.item, [...list, recipe]);
}
for (const recipe of COOKING_RECIPES) {
  const list = cookingByOutput.get(recipe.output.item) ?? [];
  cookingByOutput.set(recipe.output.item, [...list, recipe]);
}

/**
 * Accepts both `minecraft:stone` and `stone`. Unknown namespaces are kept, so
 * a datapack item can be looked up without this package inventing a mapping.
 */
export function normalizeItemId(id: string): string {
  const trimmed = id.trim().toLowerCase();
  if (trimmed.length === 0) return trimmed;
  return trimmed.includes(":") ? trimmed : `minecraft:${trimmed}`;
}

/** All crafting recipes producing `item`, deterministically ordered. */
export function recipesFor(item: string): readonly CraftingRecipe[] {
  return recipesByOutput.get(normalizeItemId(item)) ?? [];
}

/**
 * The preferred recipe for an item: fewer ingredients first, then the 2x2
 * grid, then the stable recipe id. `recipeId` disambiguates dyes/wood variants.
 */
export function queryRecipe(item: string, recipeId?: string): CraftingRecipe | null {
  const recipes = recipesFor(item);
  if (recipeId !== undefined) {
    return recipes.find((recipe) => recipe.id === recipeId) ?? null;
  }
  return recipes.length === 0 ? null : [...recipes].sort(compareRecipes)[0] ?? null;
}

export function compareRecipes(left: CraftingRecipe, right: CraftingRecipe): number {
  // A transformation recipe (dyeing a bed, recoloring wool) consumes another
  // finished item of the same family. It must not outrank the base recipe
  // that builds the item from raw materials. Comparing every craftable input
  // would also flag planks, which are normal building material here.
  const outputFamily = (item: string): string => item.replace(/^.*:/u, "");
  const transformationRank = (recipe: CraftingRecipe): number => {
    const family = outputFamily(recipe.output.item).replace(/^[a-z_]+_/u, "");
    return recipe.ingredients.some((ingredient) =>
      ingredient.choices.some((choice) => {
        const candidate = outputFamily(choice);
        return recipesByOutput.has(choice) && candidate.endsWith(family);
      }),
    )
      ? 1
      : 0;
  };
  const byDependency =
    transformationRank(left) - transformationRank(right);
  if (byDependency !== 0) return byDependency;
  const groupRank = (recipe: CraftingRecipe): number =>
    recipe.group?.endsWith("_dye") === true ? 1 : 0;
  const byGroup = groupRank(left) - groupRank(right);
  if (byGroup !== 0) return byGroup;
  const byGrid = left.grid - right.grid;
  if (byGrid !== 0) return byGrid;
  const byIngredients = left.ingredients.length - right.ingredients.length;
  if (byIngredients !== 0) return byIngredients;
  return left.id.localeCompare(right.id);
}

/** Recipes whose ingredients include `item` (not tags), in stable id order. */
export function recipesUsing(item: string): readonly CraftingRecipe[] {
  const id = normalizeItemId(item);
  return CRAFTING_RECIPES.filter((recipe) =>
    recipe.ingredients.some((ingredient) => ingredient.choices.includes(id)),
  );
}

/** True when `item` is one of the choices of the ingredient. */
export function ingredientMatches(ingredient: Ingredient, item: string): boolean {
  return ingredient.choices.includes(normalizeItemId(item));
}

/** Smelting/furnace recipes producing `item`. */
export function smeltingFor(item: string): readonly CookingRecipe[] {
  return [...(cookingByOutput.get(normalizeItemId(item)) ?? [])].sort((left, right) => {
    const byStation = left.station.localeCompare(right.station);
    return byStation !== 0 ? byStation : left.id.localeCompare(right.id);
  });
}

/** Fuel items ordered by burn time, best first. */
export function fuels(): readonly Fuel[] {
  return [...FUELS].sort((left, right) => right.seconds - left.seconds);
}

export function dropsFor(block: string): readonly DropStack[] {
  return blockDropsById.get(normalizeItemId(block))?.drops ?? [];
}

export function entityDropsFor(entity: string): readonly DropStack[] {
  return entityDropsById.get(normalizeItemId(entity))?.drops ?? [];
}

export function toolRequirement(block: string): BlockToolRequirement | null {
  return toolRequirements.get(normalizeItemId(block)) ?? null;
}

export function toolInfo(item: string): ToolInfo | null {
  return TOOL_TIERS.tools[normalizeItemId(item)] ?? null;
}

/**
 * Minimum block tier required to obtain drops. Blocks that are not in any
 * `mineable` tag require no tool; the generated data marks them as `hand`.
 */
export function requiredTool(block: string): {
  readonly block: string;
  readonly tool: string;
  readonly minimumTier: ToolTier;
} {
  const requirement = toolRequirement(block);
  if (requirement !== null) {
    return {
      block: requirement.block,
      tool: requirement.tool,
      minimumTier: requirement.minimumTier as ToolTier,
    };
  }
  return { block: normalizeItemId(block), tool: "hand", minimumTier: "hand" };
}

/**
 * Minecraft's tier ordering also gates tier-shaped blocks. A gold pickaxe has
 * the rank of wood for harvest checks even though it mines faster.
 */
export function canMine(tool: string | null, block: string): boolean {
  const requirement = requiredTool(block);
  const needed = TOOL_TIERS.ranks[requirement.minimumTier] ?? 0;
  // Blocks with no tier requirement (logs, dirt, crops) drop even bare-handed.
  if (needed === 0) return true;
  if (tool === null) return false;
  const info = toolInfo(tool);
  if (info === null) return false;
  if (info.rank < needed) return false;
  // A tier alone is not enough: stone needs a pickaxe, not an equally ranked axe.
  return requirement.tool === info.type;
}

/** Best tool among the supplied items for the block, or null. */
export function bestToolFor(block: string, items: readonly string[]): string | null {
  const requirement = requiredTool(block);
  const candidates = items
    .map((item) => ({ item: normalizeItemId(item), info: toolInfo(item) }))
    .filter(
      (entry): entry is { item: string; info: ToolInfo } =>
        entry.info !== null &&
        canMine(entry.item, block) &&
        (requirement.tool === "hand" ||
          requirement.tool === "shears" ||
          entry.info.type === requirement.tool),
    )
    .sort((left, right) => {
      const byRank = right.info.rank - left.info.rank;
      return byRank !== 0 ? byRank : left.item.localeCompare(right.item);
    });
  return candidates[0]?.item ?? null;
}

/** Blocks a tool can harvest, ordered by id. Useful for explanations and UIs. */
export function blocksForTool(tool: string): readonly string[] {
  const info = toolInfo(tool);
  if (info === null) return [];
  return TOOL_TIERS.blocks
    .filter((entry) => canMine(tool, entry.block) && entry.tool === info.type)
    .map((entry) => entry.block);
}

export function isFood(item: string): boolean {
  const id = normalizeItemId(item);
  return FOOD_ITEMS.has(id);
}

/**
 * Small, explicit food set used by the survival planner. Prepared/cooked
 * variants are included because they are common P0/P1 supplies; this is a
 * policy list, not a claim that other items are inedible.
 */
const FOOD_ITEMS = new Set([
  "minecraft:apple",
  "minecraft:baked_potato",
  "minecraft:beef",
  "minecraft:beetroot",
  "minecraft:beetroot_soup",
  "minecraft:bread",
  "minecraft:carrot",
  "minecraft:chicken",
  "minecraft:cod",
  "minecraft:cooked_beef",
  "minecraft:cooked_chicken",
  "minecraft:cooked_cod",
  "minecraft:cooked_mutton",
  "minecraft:cooked_porkchop",
  "minecraft:cooked_rabbit",
  "minecraft:cooked_salmon",
  "minecraft:golden_apple",
  "minecraft:golden_carrot",
  "minecraft:honey_bottle",
  "minecraft:mutton",
  "minecraft:porkchop",
  "minecraft:potato",
  "minecraft:pumpkin_pie",
  "minecraft:rabbit",
  "minecraft:salmon",
  "minecraft:sweet_berries",
  "minecraft:tropical_fish",
]);

/** Convenience lookup used by the planner to explain where an item comes from. */
export function sourcesFor(item: string): {
  readonly crafted: readonly CraftingRecipe[];
  readonly smelted: readonly CookingRecipe[];
  readonly droppedByBlocks: readonly string[];
  readonly droppedByEntities: readonly string[];
} {
  const id = normalizeItemId(item);
  return {
    crafted: recipesFor(id),
    smelted: smeltingFor(id),
    droppedByBlocks: BLOCK_DROPS.filter((entry) =>
      entry.drops.some((drop) => drop.item === id),
    ).map((entry) => entry.block),
    droppedByEntities: ENTITY_DROPS.filter((entry) =>
      entry.drops.some((drop) => drop.item === id),
    ).map((entry) => entry.entity),
  };
}
