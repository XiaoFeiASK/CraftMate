import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorldFacts } from "../survival/types.ts";
import { planMission } from "./planner.ts";

function facts(overrides: Partial<WorldFacts> = {}): WorldFacts {
  return {
    inWorld: true,
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    inventory: [
      { item: "minecraft:stone_pickaxe", count: 1, durability: 100 },
      { item: "minecraft:iron_sword", count: 1 },
    ],
    ...overrides,
  };
}

test("retreats before continuing iron work when health is critical", () => {
  const mission = planMission({
    facts: facts({
      health: 5,
      entities: [
        {
          name: "Zombie",
          type: "minecraft:zombie",
          distance: 4,
          x: 2,
          y: 64,
          z: 2,
        },
      ],
    }),
    goalTitle: "铁全套与钻石装备",
  });
  assert.equal(mission.kind, "survive");
  assert.equal(mission.utility, 100);
});

test("the iron mission names the next missing equipment piece", () => {
  const mission = planMission({
    facts: facts({
      inventory: [
        { item: "minecraft:iron_pickaxe", count: 1 },
        { item: "minecraft:iron_sword", count: 1 },
      ],
    }),
    goalTitle: "铁全套与钻石装备",
  });
  assert.equal(mission.kind, "iron-set");
  assert.equal(mission.stage, "iron");
  assert.equal(mission.missingEquipment[0]?.item, "minecraft:iron_helmet");
});

test("after the iron set the mission moves to the first three diamonds", () => {
  const mission = planMission({
    facts: facts({
      inventory: [
        { item: "minecraft:iron_pickaxe", count: 1 },
        { item: "minecraft:iron_sword", count: 1 },
        { item: "minecraft:iron_helmet", count: 1 },
        { item: "minecraft:iron_chestplate", count: 1 },
        { item: "minecraft:iron_leggings", count: 1 },
        { item: "minecraft:iron_boots", count: 1 },
      ],
    }),
    goalTitle: "铁全套与钻石装备",
  });
  assert.equal(mission.kind, "diamond-first-3");
  assert.equal(mission.stage, "diamond-gear");
  assert.equal(mission.diamonds, 0);
});

test("three diamonds complete the acceptance mission", () => {
  const mission = planMission({
    facts: facts({
      inventory: [
        { item: "minecraft:iron_pickaxe", count: 1 },
        { item: "minecraft:iron_sword", count: 1 },
        { item: "minecraft:iron_helmet", count: 1 },
        { item: "minecraft:iron_chestplate", count: 1 },
        { item: "minecraft:iron_leggings", count: 1 },
        { item: "minecraft:iron_boots", count: 1 },
        { item: "minecraft:diamond", count: 3 },
      ],
    }),
    goalTitle: "铁全套与钻石装备",
  });
  assert.equal(mission.complete, true);
  assert.equal(mission.kind, "complete");
});

test("a broken tool gate outranks iron progression", () => {
  const mission = planMission({
    facts: facts({
      inventory: [{ item: "minecraft:iron_ingot", count: 4 }],
    }),
    goalTitle: "铁全套与钻石装备",
  });
  assert.equal(mission.kind, "recover-tool");
  assert.equal(mission.stage, "stone-tools");
});
