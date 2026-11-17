import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorldFacts } from "../domain/index.ts";
import {
  compileAcquisitionBatch,
  compileAcquisitionChain,
} from "./acquisition-planner.ts";

function facts(overrides: Partial<WorldFacts> = {}): WorldFacts {
  return {
    inWorld: true,
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    stations: ["crafting_table", "furnace"],
    inventory: [],
    ...overrides,
  };
}

test("a craft chain compiles dependencies before the requested tool", () => {
  const compiled = compileAcquisitionChain(
    "minecraft:wooden_pickaxe",
    1,
    facts({
      inventory: [{ item: "minecraft:oak_log", count: 2 }],
    }),
  );
  assert.ok(compiled);
  const items = compiled!.steps.map((step) => step.args["item"] ?? step.args["output"]);
  assert.equal(items.at(-1), "minecraft:wooden_pickaxe");
  assert.ok(items.includes("minecraft:oak_planks"));
  assert.ok(items.includes("minecraft:stick"));
});

test("smelting and crafting share one reserved inventory ledger", () => {
  const compiled = compileAcquisitionChain(
    "minecraft:iron_pickaxe",
    1,
    facts({
      inventory: [
        { item: "minecraft:raw_iron", count: 3 },
        { item: "minecraft:coal", count: 1 },
        { item: "minecraft:stick", count: 2 },
      ],
    }),
  );
  assert.ok(compiled);
  assert.deepEqual(
    compiled!.steps.map((step) => step.skill),
    ["smelt", "craft"],
  );
  assert.equal(compiled!.steps[1]!.args["item"], "minecraft:iron_pickaxe");
});

test("topping up iron ingots smelts raw iron instead of cycling nuggets", () => {
  const compiled = compileAcquisitionChain(
    "minecraft:iron_ingot",
    3,
    facts({
      inventory: [
        { item: "minecraft:iron_ingot", count: 2 },
        { item: "minecraft:raw_iron", count: 3 },
        { item: "minecraft:coal", count: 1 },
      ],
    }),
  );
  assert.ok(compiled);
  assert.deepEqual(
    compiled!.steps.map((step) => step.skill),
    ["smelt"],
  );
  assert.equal(compiled!.steps[0]!.args["input"], "minecraft:raw_iron");
  assert.equal(compiled!.steps[0]!.args["count"], 1);
  assert.equal(compiled!.tree?.kind, "action");
  assert.ok(compiled!.tree?.key.includes("smelt:"));
  assert.ok(compiled!.tree?.key.includes("smelting_raw_iron"));
  assert.ok(
    compiled!.tree?.children.some((child) => child.target === "minecraft:furnace"),
  );
});

test("partial ingots cannot be recycled into the ingots they are meant to become", () => {
  const compiled = compileAcquisitionChain(
    "minecraft:iron_ingot",
    3,
    facts({
      inventory: [{ item: "minecraft:iron_ingot", count: 2 }],
    }),
  );
  assert.equal(compiled, null);
});

test("a missing leaf resource is not invented", () => {
  const compiled = compileAcquisitionChain(
    "minecraft:stone_pickaxe",
    1,
    facts({
      inventory: [{ item: "minecraft:stick", count: 2 }],
    }),
  );
  assert.equal(compiled, null);
});

test("a batch skips unaffordable gear instead of spending the same ingots twice", () => {
  const compiled = compileAcquisitionBatch(
    [
      { item: "minecraft:iron_pickaxe", count: 1 },
      { item: "minecraft:iron_sword", count: 1 },
    ],
    facts({
      inventory: [
        { item: "minecraft:iron_ingot", count: 3 },
        { item: "minecraft:stick", count: 2 },
      ],
    }),
  );
  assert.ok(compiled);
  assert.deepEqual(
    compiled!.steps.map((step) => step.args["item"]),
    ["minecraft:iron_pickaxe"],
  );
});
