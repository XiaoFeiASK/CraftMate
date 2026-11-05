import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_REPO = "https://github.com/misode/mcmeta.git";
const SOURCE_TAG = "1.20.1-data-json";
const OUTPUT_DIR = fileURLToPath(new URL("../generated", import.meta.url));
/**
 * Offline/reproducible escape hatch: point this at an existing checkout of
 * the source tag. The published data still records the canonical repository.
 */
const LOCAL_SOURCE = process.env["CRAFTMATE_MCMETA_DIR"];

interface VersionFile {
  readonly id: string;
  readonly data_version: number;
  readonly build_time: string;
}

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };

interface RawRecipe {
  readonly type?: string;
  readonly group?: string;
  readonly category?: string;
  readonly pattern?: readonly string[];
  readonly key?: Readonly<Record<string, Json>>;
  readonly ingredients?: readonly Json[];
  readonly ingredient?: Json;
  readonly result?: Json;
  readonly cookingtime?: number;
  readonly experience?: number;
}

interface RawLootEntry {
  readonly type?: string;
  readonly name?: string;
  readonly children?: readonly RawLootEntry[];
  readonly entries?: readonly RawLootEntry[];
  readonly conditions?: readonly Json[];
  readonly functions?: readonly Json[];
}

interface RawLootPool {
  readonly rolls?: number | Json;
  readonly entries?: readonly RawLootEntry[];
}

interface RawLootTable {
  readonly pools?: readonly RawLootPool[];
}

interface RawTag {
  readonly values?: readonly Json[];
}

interface Ingredient {
  readonly choices: readonly string[];
  readonly tag?: string;
  readonly count: number;
}

interface ItemStack {
  readonly item: string;
  readonly count: number;
}

interface DropStack {
  readonly item: string;
  readonly min: number;
  readonly max: number;
}

const cloneDir = LOCAL_SOURCE ?? mkdtempSync(join(tmpdir(), "craftmate-mcmeta-"));
if (LOCAL_SOURCE !== undefined) {
  console.log(`using local mcmeta checkout ${LOCAL_SOURCE}`);
} else {
  console.log(`cloning ${SOURCE_REPO}@${SOURCE_TAG}`);
  execFileSync(
    "git",
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      SOURCE_TAG,
      "--filter=blob:none",
      "--sparse",
      SOURCE_REPO,
      cloneDir,
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "git",
    [
      "sparse-checkout",
      "set",
      "data/minecraft/recipe",
      "data/minecraft/recipes",
      "data/minecraft/loot_table",
      "data/minecraft/loot_tables",
      "data/minecraft/tags/item",
      "data/minecraft/tags/items",
      "data/minecraft/tags/block",
      "data/minecraft/tags/blocks",
    ],
    { cwd: cloneDir, stdio: "inherit" },
  );
}

const version = readJson<VersionFile>(join(cloneDir, "version.json"));
mkdirSync(OUTPUT_DIR, { recursive: true });
const meta = {
  schemaVersion: 1,
  minecraftVersion: version.id,
  source: SOURCE_REPO,
  sourceTag: SOURCE_TAG,
  dataVersion: version.data_version,
  generatedFrom: version.build_time,
} as const;

const itemTags = loadTags(sourceDirectory("tags/item", "tags/items"));
const blockTags = loadTags(sourceDirectory("tags/block", "tags/blocks"));
const blockLoot = loadLootTables(sourceDirectory("loot_table/blocks", "loot_tables/blocks"));
const entityLoot = loadLootTables(sourceDirectory("loot_table/entities", "loot_tables/entities"));

const recipes = readJsonFiles<RawRecipe>(sourceDirectory("recipe", "recipes"));
const crafting: Array<{
  id: string;
  type: "crafting_shaped" | "crafting_shapeless";
  station: "inventory" | "crafting_table";
  grid: 2 | 3;
  ingredients: Ingredient[];
  output: ItemStack;
  group: string | null;
}> = [];
const smelting: Array<{
  id: string;
  station: "furnace" | "blast_furnace" | "smoker" | "campfire";
  input: Ingredient;
  output: ItemStack;
  cookingTimeTicks: number;
  experience: number;
}> = [];

