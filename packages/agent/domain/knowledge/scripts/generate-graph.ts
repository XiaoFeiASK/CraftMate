import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds the embedded typed knowledge graph from the two misode/mcmeta tags.
 * The generator is build-time only; the Agent never runs a graph database or
 * a retrieval service.
 *
 *   CRAFTMATE_SUMMARY_DIR=/path/to/1.20.1-summary \
 *   CRAFTMATE_MCMETA_DIR=/path/to/1.20.1-data-json \
 *   node --experimental-strip-types scripts/generate-graph.ts
 */
const SUMMARY_DIR = process.env["CRAFTMATE_SUMMARY_DIR"] ?? "";
const DATA_DIR = process.env["CRAFTMATE_MCMETA_DIR"] ?? "";
const KNOWLEDGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT = join(KNOWLEDGE_DIR, "generated", "graph.json");
const TRADE_OVERRIDES = join(KNOWLEDGE_DIR, "overrides", "trades.json");

if (SUMMARY_DIR === "" || DATA_DIR === "") {
  throw new Error(
    "CRAFTMATE_SUMMARY_DIR and CRAFTMATE_MCMETA_DIR are required; the graph is generated offline from a pinned mcmeta checkout",
  );
}

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
type NodeKind =
  | "item"
  | "block"
  | "entity"
  | "structure"
  | "dimension"
  | "station"
  | "capability"
  | "action";
type EdgeType =
  | "produce"
  | "consume"
  | "drop"
  | "loot"
  | "trade"
  | "harvest"
  | "tool"
  | "location"
  | "capability"
  | "alternative";

interface KnowledgeNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly key: string;
  readonly label?: string;
  readonly obtainable?: boolean;
  readonly creativeOnly?: boolean;
  readonly reason?: string;
  readonly variants?: Readonly<Record<string, string>>;
}

interface KnowledgeEdge {
  readonly from: string;
  readonly to: string;
  readonly type: EdgeType;
  readonly group: "AND" | "OR";
  readonly quantity: number;
  readonly conditions: readonly string[];
  readonly cost: number;
  readonly risk: "none" | "low" | "medium" | "high";
  readonly probability: number;
  readonly evidence: readonly string[];
}

interface RegistryData {
  readonly item: readonly string[];
  readonly block: readonly string[];
  readonly entity_type: readonly string[];
  readonly dimension: readonly string[];
}

interface GeneratedRecipe {
  readonly id: string;
  readonly type: "crafting_shaped" | "crafting_shapeless";
  readonly station: "inventory" | "crafting_table";
  readonly grid: 2 | 3;
  readonly ingredients: readonly {
    readonly choices: readonly string[];
    readonly count: number;
  }[];
  readonly output: { readonly item: string; readonly count: number };
}

interface GeneratedSmelting {
  readonly id: string;
  readonly station: "furnace" | "blast_furnace" | "smoker" | "campfire";
  readonly input: { readonly choices: readonly string[]; readonly count: number };
  readonly output: { readonly item: string; readonly count: number };
}

interface GeneratedDrop {
  readonly item: string;
  readonly min: number;
  readonly max: number;
}

interface GeneratedToolRequirement {
  readonly block: string;
  readonly tool: string;
  readonly minimumTier: string;
}

interface TradeOverride {
  readonly id: string;
  readonly profession: string;
  readonly level: number;
  readonly takes: { readonly item: string; readonly count: number };
  readonly gives: { readonly item: string; readonly count: number };
  readonly source: string;
  readonly reviewer: string;
  readonly reviewedAt: string;
}

const nodes = new Map<string, KnowledgeNode>();
const edges: KnowledgeEdge[] = [];
const producedBy = new Map<string, string[]>();

const registries = readJson<Record<string, readonly string[]>>(
  join(SUMMARY_DIR, "registries/data.json"),
);
const version = readJson<{
  readonly id: string;
  readonly data_version: number;
  readonly build_time: string;
}>(join(SUMMARY_DIR, "version.json"));
const recipes = readJson<{ readonly recipes: readonly GeneratedRecipe[] }>(
  join(KNOWLEDGE_DIR, "generated/recipes.json"),
).recipes;
const smelting = readJson<{ readonly recipes: readonly GeneratedSmelting[] }>(
  join(KNOWLEDGE_DIR, "generated/smelting.json"),
).recipes;
const blockDrops = readJson<{
  readonly blocks: readonly { readonly block: string; readonly drops: readonly GeneratedDrop[] }[];
}>(join(KNOWLEDGE_DIR, "generated/block-drops.json")).blocks;
const entityDrops = readJson<{
  readonly entities: readonly { readonly entity: string; readonly drops: readonly GeneratedDrop[] }[];
}>(join(KNOWLEDGE_DIR, "generated/entity-drops.json")).entities;
const toolTiers = readJson<{
  readonly blocks: readonly GeneratedToolRequirement[];
}>(join(KNOWLEDGE_DIR, "generated/tool-tiers.json")).blocks;

const registry: RegistryData = {
  item: registries["item"] ?? [],
  block: registries["block"] ?? [],
  entity_type: registries["entity_type"] ?? [],
  dimension: registries["dimension"] ?? [],
};

