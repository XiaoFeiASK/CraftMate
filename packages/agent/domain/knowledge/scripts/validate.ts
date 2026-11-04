import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isCount,
  isItemId,
  isKnowledgeMeta,
  isRecord,
  type BlockDrop,
  type CookingRecipe,
  type CraftingRecipe,
  type EntityDrop,
  type Fuel,
  type ToolInfo,
  type ToolTiersData,
} from "./schema.ts";

const DATA_DIR = fileURLToPath(new URL("../generated", import.meta.url));

const read = (file: string): unknown =>
  JSON.parse(readFileSync(`${DATA_DIR}/${file}`, "utf8")) as unknown;

const recipes = read("recipes.json");
const smelting = read("smelting.json");
const blocks = read("block-drops.json");
const entities = read("entity-drops.json");
const tools = read("tool-tiers.json");

for (const dataset of [
  ["recipes.json", recipes],
  ["smelting.json", smelting],
  ["block-drops.json", blocks],
  ["entity-drops.json", entities],
  ["tool-tiers.json", tools],
] as const) {
  const [name, value] = dataset;
  if (!isRecord(value) || !isKnowledgeMeta(value["meta"])) {
    throw new Error(`${name}: missing or invalid meta`);
  }
  if (value["meta"].minecraftVersion !== "1.21.11") {
    throw new Error(`${name}: unexpected Minecraft version ${value["meta"].minecraftVersion}`);
  }
}

const crafting = [...recipeList(recipes), ...cookingList(smelting)];
if (crafting.length < 900) throw new Error(`recipes: only ${crafting.length} rows`);

for (const recipe of [...recipeList(recipes)]) {
  if (!isItemId(recipe.id) || !isItemId(recipe.output.item)) {
    throw new Error(`recipes: invalid id or output in ${recipe.id}`);
  }
  if (!Number.isInteger(recipe.output.count) || recipe.output.count < 1) {
    throw new Error(`recipes: invalid output count in ${recipe.id}`);
  }
  if (recipe.ingredients.length === 0) {
    throw new Error(`recipes: no ingredients in ${recipe.id}`);
  }
  for (const ingredient of recipe.ingredients) {
    if (!isCount(ingredient.count) || ingredient.count < 1 || ingredient.choices.length === 0) {
      throw new Error(`recipes: invalid ingredient in ${recipe.id}`);
    }
    if (!ingredient.choices.every(isItemId)) {
      throw new Error(`recipes: invalid item id in ${recipe.id}`);
    }
  }
}

for (const recipe of cookingList(smelting)) {
  if (recipe.input.choices.length === 0 || !isItemId(recipe.output.item)) {
    throw new Error(`smelting: invalid row ${recipe.id}`);
  }
}

for (const block of blockList(blocks)) {
  if (!isItemId(block.block)) throw new Error(`block-drops: invalid block ${String(block)}`);
  for (const drop of block.drops) {
    if (!isItemId(drop.item) || !isCount(drop.min) || !isCount(drop.max)) {
      throw new Error(`block-drops: invalid drop in ${block.block}`);
    }
  }
}

for (const entity of entityList(entities)) {
  if (!isItemId(entity.entity)) throw new Error(`entity-drops: invalid entity`);
  for (const drop of entity.drops) {
    if (!isItemId(drop.item) || !isCount(drop.min) || !isCount(drop.max)) {
      throw new Error(`entity-drops: invalid drop in ${entity.entity}`);
    }
  }
}

const tiers = tools as ToolTiersData;
if (!isRecord(tiers.ranks) || !isRecord(tiers.tools) || !Array.isArray(tiers.blocks)) {
  throw new Error("tool-tiers: invalid shape");
}
for (const [id, tool] of Object.entries(tiers.tools)) {
  if (!isItemId(id) || !isValidTool(tool)) throw new Error(`tool-tiers: invalid tool ${id}`);
}
for (const block of tiers.blocks) {
  if (
    !isItemId(block.block) ||
    typeof block.tool !== "string" ||
    typeof block.minimumTier !== "string" ||
    !(block.minimumTier in tiers.ranks)
  ) {
    throw new Error(`tool-tiers: invalid block ${JSON.stringify(block)}`);
  }
}