for (const [file, recipe] of recipes) {
  const id = `minecraft:${file.replace(/\.json$/u, "")}`;
  const type = recipe.type ?? "";
  if (type === "minecraft:crafting_shaped") {
    const parsed = parseShaped(id, recipe, itemTags);
    if (parsed !== null) crafting.push(parsed);
    continue;
  }
  if (type === "minecraft:crafting_shapeless") {
    const parsed = parseShapeless(id, recipe, itemTags);
    if (parsed !== null) crafting.push(parsed);
    continue;
  }
  const station = stationFor(type);
  if (station === null) continue;
  const input = parseIngredient(recipe.ingredient, itemTags);
  const output = parseResult(recipe.result);
  if (input === null || output === null) continue;
  smelting.push({
    id,
    station,
    input,
    output,
    cookingTimeTicks: recipe.cookingtime ?? 200,
    experience: recipe.experience ?? 0,
  });
}

const blockDrops = [...blockLoot.entries()]
  .map(([block, table]) => ({
    block: `minecraft:${block}`,
    drops: dropsFromTable(table, blockLoot, entityLoot),
  }))
  .filter((entry) => entry.drops.length > 0)
  .sort((left, right) => left.block.localeCompare(right.block));

const entityDrops = [...entityLoot.entries()]
  .map(([entity, table]) => ({
    entity: `minecraft:${entity}`,
    drops: dropsFromTable(table, blockLoot, entityLoot),
  }))
  .filter((entry) => entry.drops.length > 0)
  .sort((left, right) => left.entity.localeCompare(right.entity));

const toolTiers = buildToolTiers(blockTags);

writeData("recipes.json", {
  meta,
  recipes: crafting.sort((left, right) => left.id.localeCompare(right.id)),
});
writeData("smelting.json", {
  meta,
  recipes: smelting.sort((left, right) => left.id.localeCompare(right.id)),
  fuels: [
    { item: "minecraft:lava_bucket", seconds: 1000 },
    { item: "minecraft:coal_block", seconds: 800 },
    { item: "minecraft:dried_kelp_block", seconds: 200 },
    { item: "minecraft:blaze_rod", seconds: 120 },
    { item: "minecraft:coal", seconds: 80 },
    { item: "minecraft:charcoal", seconds: 80 },
    { item: "minecraft:oak_planks", seconds: 15 },
    { item: "minecraft:oak_log", seconds: 15 },
    { item: "minecraft:stick", seconds: 5 },
    { item: "minecraft:oak_sapling", seconds: 5 },
    { item: "minecraft:white_wool", seconds: 5 },
  ],
});
writeData("block-drops.json", { meta, blocks: blockDrops });
writeData("entity-drops.json", { meta, entities: entityDrops });
writeData("tool-tiers.json", { meta, ...toolTiers });

console.log(
  `wrote ${crafting.length} crafting recipes, ${smelting.length} cooking recipes, ` +
    `${blockDrops.length} block drops, ${entityDrops.length} entity drops, ` +
    `${toolTiers.blocks.length} tool-tier blocks to ${relative(process.cwd(), OUTPUT_DIR)}`,
);
if (LOCAL_SOURCE === undefined) rmSync(cloneDir, { recursive: true, force: true });

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sourceDirectory(...paths: string[]): string {
  for (const path of paths) {
    const candidate = join(cloneDir, "data/minecraft", path);
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Upstream datapack directory names changed between Minecraft releases.
    }
  }
  throw new Error(`missing upstream data directory: ${paths.join(" or ")}`);
}

function readJsonFiles<T>(dir: string): Map<string, T> {
  const result = new Map<string, T>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith(".json")) {
        result.set(relative(dir, path), readJson<T>(path));
      }
    }
  };
  walk(dir);
  return result;
}

function loadTags(dir: string): Map<string, RawTag> {
  const tags = new Map<string, RawTag>();
  for (const [file, tag] of readJsonFiles<RawTag>(dir)) {
    tags.set(`#minecraft:${file.replace(/\.json$/u, "")}`, tag);
  }
  return tags;
}

function loadLootTables(dir: string): Map<string, RawLootTable> {
  const result = new Map<string, RawLootTable>();
  for (const [file, table] of readJsonFiles<RawLootTable>(dir)) {
    result.set(file.replace(/\.json$/u, ""), table);
  }
  return result;
}

function normalizeItem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return trimmed;
  return trimmed.includes(":") ? trimmed : `minecraft:${trimmed}`;
}