const creativeOnly = new Set([
  "air",
  "barrier",
  "bedrock",
  "budding_amethyst",
  "bundle",
  "chain_command_block",
  "command_block",
  "command_block_minecart",
  "debug_stick",
  "end_portal_frame",
  "jigsaw",
  "knowledge_book",
  "light",
  "petrified_oak_slab",
  "player_head",
  "reinforced_deepslate",
  "repeating_command_block",
  "spawner",
  "structure_block",
  "structure_void",
]);
const spawnEggPattern = /_spawn_egg$/u;
const variantItems: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  potion: { kind: "potion", effects: "structured potion id + amplifier + duration" },
  splash_potion: { kind: "potion", delivery: "splash", effects: "structured potion id" },
  lingering_potion: { kind: "potion", delivery: "lingering", effects: "structured potion id" },
  tipped_arrow: { kind: "potion", delivery: "arrow", effects: "structured potion id" },
  enchanted_book: { kind: "enchantment", stored: "structured enchantment list" },
  filled_map: { kind: "map", scale: "structured", dimension: "structured" },
  goat_horn: { kind: "instrument", instrument: "registry id" },
  shield: { kind: "banner", pattern: "structured banner layers" },
};

for (const id of registry.item) {
  const key = `minecraft:${id}`;
  const creative = creativeOnly.has(id) || spawnEggPattern.test(id);
  addNode({
    id: `item:${key}`,
    kind: "item",
    key,
    ...(creative ? { creativeOnly: true, obtainable: false, reason: "creative-only item" } : {}),
    ...(variantItems[id] === undefined ? {} : { variants: variantItems[id] }),
  });
}
for (const id of registry.block) {
  addNode({ id: `block:minecraft:${id}`, kind: "block", key: `minecraft:${id}` });
}
for (const id of registry.entity_type) {
  addNode({ id: `entity:minecraft:${id}`, kind: "entity", key: `minecraft:${id}` });
}
for (const id of registry.dimension) {
  addNode({ id: `dimension:minecraft:${id}`, kind: "dimension", key: `minecraft:${id}` });
}
for (const structure of structureNames()) {
  addNode({ id: `structure:${structure}`, kind: "structure", key: structure });
}
for (const station of [
  "minecraft:crafting_table",
  "minecraft:furnace",
  "minecraft:blast_furnace",
  "minecraft:smoker",
  "minecraft:campfire",
  "minecraft:villager",
  "minecraft:brewing_stand",
  "minecraft:anvil",
  "minecraft:enchanting_table",
  "minecraft:stonecutter",
  "minecraft:smithing_table",
]) {
  addNode({ id: `station:${station}`, kind: "station", key: station });
}
for (const capability of [
  "combat",
  "mine:wood",
  "mine:stone",
  "mine:iron",
  "mine:diamond",
  "mine:netherite",
  "shear",
  "fish",
  "breed",
  "trade",
  "enter:nether",
  "enter:end",
]) {
  addNode({ id: `capability:${capability}`, kind: "capability", key: capability });
}

for (const recipe of recipes) {
  const action = `action:craft:${recipe.id}`;
  addAction(action, `craft ${short(recipe.output.item)}`);
  addEdge(action, `item:${recipe.output.item}`, "produce", "AND", recipe.output.count, [], 1, "none", 1, [
    `recipe ${recipe.id}`,
  ]);
  for (const ingredient of recipe.ingredients) {
    const group = ingredient.choices.length > 1 ? "OR" : "AND";
    for (const choice of ingredient.choices) {
      addEdge(action, `item:${choice}`, "consume", group, ingredient.count, [
        group === "OR" ? "any listed ingredient choice" : "required ingredient",
      ], 1, "none", 1, [`recipe ${recipe.id}`]);
    }
  }
  addEdge(action, `station:${recipe.station === "inventory" ? "minecraft:crafting_table" : "minecraft:crafting_table"}`, "location", "AND", 1, [
    recipe.station === "inventory" ? "2x2 inventory grid" : "3x3 crafting table",
  ], 1, "none", 1, [`recipe ${recipe.id}`]);
}

for (const recipe of smelting) {
  const action = `action:smelt:${recipe.id}`;
  addAction(action, `smelt ${short(recipe.output.item)}`);
  addEdge(action, `item:${recipe.output.item}`, "produce", "AND", recipe.output.count, [], 2, "low", 1, [
    `recipe ${recipe.id}`,
  ]);
  for (const choice of recipe.input.choices) {
    addEdge(action, `item:${choice}`, "consume", recipe.input.choices.length > 1 ? "OR" : "AND", 1, [
      "smelting input",
    ], 1, "none", 1, [`recipe ${recipe.id}`]);
  }
  addEdge(action, `station:minecraft:${recipe.station === "blast_furnace" ? "blast_furnace" : recipe.station === "smoker" ? "smoker" : recipe.station === "campfire" ? "campfire" : "furnace"}`, "location", "AND", 1, [
    "usable cooking station",
  ], 1, "none", 1, [`recipe ${recipe.id}`]);
  addEdge(action, "item:minecraft:coal", "consume", "OR", 1, ["fuel; charcoal/planks/logs also accepted"], 1, "none", 1, [
    "vanilla fuel tag",
  ]);
}

