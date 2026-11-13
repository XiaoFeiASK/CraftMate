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