function resolveTag(tag: string, tags: Map<string, RawTag>, seen = new Set<string>()): string[] {
  const name = tag.startsWith("#") ? tag : `#${tag}`;
  if (seen.has(name)) return [];
  seen.add(name);
  const entry = tags.get(name);
  if (entry === undefined) return [];
  const values = new Set<string>();
  for (const value of entry.values ?? []) {
    if (typeof value !== "string") continue;
    if (value.startsWith("#")) {
      for (const child of resolveTag(value, tags, seen)) values.add(child);
    } else {
      values.add(normalizeItem(value));
    }
  }
  return [...values].sort();
}

function choiceValues(value: Json, tags: Map<string, RawTag>): { choices: string[]; tag?: string } {
  if (typeof value === "string") {
    if (value.startsWith("#")) {
      return { choices: resolveTag(value, tags), tag: normalizeItem(value) };
    }
    return { choices: [normalizeItem(value)] };
  }
  if (Array.isArray(value)) {
    const choices = new Set<string>();
    let tag: string | undefined;
    for (const child of value) {
      const parsed = choiceValues(child, tags);
      for (const choice of parsed.choices) choices.add(choice);
      if (parsed.tag !== undefined) tag = parsed.tag;
    }
    return tag === undefined ? { choices: [...choices].sort() } : { choices: [...choices].sort(), tag };
  }
  if (isRecord(value)) {
    const item = value["item"];
    if (typeof item === "string") return { choices: [normalizeItem(item)] };
    const tag = value["tag"];
    if (typeof tag === "string") {
      const normalized = normalizeItem(tag);
      return { choices: resolveTag(normalized, tags), tag: normalized };
    }
  }
  return { choices: [] };
}

function parseIngredient(value: Json | undefined, tags: Map<string, RawTag>): Ingredient | null {
  if (value === undefined) return null;
  const parsed = choiceValues(value, tags);
  if (parsed.choices.length === 0) return null;
  return {
    choices: parsed.choices,
    ...(parsed.tag === undefined ? {} : { tag: parsed.tag }),
    count: 1,
  };
}

