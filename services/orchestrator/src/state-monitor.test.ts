import assert from "node:assert/strict";
import { test } from "node:test";
import { detectStateOpportunity } from "./state-monitor.ts";

const now = 100_000;

function decision(
  skill: string,
  text: string,
  at = now - 5_000,
): {
  readonly text: string;
  readonly at: number;
  readonly skill: { readonly name: string; readonly args: Record<string, unknown> };
} {
  return { text, at, skill: { name: skill, args: {} } };
}

test("a visible iron ore preempts travel to a distant mine", () => {
  const opportunity = detectStateOpportunity({
    stage: "iron",
    decision: decision("goto", "前往固定矿道入口"),
    now,
    lastPreemptAt: 0,
    world: {
      inWorld: true,
      position: { x: 0, y: 40, z: 0 },
      inventory: [
        {
          item: "minecraft:stone_pickaxe",
          count: 1,
          durability: 80,
          slot: 0,
          section: "hotbar" as const,
        },
      ],
      nearbyBlocks: [
        {
          id: "minecraft:iron_ore",
          x: 2,
          y: 40,
          z: 1,
          distance: 3,
          visible: true,
        },
      ],
    },
  });
  assert.equal(opportunity?.key, "visible-iron");
});

test("ore against the current tunnel wall preempts a return-to-surface task", () => {
  const opportunity = detectStateOpportunity({
    stage: "iron",
    decision: decision("goto", "先回到自己的矿道台阶（还差 42 格到地表）"),
    now,
    lastPreemptAt: 0,
    world: {
      inWorld: true,
      position: { x: 164.7, y: 46, z: -156.7 },
      inventory: [
        {
          item: "minecraft:stone_pickaxe",
          count: 1,
          durability: 80,
          slot: 0,
          section: "hotbar" as const,
        },
      ],
      nearbyBlocks: [
        {
          id: "minecraft:iron_ore",
          x: 164,
          y: 48,
          z: -157,
          distance: 0.93,
          visible: true,
          reachable: true,
          exposed: true,
        },
      ],
    },
  });
  assert.equal(opportunity?.key, "visible-iron");
});

test("a full pack does not chase visible ore during a return trip", () => {
  const fullInventory = [
    {
      item: "minecraft:stone_pickaxe",
      count: 1,
      durability: 80,
      slot: 0,
      section: "hotbar" as const,
    },
    ...Array.from({ length: 35 }, (_, index) => ({
      item: "minecraft:cobblestone",
      count: 64,
      slot: index + 1,
      section: "main" as const,
    })),
  ];
  const opportunity = detectStateOpportunity({
    stage: "iron",
    decision: decision("goto", "沿矿道返回地表（还差 115 格）"),
    now,
    lastPreemptAt: 0,
    world: {
      inWorld: true,
      position: { x: 150.44, y: 6, z: -87.52 },
      inventory: fullInventory,
      nearbyBlocks: [
        {
          id: "minecraft:iron_ore",
          x: 151,
          y: 7,
          z: -88,
          distance: 2,
          visible: true,
          reachable: true,
          exposed: true,
        },
      ],
    },
  });
  assert.equal(opportunity, null);
});

test("carried raw iron does not preempt the furnace trip with another ore", () => {
  const opportunity = detectStateOpportunity({
    stage: "iron",
    decision: decision("goto", "回营地熔炼铁锭并制作铁镐"),
    now,
    lastPreemptAt: 0,
    world: {
      inWorld: true,
      position: { x: 158, y: 23, z: -116 },
      inventory: [
        {
          item: "minecraft:stone_pickaxe",
          count: 1,
          durability: 61,
          slot: 0,
          section: "hotbar" as const,
        },
        {
          item: "minecraft:iron_ingot",
          count: 2,
          slot: 1,
          section: "hotbar" as const,
        },
        {
          item: "minecraft:raw_iron",
          count: 52,
          slot: 2,
          section: "hotbar" as const,
        },
      ],
      nearbyBlocks: [
        {
          id: "minecraft:iron_ore",
          x: 156,
          y: 22,
          z: -115,
          distance: 4.24,
          visible: true,
          reachable: true,
          exposed: true,
        },
      ],
    },
  });
  assert.equal(opportunity, null);
});

test("a lost pickaxe cancels a storage trip before it mines bare-handed", () => {
  const opportunity = detectStateOpportunity({
    stage: "stone-tools",
    decision: decision("goto", "回家打开箱子存放物资"),
    now,
    lastPreemptAt: 0,
    world: {
      inWorld: true,
      position: { x: 0, y: 40, z: 0 },
      inventory: [
        { item: "minecraft:oak_log", count: 4, slot: 0, section: "main" as const },
      ],
    },
  });
  assert.equal(opportunity?.key, "tool-recovery");
});

test("an emergency retreat is not replaced by tool recovery", () => {
  const opportunity = detectStateOpportunity({
    stage: "stone-tools",
    decision: {
      text: "低血量撤离 minecraft:spider",
      at: now - 5_000,
      skill: {
        name: "goto",
        args: {
          target: { x: 60, y: 64, z: 40 },
          mode: "walk",
          emergency: true,
        },
      },
    },
    now,
    lastPreemptAt: 0,
    world: {
      inWorld: true,
      position: { x: 0, y: 40, z: 0 },
      inventory: [
        { item: "minecraft:oak_log", count: 4, slot: 0, section: "main" as const },
      ],
    },
  });
  assert.equal(opportunity, null);
});

test("a tool recovery navigation is not re-interrupted", () => {
  const opportunity = detectStateOpportunity({
    stage: "stone-tools",
    decision: decision("goto", "走回工作台"),
    now,
    lastPreemptAt: 0,
    world: {
      inWorld: true,
      position: { x: 0, y: 40, z: 0 },
      inventory: [],
    },
  });
  assert.equal(opportunity, null);
});

test("cooldown and task age prevent preemption thrash", () => {
  const world = {
    inWorld: true,
    position: { x: 0, y: 40, z: 0 },
    inventory: [
      {
        item: "minecraft:stone_pickaxe",
        count: 1,
        durability: 80,
        slot: 0,
        section: "hotbar" as const,
      },
    ],
    nearbyBlocks: [
      {
        id: "minecraft:iron_ore",
        x: 2,
        y: 40,
        z: 1,
        distance: 3,
        visible: true,
      },
    ],
  };
  assert.equal(
    detectStateOpportunity({
      stage: "iron",
      decision: decision("goto", "前往固定矿道入口", now - 1_000),
      now,
      lastPreemptAt: 0,
      world,
    }),
    null,
  );
  assert.equal(
    detectStateOpportunity({
      stage: "iron",
      decision: decision("goto", "前往固定矿道入口"),
      now,
      lastPreemptAt: now - 1_000,
      world,
    }),
    null,
  );
});