const toolByBlock = new Map(toolTiers.map((entry) => [entry.block, entry]));
for (const entry of blockDrops) {
  const blockKey = entry.block;
  const action = `action:mine:${blockKey}`;
  addAction(action, `mine ${short(blockKey)}`);
  addEdge(`block:${blockKey}`, action, "harvest", "AND", 1, [], 1, "low", 1, ["vanilla block loot table"]);
  const requirement = toolByBlock.get(blockKey);
  if (requirement !== undefined && requirement.tool !== "hand") {
    const tool = toolFor(requirement);
    if (tool !== null) {
      addEdge(action, `item:${tool}`, "tool", "AND", 1, [
        `${requirement.tool} tier >= ${requirement.minimumTier}`,
      ], 1, "none", 1, ["mineable tag + needs_*_tool tag"]);
      addEdge(`item:${tool}`, `capability:mine:${requirement.minimumTier}`, "capability", "AND", 1, [
        "tool equipped",
      ], 1, "none", 1, ["vanilla tool tier rule"]);
      addEdge(action, `capability:mine:${requirement.minimumTier}`, "capability", "AND", 1, [
        "harvest tier available",
      ], 1, "none", 1, ["vanilla tool tier rule"]);
    }
  }
  for (const drop of entry.drops) {
    const chance = drop.max > drop.min ? 0.75 : 1;
    addEdge(action, `item:${drop.item}`, "drop", "OR", drop.min, ["ordinary block break"], 1, "low", chance, [
      "vanilla block loot table",
    ]);
  }
  addBlockLocation(blockKey, action);
}

for (const entry of entityDrops) {
  const entityKey = entry.entity;
  const action = `action:kill:${entityKey}`;
  addAction(action, `kill ${short(entityKey)}`);
  addEdge(`entity:${entityKey}`, action, "harvest", "AND", 1, [], 2, "medium", 1, ["vanilla entity loot table"]);
  addEdge(action, "capability:combat", "capability", "AND", 1, ["weapon or sufficient bare-hand damage"], 1, "medium", 1, [
    "combat capability",
  ]);
  for (const drop of entry.drops) {
    addEdge(action, `item:${drop.item}`, "drop", "OR", drop.min, ["ordinary kill"], 2, "medium", drop.max > drop.min ? 0.75 : 1, [
      "vanilla entity loot table",
    ]);
  }
  addEntityLocation(entityKey, action);
}

for (const [table, structure] of lootTableStructures()) {
  const loot = readLootTable(table);
  if (loot.length === 0) continue;
  const action = `action:loot:${table.replace(/^.*loot_tables\//u, "").replace(/\.json$/u, "")}`;
  addAction(action, `loot ${table.split("/").at(-1)?.replace(/\.json$/u, "") ?? table}`);
  addEdge(`structure:${structure}`, action, "loot", "AND", 1, ["find and open container"], 3, "medium", 1, [
    `loot table ${relative(DATA_DIR, table)}`,
  ]);
  for (const drop of loot) {
    addEdge(action, `item:${drop.item}`, "loot", "OR", drop.min, ["container roll"], 3, "medium", drop.max > drop.min ? 0.6 : 1, [
      `loot table ${relative(DATA_DIR, table)}`,
    ]);
  }
}

addFishing();
addPiglinBarter();
addArchaeology();
addFarming();
addShearing();
addSilkTouchAcquisitions();
addSpecialAcquisitions();
addTrades();
addAlternativeEdges();