function parseResult(value: Json | undefined): ItemStack | null {
  if (value === undefined) return null;
  if (typeof value === "string") return { item: normalizeItem(value), count: 1 };
  if (Array.isArray(value)) {
    for (const child of value) {
      const parsed = parseResult(child);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const id = value["id"] ?? value["item"];
  if (typeof id !== "string") return null;
  const count = typeof value["count"] === "number" ? value["count"] : 1;
  if (count <= 0) return null;
  return { item: normalizeItem(id), count };
}

function parseShaped(
  id: string,
  recipe: RawRecipe,
  tags: Map<string, RawTag>,
): {
  id: string;
  type: "crafting_shaped";
  station: "inventory" | "crafting_table";
  grid: 2 | 3;
  ingredients: Ingredient[];
  output: ItemStack;
  group: string | null;
} | null {
  const pattern = recipe.pattern ?? [];
  const output = parseResult(recipe.result);
  if (pattern.length === 0 || output === null || recipe.key === undefined) return null;
  const counts = new Map<string, number>();
  for (const row of pattern) {
    for (const symbol of row) {
      if (symbol === " ") continue;
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
  }
  const ingredients: Ingredient[] = [];
  for (const [symbol, count] of counts) {
    const raw = recipe.key[symbol];
    const parsed = parseIngredient(raw, tags);
    if (parsed === null) return null;
    ingredients.push({ ...parsed, count });
  }
  const width = pattern.reduce((max, row) => Math.max(max, row.length), 0);
  const grid = Math.max(pattern.length, width) <= 2 ? 2 : 3;
  return {
    id,
    type: "crafting_shaped",
    station: grid === 2 ? "inventory" : "crafting_table",
    grid,
    ingredients: ingredients.sort((left, right) => left.choices.join(",").localeCompare(right.choices.join(","))),
    output,
    group: recipe.group ?? null,
  };
}

function parseShapeless(
  id: string,
  recipe: RawRecipe,
  tags: Map<string, RawTag>,
): {
  id: string;
  type: "crafting_shapeless";
  station: "inventory" | "crafting_table";
  grid: 2 | 3;
  ingredients: Ingredient[];
  output: ItemStack;
  group: string | null;
} | null {
  const rawIngredients = recipe.ingredients ?? [];
  const output = parseResult(recipe.result);
  if (rawIngredients.length === 0 || output === null) return null;
  const grouped = new Map<string, Ingredient>();
  for (const raw of rawIngredients) {
    const parsed = parseIngredient(raw, tags);
    if (parsed === null) return null;
    const key = parsed.choices.join(",");
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, parsed);
    } else {
      grouped.set(key, { ...existing, count: existing.count + 1 });
    }
  }
  const ingredients = [...grouped.values()];
  const grid = rawIngredients.length <= 4 ? 2 : 3;
  return {
    id,
    type: "crafting_shapeless",
    station: grid === 2 ? "inventory" : "crafting_table",
    grid,
    ingredients: ingredients.sort((left, right) => left.choices.join(",").localeCompare(right.choices.join(","))),
    output,
    group: recipe.group ?? null,
  };
}

function stationFor(type: string): "furnace" | "blast_furnace" | "smoker" | "campfire" | null {
  switch (type) {
    case "minecraft:smelting":
      return "furnace";
    case "minecraft:blasting":
      return "blast_furnace";
    case "minecraft:smoking":
      return "smoker";
    case "minecraft:campfire_cooking":
      return "campfire";
    default:
      return null;
  }
}

function dropsFromTable(
  table: RawLootTable,
  blockLoot: Map<string, RawLootTable>,
  entityLoot: Map<string, RawLootTable>,
): DropStack[] {
  const result = new Map<string, DropStack>();
  for (const pool of table.pools ?? []) {
    for (const entry of pool.entries ?? []) {
      for (const drop of dropsFromEntry(entry, blockLoot, entityLoot, new Set())) {
        const existing = result.get(drop.item);
        if (existing === undefined) {
          result.set(drop.item, drop);
        } else {
          result.set(drop.item, {
            item: drop.item,
            min: Math.min(existing.min, drop.min),
            max: existing.max + drop.max,
          });
        }
      }
    }
  }
  return [...result.values()].sort((left, right) => left.item.localeCompare(right.item));
}

function dropsFromEntry(
  entry: RawLootEntry,
  blockLoot: Map<string, RawLootTable>,
  entityLoot: Map<string, RawLootTable>,
  seen: Set<string>,
): DropStack[] {
  if (isSilkTouchOnly(entry.conditions)) return [];
  if (hasRareChance(entry.conditions)) return [];
  if (entry.type === "minecraft:item" && entry.name !== undefined) {
    const range = countRange(entry.functions);
    return [{ item: normalizeItem(entry.name), min: range.min, max: range.max }];
  }
  if (entry.type === "minecraft:alternatives") {
    const children = entry.children ?? [];
    // `alternatives` is an if/else chain. Try every child, but prefer the
    // deterministic fallback; a fortune-only or shears-only branch is a
    // special case, not the ordinary drop.
    const fallback = children.filter((child) => !isSpecialOnly(child));
    for (const child of fallback.length > 0 ? fallback : children) {
      const drops = dropsFromEntry(child, blockLoot, entityLoot, seen);
      if (drops.length > 0) return drops;
    }
    return [];
  }
  if (entry.type === "minecraft:group") {
    return (entry.children ?? []).flatMap((child) => dropsFromEntry(child, blockLoot, entityLoot, seen));
  }
  if (entry.type === "minecraft:loot_table" && entry.name !== undefined) {
    const name = entry.name.replace(/^minecraft:/u, "");
    const key = name.startsWith("blocks/") ? name.slice("blocks/".length) : name.startsWith("entities/") ? name.slice("entities/".length) : name;
    if (seen.has(key)) return [];
    seen.add(key);
    const table = blockLoot.get(key) ?? entityLoot.get(key);
    return table === undefined ? [] : dropsFromTable(table, blockLoot, entityLoot);
  }
  return [];
}

function isSilkTouchOnly(conditions: readonly Json[] | undefined): boolean {
  if (conditions === undefined) return false;
  return conditions.some((condition) => {
    if (!isRecord(condition) || condition["condition"] !== "minecraft:match_tool") return false;
    return JSON.stringify(condition).includes("silk_touch");
  });
}

function hasRareChance(conditions: readonly Json[] | undefined): boolean {
  if (conditions === undefined) return false;
  return conditions.some((condition) => {
    if (!isRecord(condition)) return false;
    if (condition["condition"] === "minecraft:random_chance") {
      return typeof condition["chance"] === "number" && condition["chance"] < 1;
    }
    // `table_bonus` scales an item's chance with a fortune level; the first
    // entry is the unenchanted chance. Below 1 it is still a special branch.
    if (condition["condition"] === "minecraft:table_bonus") {
      const chances = condition["chances"];
      return !Array.isArray(chances) || typeof chances[0] !== "number" || chances[0] < 1;
    }
    return false;
  });
}

/**
 * Recognizes branches that only apply with a special tool (silk touch or
 * shears) or a non-guaranteed chance. They must not replace the ordinary
 * fallback drop in the generated knowledge base.
 */
function isSpecialOnly(entry: RawLootEntry): boolean {
  if (isSilkTouchOnly(entry.conditions) || hasRareChance(entry.conditions)) return true;
  if (entry.type === "minecraft:group") {
    return (entry.children ?? []).every(isSpecialOnly);
  }
  return false;
}

function countRange(functions: readonly Json[] | undefined): { min: number; max: number } {
  if (functions === undefined) return { min: 1, max: 1 };
  for (const fn of functions) {
    if (!isRecord(fn) || fn["function"] !== "minecraft:set_count") continue;
    const count = fn["count"];
    if (typeof count === "number") return { min: Math.max(0, count), max: Math.max(0, count) };
    if (isRecord(count) && count["type"] === "minecraft:uniform") {
      const min = typeof count["min"] === "number" ? count["min"] : 0;
      const max = typeof count["max"] === "number" ? count["max"] : min;
      return { min: Math.max(0, Math.floor(min)), max: Math.max(0, Math.floor(max)) };
    }
  }
  return { min: 1, max: 1 };
}

function buildToolTiers(blockTags: Map<string, RawTag>): {
  ranks: Record<string, number>;
  tools: Record<string, { type: string; tier: string; rank: number }>;
  blocks: Array<{ block: string; tool: string; minimumTier: string }>;
} {
  const ranks: Record<string, number> = {
    hand: 0,
    wood: 1,
    gold: 1,
    stone: 2,
    iron: 3,
    diamond: 4,
    netherite: 5,
  };
  const tools: Record<string, { type: string; tier: string; rank: number }> = {};
  for (const tier of ["wood", "gold", "stone", "iron", "diamond", "netherite"]) {
    const prefix = tier === "wood" ? "wooden" : tier === "gold" ? "golden" : tier;
    for (const type of ["pickaxe", "axe", "shovel", "hoe", "sword"]) {
      tools[`minecraft:${prefix}_${type}`] = { type, tier, rank: ranks[tier] ?? 0 };
    }
  }
  tools["minecraft:shears"] = { type: "shears", tier: "hand", rank: 0 };
  const toolTypes = ["pickaxe", "axe", "shovel", "hoe", "shears", "sword"];
  const blockTool = new Map<string, string>();
  for (const type of toolTypes) {
    const tag = blockTags.get(`#minecraft:mineable/${type}`);
    if (tag === undefined) continue;
    for (const value of tag.values ?? []) {
      if (typeof value !== "string") continue;
      const blocks = value.startsWith("#") ? resolveTag(value, blockTags) : [normalizeItem(value)];
      for (const block of blocks) {
        if (!blockTool.has(block)) blockTool.set(block, type);
      }
    }
  }
  const needs = new Map<string, string>();
  for (const [tier, tagName] of [
    ["stone", "#minecraft:needs_stone_tool"],
    ["iron", "#minecraft:needs_iron_tool"],
    ["diamond", "#minecraft:needs_diamond_tool"],
  ] as const) {
    const tag = blockTags.get(tagName);
    if (tag === undefined) continue;
    for (const value of tag.values ?? []) {
      if (typeof value !== "string") continue;
      const blocks = value.startsWith("#") ? resolveTag(value, blockTags) : [normalizeItem(value)];
      for (const block of blocks) needs.set(block, tier);
    }
  }
  const blocks = [...blockTool.entries()]
    .map(([block, tool]) => {
      const needed = needs.get(block);
      const minimumTier =
        needed ?? (tool === "pickaxe" ? "wood" : "hand");
      return { block, tool, minimumTier };
    })
    .sort((left, right) => left.block.localeCompare(right.block));
  return { ranks, tools, blocks };
}

function writeData(file: string, value: unknown): void {
  writeFileSync(join(OUTPUT_DIR, file), `${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: Json | undefined): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