const required = [
  ["wooden_pickaxe", "minecraft:wooden_pickaxe", "crafting_table"],
  ["stone_pickaxe", "minecraft:stone_pickaxe", "crafting_table"],
  ["iron_pickaxe", "minecraft:iron_pickaxe", "crafting_table"],
  ["crafting_table", "minecraft:crafting_table", "inventory"],
  ["stick", "minecraft:stick", "inventory"],
  ["furnace", "minecraft:furnace", "crafting_table"],
  ["white_bed", "minecraft:white_bed", "crafting_table"],
] as const;
for (const [label, item, station] of required) {
  const match = [...recipeList(recipes)].find(
    (recipe) => recipe.output.item === item && recipe.station === station,
  );
  if (match === undefined || match.station !== station) {
    throw new Error(`recipes: missing required ${label}`);
  }
}

const requiredBlocks = [
  ["minecraft:stone", "minecraft:cobblestone"],
  ["minecraft:iron_ore", "minecraft:raw_iron"],
  ["minecraft:diamond_ore", "minecraft:diamond"],
  ["minecraft:oak_log", "minecraft:oak_log"],
] as const;
for (const [block, drop] of requiredBlocks) {
  const row = blockList(blocks).find((entry) => entry.block === block);
  if (row === undefined || !row.drops.some((entry) => entry.item === drop)) {
    throw new Error(`block-drops: missing required ${block} -> ${drop}`);
  }
}

const requiredEntities = [
  ["minecraft:blaze", "minecraft:blaze_rod"],
  ["minecraft:enderman", "minecraft:ender_pearl"],
] as const;
for (const [entity, drop] of requiredEntities) {
  const row = entityList(entities).find((entry) => entry.entity === entity);
  if (row === undefined || !row.drops.some((entry) => entry.item === drop)) {
    throw new Error(`entity-drops: missing required ${entity} -> ${drop}`);
  }
}

const requiredTiers = [
  ["minecraft:stone", "wood"],
  ["minecraft:iron_ore", "stone"],
  ["minecraft:diamond_ore", "iron"],
  ["minecraft:obsidian", "diamond"],
] as const;
for (const [block, tier] of requiredTiers) {
  const row = tiers.blocks.find((entry) => entry.block === block);
  if (row === undefined || row.minimumTier !== tier) {
    throw new Error(`tool-tiers: ${block} should require ${tier}`);
  }
}

console.log(
  `validated ${crafting.length} recipes, ${blockList(blocks).length} block drops, ` +
    `${entityList(entities).length} entity drops, ${tiers.blocks.length} tool-tier blocks`,
);

function recipeList(value: unknown): CraftingRecipe[] {
  if (!isRecord(value) || !Array.isArray(value["recipes"])) throw new Error("recipes: missing list");
  return value["recipes"] as CraftingRecipe[];
}

function cookingList(value: unknown): CookingRecipe[] {
  if (!isRecord(value) || !Array.isArray(value["recipes"])) throw new Error("smelting: missing list");
  return value["recipes"] as CookingRecipe[];
}

function blockList(value: unknown): BlockDrop[] {
  if (!isRecord(value) || !Array.isArray(value["blocks"])) throw new Error("blocks: missing list");
  return value["blocks"] as BlockDrop[];
}

function entityList(value: unknown): EntityDrop[] {
  if (!isRecord(value) || !Array.isArray(value["entities"])) throw new Error("entities: missing list");
  return value["entities"] as EntityDrop[];
}

function isValidTool(value: unknown): value is ToolInfo {
  return (
    isRecord(value) &&
    typeof value["type"] === "string" &&
    typeof value["tier"] === "string" &&
    typeof value["rank"] === "number"
  );
}