const graph = finalizeGraph();
mkdirSync(join(KNOWLEDGE_DIR, "generated"), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(graph)}\n`);
console.log(
  `wrote ${graph.counts.nodes} nodes and ${graph.counts.edges} edges ` +
    `(${graph.counts.reachableItems}/${registry.item.length} survival-reachable items) to ${relative(process.cwd(), OUTPUT)}`,
);

function addNode(node: KnowledgeNode): void {
  nodes.set(node.id, node);
}

function addAction(id: string, label: string): void {
  if (!nodes.has(id)) addNode({ id, kind: "action", key: id.replace(/^action:/u, ""), label });
}

function addEdge(
  from: string,
  to: string,
  type: EdgeType,
  group: "AND" | "OR",
  quantity: number,
  conditions: readonly string[],
  cost: number,
  risk: "none" | "low" | "medium" | "high",
  probability: number,
  evidence: readonly string[],
): void {
  if (!nodes.has(from) || !nodes.has(to)) return;
  edges.push({
    from,
    to,
    type,
    group,
    quantity: Math.max(1, quantity),
    conditions,
    cost,
    risk,
    probability: Math.min(1, Math.max(0.01, probability)),
    evidence,
  });
  if (type === "produce" || type === "drop" || type === "loot" || type === "trade") {
    const key = to.replace(/^item:/u, "");
    const list = producedBy.get(key) ?? [];
    if (!list.includes(from)) list.push(from);
    producedBy.set(key, list);
  }
}

function addBlockLocation(block: string, action: string): void {
  const dimension = dimensionFor(block);
  if (dimension !== null) {
    addEdge(action, `dimension:minecraft:${dimension}`, "location", "AND", 1, [], 1, "none", 1, ["vanilla block registry"]);
  }
}

function addEntityLocation(entity: string, action: string): void {
  const dimension = dimensionFor(entity);
  if (dimension !== null) {
    addEdge(action, `dimension:minecraft:${dimension}`, "location", "AND", 1, [], 1, "none", 1, ["vanilla entity registry"]);
  }
}

function dimensionFor(id: string): "the_nether" | "the_end" | "overworld" | null {
  const name = id.replace(/^minecraft:/u, "");
  if (
    /nether|blaze|ghast|piglin|hoglin|strider|magma|quartz|glowstone|soul_|crimson_|warped_|basalt|blackstone|ancient_debris|netherite|wither/u.test(
      name,
    )
  ) {
    return "the_nether";
  }
  if (/end_|end$|chorus|shulker|purpur|dragon|elytra/u.test(name)) return "the_end";
  return "overworld";
}

function toolFor(requirement: GeneratedToolRequirement): string | null {
  if (requirement.tool === "shears") return "minecraft:shears";
  if (requirement.tool === "hand") return null;
  const tier = requirement.minimumTier === "wood" ? "wooden" : requirement.minimumTier;
  if (!["wooden", "stone", "iron", "golden", "diamond", "netherite"].includes(tier)) return null;
  if (!["pickaxe", "axe", "shovel", "hoe", "sword"].includes(requirement.tool)) return null;
  return `minecraft:${tier}_${requirement.tool}`;
}

function short(id: string): string {
  return id.replace(/^minecraft:/u, "");
}

function structureNames(): string[] {
  const dir = join(DATA_DIR, "data/minecraft/worldgen/structure_set");
  const names = new Set<string>();
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    names.add(`minecraft:${entry.replace(/\.json$/u, "")}`);
  }
  for (const extra of [
    "minecraft:village",
    "minecraft:monster_room",
    "minecraft:stronghold",
    "minecraft:ancient_city",
    "minecraft:bastion_remnant",
    "minecraft:fortress",
    "minecraft:end_city",
    "minecraft:shipwreck",
    "minecraft:buried_treasure",
    "minecraft:trail_ruins",
    "minecraft:ocean_ruin",
  ]) {
    names.add(extra);
  }
  return [...names].sort();
}

function lootTableStructures(): Array<[string, string]> {
  const root = join(DATA_DIR, "data/minecraft/loot_tables");
  const files = walk(root).filter((path) => /\/chests\//u.test(path) && path.endsWith(".json"));
  return files.map((path) => {
    const name = relative(join(root, "chests"), path).replace(/\.json$/u, "");
    return [path, chestStructure(name)] as [string, string];
  });
}

function chestStructure(name: string): string {
  if (name.startsWith("village/")) return "minecraft:village";
  if (/ancient_city/u.test(name)) return "minecraft:ancient_city";
  if (/bastion/u.test(name)) return "minecraft:bastion_remnant";
  if (/nether_bridge|fortress/u.test(name)) return "minecraft:fortress";
  if (/end_city/u.test(name)) return "minecraft:end_city";
  if (/stronghold/u.test(name)) return "minecraft:stronghold";
  if (/shipwreck/u.test(name)) return "minecraft:shipwreck";
  if (/buried_treasure/u.test(name)) return "minecraft:buried_treasure";
  if (/pillager_outpost/u.test(name)) return "minecraft:pillager_outpost";
  if (/woodland_mansion/u.test(name)) return "minecraft:woodland_mansion";
  if (/ocean_ruin|underwater_ruin/u.test(name)) return "minecraft:ocean_ruin";
  if (/desert_pyramid|jungle_temple|igloo|witch_hut/u.test(name)) return "minecraft:monster_room";
  if (/mineshaft/u.test(name)) return "minecraft:mineshaft";
  if (/ruined_portal/u.test(name)) return "minecraft:ruined_portal";
  return "minecraft:monster_room";
}

function addFishing(): void {
  const root = join(DATA_DIR, "data/minecraft/loot_tables/gameplay/fishing");
  const action = "action:fish";
  addAction(action, "fish");
  addEdge(action, "capability:fish", "capability", "AND", 1, ["fishing rod"], 2, "low", 1, ["vanilla fishing"]);
  addEdge(action, "item:minecraft:fishing_rod", "tool", "AND", 1, ["fishing rod equipped"], 1, "none", 1, [
    "vanilla fishing",
  ]);
  for (const [file, probability] of [
    ["fish.json", 0.85],
    ["junk.json", 0.1],
    ["treasure.json", 0.05],
  ] as const) {
    const path = join(root, file);
    try {
      for (const drop of readLootTable(path)) {
        addEdge(action, `item:${drop.item}`, "produce", "OR", drop.min, ["fishing roll"], 2, "low", probability, [
          `loot table gameplay/fishing/${file}`,
        ]);
      }
    } catch {
      // A future data tag may rename a pool; the other pools still publish.
    }
  }
}

function addPiglinBarter(): void {
  const path = join(DATA_DIR, "data/minecraft/loot_tables/gameplay/piglin_bartering.json");
  const action = "action:barter:piglin";
  addAction(action, "piglin barter");
  addEdge("entity:minecraft:piglin", action, "trade", "AND", 1, ["throw gold ingot"], 3, "medium", 1, [
    "loot table gameplay/piglin_bartering",
  ]);
  addEdge(action, "item:minecraft:gold_ingot", "consume", "AND", 1, ["barter cost"], 1, "none", 1, [
    "vanilla barter",
  ]);
  for (const drop of readLootTable(path)) {
    addEdge(action, `item:${drop.item}`, "trade", "OR", drop.min, ["barter roll"], 3, "medium", drop.max > drop.min ? 0.5 : 1, [
      "loot table gameplay/piglin_bartering",
    ]);
  }
}

function addArchaeology(): void {
  const root = join(DATA_DIR, "data/minecraft/loot_tables/archaeology");
  for (const path of walk(root)) {
    if (!path.endsWith(".json")) continue;
    const name = relative(root, path).replace(/\.json$/u, "");
    const structure = /trail_ruins/u.test(name)
      ? "minecraft:trail_ruins"
      : /ocean_ruin/u.test(name)
        ? "minecraft:ocean_ruin"
        : "minecraft:desert_pyramid";
    const action = `action:archaeology:${name}`;
    addAction(action, `brush ${name}`);
    addEdge(`structure:${structure}`, action, "loot", "AND", 1, ["suspicious sand/gravel", "brush"], 3, "medium", 1, [
      `loot table archaeology/${name}`,
    ]);
    addEdge(action, "item:minecraft:brush", "tool", "AND", 1, ["brush equipped"], 1, "none", 1, ["vanilla archaeology"]);
    for (const drop of readLootTable(path)) {
      addEdge(action, `item:${drop.item}`, "loot", "OR", drop.min, ["brush roll"], 3, "medium", 1, [
        `loot table archaeology/${name}`,
      ]);
    }
  }
}

function addFarming(): void {
  const crops: Array<[string, string | null, string]> = [
    ["minecraft:wheat", "minecraft:wheat_seeds", "farmland"],
    ["minecraft:carrot", "minecraft:carrot", "farmland"],
    ["minecraft:potato", "minecraft:potato", "farmland"],
    ["minecraft:beetroot", "minecraft:beetroot_seeds", "farmland"],
    ["minecraft:pumpkin", "minecraft:pumpkin_seeds", "farmland"],
    ["minecraft:melon_slice", "minecraft:melon_seeds", "farmland"],
    ["minecraft:sugar_cane", "minecraft:sugar_cane", "sand/dirt next to water"],
    ["minecraft:bamboo", "minecraft:bamboo", "dirt/grass"],
    ["minecraft:cocoa_beans", "minecraft:cocoa_beans", "jungle log"],
    ["minecraft:nether_wart", "minecraft:nether_wart", "soul sand"],
  ];
  for (const [crop, seed, station] of crops) {
    if (!nodes.has(`item:${crop}`)) continue;
    const action = `action:farm:${crop}`;
    addAction(action, `farm ${short(crop)}`);
    addEdge(action, `item:${crop}`, "produce", "AND", crop === "minecraft:melon_slice" ? 3 : 1, ["harvest mature crop"], 2, "low", 1, [
      "vanilla crop growth",
    ]);
    if (seed !== null) {
      addEdge(action, `item:${seed}`, "consume", "AND", 1, ["planting seed"], 1, "none", 1, ["vanilla crop growth"]);
    }
    addEdge(action, `block:minecraft:${station.includes("farmland") ? "farmland" : station.includes("sand") ? "sand" : station.includes("jungle") ? "jungle_log" : "soul_sand"}`, "location", "AND", 1, [
      `plant on ${station}`,
    ], 1, "none", 1, ["vanilla crop growth"]);
  }
}

function addShearing(): void {
  const action = "action:shear:minecraft:sheep";
  addAction(action, "shear sheep");
  addEdge("entity:minecraft:sheep", action, "harvest", "AND", 1, ["adult sheep"], 1, "low", 1, ["vanilla shearing"]);
  addEdge(action, "item:minecraft:shears", "tool", "AND", 1, ["shears equipped"], 1, "none", 1, ["vanilla shearing"]);
  addEdge(action, "capability:shear", "capability", "AND", 1, ["shears"], 1, "none", 1, ["vanilla shearing"]);
  for (const color of [
    "white",
    "orange",
    "magenta",
    "light_blue",
    "yellow",
    "lime",
    "pink",
    "gray",
    "light_gray",
    "cyan",
    "purple",
    "blue",
    "brown",
    "green",
    "red",
    "black",
  ]) {
    addEdge(action, `item:minecraft:${color}_wool`, "drop", "OR", 1, ["sheep color"], 1, "low", 1 / 16, [
      "vanilla sheep variants",
    ]);
  }
}

/**
 * Many block items are not ordinary drops. Vanilla still makes them
 * obtainable with silk touch, so the graph must carry that competing source
 * instead of reporting the item as impossible.
 */
function addSilkTouchAcquisitions(): void {
  for (const block of registry.block) {
    const itemId = `minecraft:${block}`;
    if (!nodes.has(`item:${itemId}`)) continue;
    const itemNode = nodes.get(`item:${itemId}`)!;
    if (itemNode.creativeOnly === true) continue;
    if ((producedBy.get(itemId) ?? []).length > 0) continue;
    const action = `action:silk_touch:${itemId}`;
    addAction(action, `silk touch ${short(itemId)}`);
    addEdge(`block:${itemId}`, action, "harvest", "AND", 1, ["silk touch enchanting"], 3, "low", 1, [
      "vanilla silk touch rule",
    ]);
    addEdge(action, `item:${itemId}`, "produce", "AND", 1, ["silk touch enchantment"], 3, "low", 1, [
      "vanilla silk touch rule",
    ]);
    addEdge(action, "item:minecraft:diamond_pickaxe", "tool", "OR", 1, [
      "any pickaxe with silk touch",
    ], 1, "none", 1, ["vanilla enchantment"]);
    addEdge(action, "item:minecraft:enchanted_book", "tool", "OR", 1, [
      "silk touch enchanted book on an anvil",
    ], 1, "none", 1, ["vanilla enchantment"]);
  }
}

/**
 * Sources that vanilla implements in code rather than a block/entity loot
 * table: bucket captures, mob equipment, boss drops, smithing upgrades and a
 * few structure rewards. These are explicit typed actions with evidence so
 * they remain inspectable instead of becoming hand-waved "misc" edges.
 */
function addSpecialAcquisitions(): void {
  for (const [bucketItem, entity] of [
    ["minecraft:cod_bucket", "minecraft:cod"],
    ["minecraft:salmon_bucket", "minecraft:salmon"],
    ["minecraft:pufferfish_bucket", "minecraft:pufferfish"],
    ["minecraft:tropical_fish_bucket", "minecraft:tropical_fish"],
    ["minecraft:axolotl_bucket", "minecraft:axolotl"],
    ["minecraft:tadpole_bucket", "minecraft:tadpole"],
  ] as const) {
    const action = `action:bucket:${entity}`;
    addAction(action, `bucket ${short(entity)}`);
    addEdge(`entity:${entity}`, action, "harvest", "AND", 1, ["water bucket capture"], 2, "low", 1, [
      "vanilla bucket capture",
    ]);
    addEdge(action, "item:minecraft:water_bucket", "consume", "AND", 1, ["water bucket"], 1, "none", 1, [
      "vanilla bucket capture",
    ]);
    addEdge(action, `item:${bucketItem}`, "produce", "AND", 1, [], 1, "none", 1, ["vanilla bucket capture"]);
  }
  addSpecial("minecraft:milk_bucket", ["minecraft:bucket"], ["minecraft:cow"], "milk a cow");
  addSpecial("minecraft:lava_bucket", ["minecraft:bucket"], [], "bucket lava");
  addSpecial("minecraft:powder_snow_bucket", ["minecraft:bucket"], [], "bucket powder snow");
  addSpecial("minecraft:scute", [], ["minecraft:turtle"], "turtle scute growth");
  addSpecial("minecraft:trident", [], ["minecraft:drowned"], "drowned trident drop");
  addSpecial("minecraft:nether_star", [], ["minecraft:wither"], "defeat the wither");
  addSpecial("minecraft:dragon_breath", [], ["minecraft:ender_dragon"], "bottle dragon breath");
  addSpecial("minecraft:elytra", [], [], "end city ship loot", "structure:minecraft:end_city");
  addSpecial("minecraft:enchanted_book", [], [], "enchanting table");
  addSpecial(
    "minecraft:lingering_potion",
    ["minecraft:splash_potion", "minecraft:dragon_breath"],
    [],
    "brew a lingering potion",
  );
  addSpecial("minecraft:written_book", ["minecraft:book", "minecraft:ink_sac"], [], "write a book");
  addSpecial("minecraft:filled_map", ["minecraft:map"], [], "cartographer map");
  addSpecial("minecraft:firework_star", ["minecraft:gunpowder"], [], "craft a firework star");
  addSpecial("minecraft:honeycomb", [], [], "shear a bee nest");
  addSpecial("minecraft:globe_banner_pattern", ["minecraft:emerald"], [], "master cartographer trade", "structure:minecraft:village");
  addSpecial("minecraft:turtle_helmet", ["minecraft:scute"], [], "craft a turtle helmet");
  addSpecial("minecraft:chainmail_helmet", [], [], "equipped zombie/skeleton drop");
  addSpecial("minecraft:chainmail_chestplate", [], [], "equipped zombie/skeleton drop");
  addSpecial("minecraft:chainmail_leggings", [], [], "equipped zombie/skeleton drop");
  addSpecial("minecraft:chainmail_boots", [], [], "equipped zombie/skeleton drop");
  for (const disc of [
    "11",
    "blocks",
    "chirp",
    "far",
    "mall",
    "mellohi",
    "stal",
    "strad",
    "wait",
    "ward",
  ]) {
    addSpecial(`minecraft:music_disc_${disc}`, [], [], "creeper killed by a skeleton arrow");
  }
  const diamondGear = [
    "pickaxe",
    "axe",
    "shovel",
    "hoe",
    "sword",
    "helmet",
    "chestplate",
    "leggings",
    "boots",
  ];
  for (const gear of diamondGear) {
    const action = `action:smith:netherite_${gear}`;
    addAction(action, `smith netherite ${gear}`);
    addEdge(action, `item:minecraft:netherite_${gear}`, "produce", "AND", 1, ["smithing table"], 4, "medium", 1, [
      "vanilla smithing recipe",
    ]);
    addEdge(action, `item:minecraft:diamond_${gear}`, "consume", "AND", 1, [], 1, "none", 1, [
      "vanilla smithing recipe",
    ]);
    addEdge(action, "item:minecraft:netherite_ingot", "consume", "AND", 1, [], 1, "none", 1, [
      "vanilla smithing recipe",
    ]);
    addEdge(action, "station:minecraft:smithing_table", "location", "AND", 1, [], 1, "none", 1, [
      "vanilla smithing recipe",
    ]);
  }
}

function addSpecial(
  item: string,
  consumes: readonly string[],
  entities: readonly string[],
  label: string,
  structure?: string,
): void {
  if (!nodes.has(`item:${item}`)) return;
  const action = `action:special:${item.replace(/^minecraft:/u, "")}`;
  addAction(action, label);
  for (const consumed of consumes) {
    addEdge(action, `item:${consumed}`, "consume", "AND", 1, [label], 1, "none", 1, [label]);
  }
  for (const entity of entities) {
    addEdge(`entity:${entity}`, action, "harvest", "AND", 1, [label], 3, "medium", 1, [label]);
  }
  if (structure !== undefined) {
    addEdge(structure, action, "loot", "AND", 1, [label], 3, "medium", 1, [label]);
  }
  addEdge(action, `item:${item}`, "produce", "AND", 1, [label], 2, "low", 1, [label]);
}

function addTrades(): void {
  const overrides = readJson<{ readonly trades: readonly TradeOverride[] }>(TRADE_OVERRIDES);
  for (const trade of overrides.trades) {
    const action = `action:trade:${trade.id}`;
    addAction(action, `${trade.profession} trade ${short(trade.gives.item)}`);
    addEdge("structure:minecraft:village", action, "trade", "AND", 1, [`${trade.profession} level ${trade.level}`], 3, "medium", 1, [
      trade.source,
    ]);
    addEdge(action, `station:minecraft:villager`, "location", "AND", 1, [trade.profession], 1, "none", 1, [
      trade.source,
    ]);
    addEdge(action, `item:${trade.takes.item}`, "consume", "AND", trade.takes.count, ["trade cost"], 1, "none", 1, [
      trade.source,
    ]);
    addEdge(action, `item:${trade.gives.item}`, "trade", "AND", trade.gives.count, ["trade result"], 3, "medium", 1, [
      `${trade.source} (${trade.reviewer}, ${trade.reviewedAt})`,
    ]);
    addEdge(action, "capability:trade", "capability", "AND", 1, ["villager trade"], 1, "none", 1, [trade.source]);
  }
}

function addAlternativeEdges(): void {
  for (const [item, actions] of producedBy) {
    if (actions.length < 2) continue;
    const sorted = [...actions].sort();
    for (let index = 0; index + 1 < sorted.length; index++) {
      addEdge(sorted[index]!, sorted[index + 1]!, "alternative", "OR", 1, [`competing source for ${item}`], 1, "none", 1, [
        "same output",
      ]);
    }
  }
}

function finalizeGraph() {
  const reachable = reachableItems();
  const obtainable = new Set(reachable.items);
  for (const [id, node] of nodes) {
    if (node.kind !== "item") continue;
    if (node.creativeOnly === true) continue;
    if (obtainable.has(node.key)) {
      nodes.set(id, { ...node, obtainable: true });
    } else {
      nodes.set(id, {
        ...node,
        obtainable: false,
        reason: node.reason ?? "no survival acquisition path from the generated graph",
      });
    }
  }
  for (const gear of [
    "minecraft:iron_pickaxe",
    "minecraft:iron_sword",
    "minecraft:iron_helmet",
    "minecraft:iron_chestplate",
    "minecraft:iron_leggings",
    "minecraft:iron_boots",
  ]) {
    if (!obtainable.has(gear)) throw new Error(`iron acceptance item is unreachable: ${gear}`);
    if ((producedBy.get(gear) ?? []).length === 0) {
      throw new Error(`iron acceptance item has no producing action: ${gear}`);
    }
  }
  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      throw new Error(`dangling graph edge ${edge.from} -> ${edge.to}`);
    }
  }
  if (registry.item.length !== 1255 || registry.block.length !== 1003) {
    throw new Error(
      `unexpected 1.20.1 registry counts: items=${registry.item.length} blocks=${registry.block.length}`,
    );
  }
  if (registry.entity_type.length !== 124 || registry.dimension.length !== 3) {
    throw new Error(
      `unexpected 1.20.1 registry counts: entities=${registry.entity_type.length} dimensions=${registry.dimension.length}`,
    );
  }
  return {
    meta: {
      schemaVersion: 1,
      minecraftVersion: version.id,
      source: "https://github.com/misode/mcmeta",
      summaryTag: "1.20.1-summary",
      dataTag: "1.20.1-data-json",
      dataVersion: version.data_version,
      generatedFrom: version.build_time,
    },
    counts: {
      items: registry.item.length,
      blocks: registry.block.length,
      entities: registry.entity_type.length,
      dimensions: registry.dimension.length,
      structures: [...nodes.values()].filter((node) => node.kind === "structure").length,
      nodes: nodes.size,
      edges: edges.length,
      reachableItems: reachable.items.size,
    },
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges].sort(
      (left, right) =>
        left.from.localeCompare(right.from) ||
        left.type.localeCompare(right.type) ||
        left.to.localeCompare(right.to),
    ),
  };
}

/**
 * Conservative survival closure. An action becomes available when every AND
 * item input is reachable, at least one OR choice is reachable, and its tool
 * item is reachable. Stations are treated as reachable when their block is
 * reachable or they occur naturally; this is intentionally weaker than a
 * live route proof but catches orphan items and missing iron paths.
 */
function reachableItems(): { items: Set<string> } {
  const byAction = new Map<string, KnowledgeEdge[]>();
  for (const edge of edges) {
    const list = byAction.get(edge.from) ?? [];
    list.push(edge);
    byAction.set(edge.from, list);
  }
  const reachable = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of nodes) {
      if (node.kind !== "action") continue;
      const actionEdges = byAction.get(id) ?? [];
      const inputs = actionEdges.filter(
        (edge) => edge.type === "consume" || edge.type === "tool",
      );
      const requirementsMet = [...groupEdges(inputs)].every(([, groupEdges]) =>
        groupEdges.some((edge) => reachable.has(edge.to.replace(/^item:/u, ""))),
      );
      if (!requirementsMet) continue;
      for (const edge of actionEdges) {
        if (!["produce", "drop", "loot", "trade"].includes(edge.type)) continue;
        const item = edge.to.replace(/^item:/u, "");
        if (node.creativeOnly === true) continue;
        if (!reachable.has(item)) {
          reachable.add(item);
          changed = true;
        }
      }
    }
  }
  return { items: reachable };
}

function groupEdges(edgesIn: readonly KnowledgeEdge[]): Map<string, KnowledgeEdge[]> {
  const groups = new Map<string, KnowledgeEdge[]>();
  for (const edge of edgesIn) {
    const key = `${edge.type}:${edge.group}`;
    const list = groups.get(key) ?? [];
    list.push(edge);
    groups.set(key, list);
  }
  return groups;
}

function readLootTable(path: string): GeneratedDrop[] {
  const table = readJson<Json>(path);
  const result = new Map<string, GeneratedDrop>();
  for (const drop of dropsFrom(table, new Set())) {
    const existing = result.get(drop.item);
    result.set(
      drop.item,
      existing === undefined
        ? drop
        : {
            item: drop.item,
            min: Math.min(existing.min, drop.min),
            max: Math.max(existing.max, drop.max),
          },
    );
  }
  return [...result.values()].sort((left, right) => left.item.localeCompare(right.item));
}

function dropsFrom(value: Json, seen: Set<string>): GeneratedDrop[] {
  if (!isRecord(value)) return [];
  const pools = value["pools"];
  if (Array.isArray(pools)) {
    return pools.flatMap((pool) =>
      isRecord(pool) && Array.isArray(pool["entries"])
        ? pool["entries"].flatMap((entry) => dropsFromEntry(entry, seen))
        : [],
    );
  }
  return dropsFromEntry(value, seen);
}

function dropsFromEntry(value: Json, seen: Set<string>): GeneratedDrop[] {
  if (!isRecord(value)) return [];
  if (value["type"] === "minecraft:item" && typeof value["name"] === "string") {
    return [
      {
        item: normalize(value["name"]),
        min: countFromFunctions(value["functions"]),
        max: countFromFunctions(value["functions"]),
      },
    ];
  }
  if (value["type"] === "minecraft:loot_table" && typeof value["name"] === "string") {
    const key = normalize(value["name"]);
    if (seen.has(key)) return [];
    seen.add(key);
    const path = join(DATA_DIR, "data/minecraft/loot_tables", `${key.replace(/^minecraft:/u, "")}.json`);
    try {
      return dropsFrom(readJson<Json>(path), seen);
    } catch {
      return [];
    }
  }
  for (const key of ["children", "entries"]) {
    const children = value[key];
    if (Array.isArray(children)) {
      return children.flatMap((child) => dropsFromEntry(child, seen));
    }
  }
  return [];
}

function countFromFunctions(value: Json | undefined): number {
  if (!Array.isArray(value)) return 1;
  for (const fn of value) {
    if (!isRecord(fn) || fn["function"] !== "minecraft:set_count") continue;
    const count = fn["count"];
    if (typeof count === "number") return Math.max(0, Math.floor(count));
    if (isRecord(count) && count["type"] === "minecraft:uniform") {
      return Math.max(1, Math.floor(typeof count["min"] === "number" ? count["min"] : 1));
    }
  }
  return 1;
}

function normalize(value: string): string {
  return value.includes(":") ? value : `minecraft:${value}`;
}

function isRecord(value: Json | undefined): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function walk(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) result.push(...walk(path));
    else result.push(path);
  }
  return result;
}
