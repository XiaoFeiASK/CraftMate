import assert from "node:assert/strict";
import { test } from "node:test";
import { compactIncidents, compactMemories, compactWorld } from "./context.ts";

test("incident context keeps the newest few and bounds each detail", () => {
  const incidents = Array.from({ length: 6 }, (_, index) => ({
    kind: index === 0 ? "lava" : "threat",
    detail: "x".repeat(300),
    at: index,
  }));
  const compact = compactIncidents(incidents, 2, 10);

  assert.equal(compact.length, 2);
  assert.equal(compact[0]?.at, 4);
  assert.equal(compact[0]?.detail.length, 10);
});

test("world context keeps scalar facts and bounds backpack arrays", () => {
  const world = {
    inWorld: true,
    health: 18,
    inventory: Array.from({ length: 40 }, (_, index) => ({ slot: index })),
    hotbar: Array.from({ length: 9 }, (_, index) => ({ slot: index })),
  };
  const compact = compactWorld(world, 4) as {
    inWorld: boolean;
    health: number;
    inventory: unknown[];
    hotbar: unknown[];
  };

  assert.equal(compact.inWorld, true);
  assert.equal(compact.health, 18);
  assert.equal(compact.inventory.length, 4);
  assert.equal(compact.hotbar.length, 9);
});

test("memory context caps both count and per-entry length", () => {
  const compact = compactMemories(["a".repeat(500), "b".repeat(500)], 1, 20);
  assert.equal(compact.length, 1);
  assert.equal(compact[0]?.length, 20);
});
