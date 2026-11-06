import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  canMine,
  dropsFor,
  entityDropsFor,
  ENTITY_DROPS,
  KNOWLEDGE_VERSION,
  queryRecipe,
  recipesFor,
  requiredTool,
  smeltingFor,
  sourcesFor,
  bestToolFor,
} from "./index.ts";

describe("knowledge data", () => {
  test("pins the Minecraft data version", () => {
    assert.equal(KNOWLEDGE_VERSION.minecraftVersion, "1.20.1");
    assert.equal(KNOWLEDGE_VERSION.dataVersion, 3465);
    assert.match(KNOWLEDGE_VERSION.sourceTag, /1\.20\.1/u);
  });

  test("resolves at least 20 common survival recipes", () => {
    const items = [
      ["oak_planks", 4],
      ["stick", 4],
      ["crafting_table", 1],
      ["wooden_pickaxe", 1],
      ["stone_pickaxe", 1],
      ["iron_pickaxe", 1],
      ["diamond_pickaxe", 1],
      ["wooden_axe", 1],
      ["stone_axe", 1],
      ["wooden_sword", 1],
      ["stone_sword", 1],
      ["furnace", 1],
      ["white_bed", 1],
      ["chest", 1],
      ["torch", 4],
      ["bread", 1],
      ["bucket", 1],
      ["shield", 1],
      ["ender_eye", 1],
      ["blaze_powder", 2],
      ["iron_ingot", 9],
    ] as const;
    for (const [item, count] of items) {
      const recipe = queryRecipe(item);
      assert.ok(recipe !== null, `missing recipe for ${item}`);
      assert.equal(recipe.output.item, `minecraft:${item}`);
      assert.equal(recipe.output.count, count, `wrong output count for ${item}`);
    }
  });

  test("distinguishes 2x2 and 3x3 recipes and their stations", () => {
    assert.equal(queryRecipe("crafting_table")?.grid, 2);
    assert.equal(queryRecipe("crafting_table")?.station, "inventory");
    assert.equal(queryRecipe("wooden_pickaxe")?.grid, 3);
    assert.equal(queryRecipe("wooden_pickaxe")?.station, "crafting_table");
    const beds = recipesFor("white_bed");
    assert.ok(beds.some((recipe) => recipe.grid === 2 && recipe.station === "inventory"));
    assert.ok(beds.some((recipe) => recipe.grid === 3 && recipe.station === "crafting_table"));
  });

  test("returns deterministic recipes and can select a variant", () => {
    const recipes = recipesFor("white_bed");
    assert.ok(recipes.length > 1);
    const first = queryRecipe("white_bed");
    const second = queryRecipe("white_bed");
    assert.equal(first?.id, second?.id);
    const shaped = recipes.find((recipe) => recipe.type === "crafting_shaped");
    assert.ok(shaped !== undefined);
    assert.equal(queryRecipe("white_bed", shaped.id)?.id, shaped.id);
  });

  test("a base recipe outranks recoloring an existing item", () => {
    const bed = queryRecipe("white_bed");
    assert.ok(bed !== null);
    assert.equal(bed.id, "minecraft:white_bed");
    assert.ok(
      bed.ingredients.some((ingredient) =>
        ingredient.choices.includes("minecraft:white_wool"),
      ),
    );
  });

  test("resolves tag ingredients to concrete items", () => {
    const pickaxe = queryRecipe("wooden_pickaxe");
    assert.ok(pickaxe !== null);
    const material = pickaxe.ingredients.find((entry) => entry.tag === "minecraft:planks");
    assert.ok(material !== undefined);
    assert.ok(material.choices.includes("minecraft:oak_planks"));
    assert.equal(material.count, 3);
  });

  test("maps block drops to their real items", () => {
    assert.deepEqual(dropsFor("stone"), [{ item: "minecraft:cobblestone", min: 1, max: 1 }]);
    assert.deepEqual(dropsFor("iron_ore"), [{ item: "minecraft:raw_iron", min: 1, max: 1 }]);
    assert.deepEqual(dropsFor("diamond_ore"), [{ item: "minecraft:diamond", min: 1, max: 1 }]);
    assert.deepEqual(dropsFor("oak_log"), [{ item: "minecraft:oak_log", min: 1, max: 1 }]);
    assert.deepEqual(dropsFor("white_wool"), [{ item: "minecraft:white_wool", min: 1, max: 1 }]);
  });

  test("ignores special-tool and chance-only loot branches", () => {
    assert.deepEqual(dropsFor("gravel"), [{ item: "minecraft:gravel", min: 1, max: 1 }]);
    assert.deepEqual(dropsFor("oak_leaves"), [
      { item: "minecraft:oak_leaves", min: 1, max: 1 },
    ]);
    assert.ok(!dropsFor("oak_leaves").some((drop) => drop.item === "minecraft:apple"));
  });

  test("maps terminal entity drops", () => {
    assert.ok(entityDropsFor("blaze").some((drop) => drop.item === "minecraft:blaze_rod"));
    assert.ok(entityDropsFor("enderman").some((drop) => drop.item === "minecraft:ender_pearl"));
    assert.ok(entityDropsFor("sheep").some((drop) => drop.item === "minecraft:mutton"));
  });

  test("variant loot tables are folded into the base entity", () => {
    // Sheep publish one loot table per colour. The body only reports
    // `minecraft:sheep`, so the aggregate must carry the wool or the planner
    // concludes that hunting sheep can never make a bed.
    const wool = entityDropsFor("sheep").filter((drop) => /_wool$/u.test(drop.item));
    assert.ok(wool.length >= 16, `expected every colour to drop wool, got ${wool.length}`);
    assert.ok(wool.some((drop) => drop.item === "minecraft:white_wool"));
    assert.ok(!ENTITY_DROPS.some((entry) => entry.entity.includes("/")));
    assert.ok(sourcesFor("white_wool").droppedByEntities.includes("minecraft:sheep"));
  });

  test("applies vanilla tool tier rules", () => {
    assert.deepEqual(requiredTool("stone"), {
      block: "minecraft:stone",
      tool: "pickaxe",
      minimumTier: "wood",
    });
    assert.equal(requiredTool("iron_ore").minimumTier, "stone");
    assert.equal(requiredTool("diamond_ore").minimumTier, "iron");
    assert.equal(requiredTool("obsidian").minimumTier, "diamond");
    assert.equal(requiredTool("ancient_debris").minimumTier, "diamond");
    assert.equal(requiredTool("oak_log").tool, "axe");
  });

  test("canMine respects tier, tool type and hand blocks", () => {
    assert.equal(canMine("minecraft:wooden_pickaxe", "minecraft:stone"), true);
    assert.equal(canMine("minecraft:wooden_pickaxe", "minecraft:iron_ore"), false);
    assert.equal(canMine("minecraft:stone_pickaxe", "minecraft:iron_ore"), true);
    assert.equal(canMine("minecraft:stone_pickaxe", "minecraft:diamond_ore"), false);
    assert.equal(canMine("minecraft:iron_pickaxe", "minecraft:diamond_ore"), true);
    assert.equal(canMine("minecraft:wooden_pickaxe", "minecraft:obsidian"), false);
    assert.equal(canMine("minecraft:diamond_pickaxe", "minecraft:obsidian"), true);
    assert.equal(canMine("minecraft:golden_pickaxe", "minecraft:iron_ore"), false);
    assert.equal(canMine(null, "minecraft:oak_log"), true);
    assert.equal(canMine("minecraft:wooden_pickaxe", "minecraft:oak_log"), true);
    assert.equal(canMine("minecraft:wooden_axe", "minecraft:stone"), false);
  });

  test("bestToolFor chooses a usable tool and rejects the wrong kind", () => {
    assert.equal(
      bestToolFor("minecraft:diamond_ore", [
        "minecraft:stone_pickaxe",
        "minecraft:iron_pickaxe",
        "minecraft:iron_axe",
      ]),
      "minecraft:iron_pickaxe",
    );
    assert.equal(bestToolFor("minecraft:diamond_ore", ["minecraft:stone_pickaxe"]), null);
  });

  test("smelting recipes keep station and time", () => {
    const iron = smeltingFor("iron_ingot");
    const furnace = iron.find(
      (entry) => entry.station === "furnace" && entry.input.choices.includes("minecraft:raw_iron"),
    );
    assert.ok(furnace !== undefined);
    assert.equal(furnace.cookingTimeTicks, 200);
    const blast = iron.find((entry) => entry.station === "blast_furnace");
    assert.ok(blast !== undefined);
    assert.equal(blast.cookingTimeTicks, 100);
  });

  test("explains where terminal items come from", () => {
    const eyes = sourcesFor("ender_eye");
    assert.ok(eyes.crafted.some((recipe) => recipe.output.item === "minecraft:ender_eye"));
    const pearl = sourcesFor("ender_pearl");
    assert.ok(pearl.droppedByEntities.includes("minecraft:enderman"));
    const rod = sourcesFor("blaze_rod");
    assert.ok(rod.droppedByEntities.includes("minecraft:blaze"));
    const iron = sourcesFor("raw_iron");
    assert.ok(iron.droppedByBlocks.includes("minecraft:iron_ore"));
  });

  test("accepts short names and is case-insensitive", () => {
    assert.equal(queryRecipe("STONE_PICKAXE")?.output.item, "minecraft:stone_pickaxe");
    assert.equal(requiredTool("diamond_ore").minimumTier, "iron");
    assert.ok(dropsFor("iron_ore").length > 0);
  });
});
