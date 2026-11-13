import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dafeiyu, worldFactsFromSnapshot } from "@craftmate/agent";
import { openDatabase } from "./database.ts";
import { SessionStore } from "./stores.ts";
import { StrategyMemoryStore, WorldMemoryStore } from "./world-memory.ts";

function stores() {
  const db = openDatabase({ file: ":memory:" });
  const context = new SessionStore(db).bootstrap(dafeiyu, "长期生存");
  return {
    db,
    world: new WorldMemoryStore(db, context),
    strategies: new StrategyMemoryStore(db, context),
  };
}

describe("world memory", () => {
  test("repeated observations update one place instead of duplicating it", () => {
    const { world } = stores();
    const first = world.observe({
      kind: "container",
      label: "营地箱子",
      dimension: "minecraft:overworld",
      x: 8,
      y: 70,
      z: 8,
      payload: {},
      confidence: 0.6,
      source: "body",
      observedAt: 1_000,
      expiresAt: null,
    });
    const second = world.observe({
      kind: "container",
      label: "主仓库",
      dimension: "minecraft:overworld",
      x: 8,
      y: 70,
      z: 8,
      payload: {},
      confidence: 0.9,
      source: "body",
      observedAt: 2_000,
      expiresAt: null,
    });
    assert.equal(first.id, second.id);
    assert.equal(world.list().length, 1);
    assert.equal(world.list()[0]?.label, "主仓库");
  });

  test("operator corrections survive later body observations", () => {
    const { world } = stores();
    const memory = world.observe({
      kind: "bed",
      label: "床",
      dimension: "minecraft:overworld",
      x: 4,
      y: 64,
      z: 4,
      payload: {},
      confidence: 0.5,
      source: "body",
      observedAt: 1_000,
      expiresAt: null,
    });
    world.update({ id: memory.id, label: "真正的床", x: 5, confidence: 1 });
    world.observe({
      kind: "bed",
      label: "旧的床",
      dimension: "minecraft:overworld",
      x: 5,
      y: 64,
      z: 4,
      payload: {},
      confidence: 0.4,
      source: "body",
      observedAt: 3_000,
      expiresAt: null,
    });
    const corrected = world.list().find((entry) => entry.id === memory.id);
    assert.equal(corrected?.label, "真正的床");
    assert.equal(corrected?.source, "operator");
    assert.equal(corrected?.confidence, 1);
  });

  test("an operator correction can replace a stale row at the corrected position", () => {
    const { world } = stores();
    const stale = world.observe({
      kind: "bed",
      label: "旧床",
      dimension: "minecraft:overworld",
      x: 4,
      y: 64,
      z: 4,
      payload: {},
      confidence: 0.5,
      source: "body",
      observedAt: 1_000,
      expiresAt: null,
    });
    world.observe({
      kind: "bed",
      label: "同名错误坐标",
      dimension: "minecraft:overworld",
      x: 6,
      y: 64,
      z: 4,
      payload: {},
      confidence: 0.4,
      source: "body",
      observedAt: 2_000,
      expiresAt: null,
    });
    const corrected = world.update({
      id: stale.id,
      label: "操作员确认的床",
      x: 6,
      confidence: 1,
    });
    assert.equal(corrected?.label, "操作员确认的床");
    assert.equal(world.list().length, 1);
    assert.equal(world.list()[0]?.x, 6);
    assert.equal(world.list()[0]?.source, "operator");
  });

  test("recall prefers a nearby fresh landmark and still returns stale context", () => {
    const { world } = stores();
    world.observe({
      kind: "mine",
      label: "近处矿洞",
      dimension: "minecraft:overworld",
      x: 2,
      y: 64,
      z: 0,
      payload: {},
      confidence: 0.9,
      source: "body",
      observedAt: Date.now(),
      expiresAt: null,
    });
    world.observe({
      kind: "mine",
      label: "远处旧矿洞",
      dimension: "minecraft:overworld",
      x: 200,
      y: 40,
      z: 0,
      payload: {},
      confidence: 1,
      source: "body",
      observedAt: 1_000,
      expiresAt: 2_000,
    });
    const recalled = world.recall({
      dimension: "minecraft:overworld",
      position: { x: 0, y: 64, z: 0 },
      limit: 8,
    });
    assert.equal(recalled[0]?.label, "近处矿洞");
    assert.equal(recalled.length, 2);
  });

  test("recall canonicalises dimension names instead of mixing nether landmarks", () => {
    const { world } = stores();
    world.observe({
      kind: "portal",
      label: "下界传送门",
      dimension: "minecraft:the_nether",
      x: 0,
      y: 64,
      z: 0,
      payload: {},
      confidence: 1,
      source: "body",
      observedAt: 1_000,
      expiresAt: null,
    });
    world.observe({
      kind: "home",
      label: "主世界营地",
      dimension: "minecraft:overworld",
      x: 0,
      y: 64,
      z: 0,
      payload: {},
      confidence: 1,
      source: "body",
      observedAt: 1_000,
      expiresAt: null,
    });
    assert.deepEqual(
      world.recall({ dimension: "nether", limit: 8 }).map((entry) => entry.label),
      ["下界传送门"],
    );
    assert.deepEqual(
      world.recall({ dimension: "overworld", limit: 8 }).map((entry) => entry.label),
      ["主世界营地"],
    );
  });

  test("body facts write home, bed, chest, furnace and mine landmarks", () => {
    const { world } = stores();
    const facts = worldFactsFromSnapshot({
      inWorld: true,
      world: "minecraft:overworld",
      position: { x: 0, y: 64, z: 0 },
      shelterBuilt: true,
      shelter: { x: 10, y: 64, z: 10 },
      bed: { x: 11, y: 64, z: 10 },
      chest: { x: 9, y: 64, z: 10 },
      furnace: { x: 8, y: 64, z: 10 },
      mineEntrance: { x: 0, y: 64, z: 20 },
      inventory: [
        { section: "main", slot: 9, item: "minecraft:bread", count: 3 },
      ],
      nearbyBlocks: [
        {
          id: "minecraft:crafting_table",
          x: 12,
          y: 64,
          z: 10,
          distance: 2,
        },
        {
          id: "minecraft:nether_portal",
          x: 30,
          y: 64,
          z: 30,
          distance: 28,
        },
      ],
    });
    world.observeFacts(facts, 5_000);
    const memories = world.list();
    const kinds = new Set(memories.map((entry) => entry.kind));
    assert.ok(kinds.has("home"));
    assert.ok(kinds.has("bed"));
    assert.ok(kinds.has("container"));
    assert.ok(kinds.has("furnace"));
    assert.ok(kinds.has("crafting_table"));
    assert.ok(kinds.has("mine"));
    assert.ok(kinds.has("portal"));
    const chest = memories.find((entry) => entry.kind === "container");
    assert.deepEqual(chest?.payload["inventory"], [
      { section: "main", slot: 9, item: "minecraft:bread", count: 3 },
    ]);
    assert.equal(chest?.payload["snapshotAt"], 5_000);
  });
});

describe("strategy memory", () => {
  test("outcomes accumulate and a later success keeps the failure history", () => {
    const { strategies } = stores();
    const first = strategies.record({
      strategyKey: "mine:iron:1",
      stage: "iron",
      cardId: "mine.descend",
      ok: false,
      failureCode: "E_PATH",
      failureDetail: "矿道入口被堵住",
      at: 1_000,
    });
    const second = strategies.record({
      strategyKey: "mine:iron:1",
      stage: "iron",
      cardId: "mine.descend",
      ok: true,
      failureCode: null,
      failureDetail: null,
      at: 2_000,
    });
    assert.equal(second.id, first.id);
    assert.equal(second.failureCount, 1);
    assert.equal(second.successCount, 1);
    assert.equal(second.lastFailureCode, "E_PATH");
    assert.ok(second.confidence > first.confidence - 0.01);
  });
});
