import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_GOAL_STRATEGY } from "@craftmate/contracts";
import { worldFactsFromSnapshot } from "../survival/facts.ts";
import type { GoalId } from "../survival/types.ts";
import {
  PLAYBOOK_CARD_IDS,
  availableCards,
  evaluatePlaybook,
  selectPlaybookCard,
  type CardContext,
} from "./index.ts";

function context(
  snapshot: Parameters<typeof worldFactsFromSnapshot>[0],
  overrides: Partial<CardContext> = {},
): CardContext {
  return {
    stage: "food" as GoalId,
    facts: worldFactsFromSnapshot(snapshot),
    strategy: DEFAULT_GOAL_STRATEGY,
    lastFailure: null,
    consecutiveFailures: 0,
    memory: [],
    now: 1_000,
    newId: () => "test-id",
    ...overrides,
  };
}

const settled = {
  inWorld: true,
  position: { x: 8, y: 70, z: 8 },
  health: 20,
  food: 20,
  timeOfDay: 1_000,
  shelterBuilt: true,
  chestPlaced: true,
  bedPlaced: true,
  furnacePlaced: true,
  chest: { x: 8, y: 70, z: 8 },
  bed: { x: 9, y: 70, z: 8 },
  furnace: { x: 7, y: 70, z: 8 },
  inventory: [
    { section: "main", slot: 9, item: "minecraft:stone_pickaxe", count: 1 },
    { section: "main", slot: 10, item: "minecraft:oak_log", count: 8 },
    { section: "main", slot: 11, item: "minecraft:cobblestone", count: 16 },
    { section: "main", slot: 12, item: "minecraft:bread", count: 3 },
  ],
  nearbyBlocks: [{ id: "minecraft:crafting_table" }],
} as const;

describe("playbook catalog", () => {
  test("exposes each card once with evidence and stop conditions", () => {
    const cards = evaluatePlaybook(
      context(settled),
      DEFAULT_GOAL_STRATEGY,
    ).map((evaluation) => evaluation.card);
    assert.deepEqual(
      cards.map((card) => card.id).sort(),
      [...PLAYBOOK_CARD_IDS].sort(),
    );
    assert.equal(new Set(cards.map((card) => card.id)).size, cards.length);
    for (const card of cards) {
      assert.ok(card.expectedEvidence.length > 0, card.id);
      assert.ok(card.stopConditions.length > 0, card.id);
    }
  });

  test("available cards never expose the same skill action twice", () => {
    const evaluations = evaluatePlaybook(
      context({
        inWorld: true,
        position: { x: 0, y: 64, z: 0 },
        health: 20,
        food: 18,
        timeOfDay: 1_000,
        inventory: [
          { section: "main", slot: 9, item: "minecraft:stone_pickaxe", count: 1 },
        ],
        nearbyBlocks: [
          {
            id: "minecraft:oak_log",
            count: 2,
            x: 4,
            y: 64,
            z: 4,
            distance: 5,
            bearing: 0,
            visible: true,
          },
        ],
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    const keys = availableCards(evaluations).map(
      (evaluation) =>
        `${evaluation.task?.skill.name}:${JSON.stringify(evaluation.task?.skill.args)}`,
    );
    assert.equal(new Set(keys).size, keys.length);
  });

  test("bounded recovery waits for a confirmed enclosed failure", () => {
    const enclosed = {
      inWorld: true,
      position: { x: 12, y: 48, z: 12 },
      health: 18,
      food: 18,
      timeOfDay: 1_000,
      enclosed: true,
      surfaceY: 64,
      inventory: [
        { section: "main", slot: 9, item: "minecraft:stone_pickaxe", count: 1 },
        { section: "main", slot: 10, item: "minecraft:dirt", count: 16 },
      ],
    } as const;

    const available = evaluatePlaybook(
      context(enclosed, { lastFailure: "E_STUCK: no safe route" }),
      DEFAULT_GOAL_STRATEGY,
    ).find((item) => item.card.id === "recovery.escape");
    assert.equal(available?.status, "available");
    assert.equal(available?.task?.skill.args["mode"], "recover");

    for (const overrides of [
      { lastFailure: "E_UNREACHABLE: no route" },
      { snapshot: { ...enclosed, enclosed: false }, lastFailure: "E_STUCK" },
    ]) {
      const evaluation = evaluatePlaybook(
        context(
          "snapshot" in overrides ? overrides.snapshot : enclosed,
          { lastFailure: overrides.lastFailure },
        ),
        DEFAULT_GOAL_STRATEGY,
      ).find((item) => item.card.id === "recovery.escape");
      assert.equal(evaluation?.status, "blocked");
    }
  });

  test("a surface terrace digs one bounded stair instead of pacing", () => {
    const evaluations = evaluatePlaybook(
      context(
        {
          inWorld: true,
          position: { x: 85, y: 63, z: 45 },
          health: 20,
          food: 8,
          timeOfDay: 15_000,
          enclosed: false,
          inWater: false,
          shaftWalls: 0,
          surfaceY: 63,
          yaw: 90,
          inventory: [
            { section: "main", slot: 9, item: "minecraft:iron_pickaxe", count: 1 },
          ],
        },
        {
          lastFailure: "E_UNREACHABLE: no natural route within the walk budget",
          consecutiveFailures: 12,
        },
      ),
      DEFAULT_GOAL_STRATEGY,
    );
    const escape = evaluations.find(
      (item) => item.card.id === "recovery.escape",
    );
    assert.equal(escape?.status, "available");
    assert.equal(escape?.task?.skill.args["mode"], "dig");
    assert.deepEqual(escape?.task?.skill.args["target"], {
      x: 85,
      y: 66,
      z: 45,
    });
  });
});

describe("safety and night gates", () => {
  test("low health retreats while a healthy armed body fights", () => {
    const hurt = evaluatePlaybook(
      context({
        inWorld: true,
        position: { x: 40, y: 64, z: 40 },
        surfaceY: 64,
        canSeeSky: true,
        health: 6,
        food: 18,
        timeOfDay: 1_000,
        shelterBuilt: false,
        inventory: [
          { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1 },
          { section: "main", slot: 1, item: "minecraft:dirt", count: 8 },
        ],
        entities: [
          {
            name: "僵尸",
            type: "minecraft:zombie",
            distance: 3,
            x: 41,
            y: 64,
            z: 40,
          },
        ],
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    const retreat = hurt.find((item) => item.card.id === "safety.retreat");
    assert.equal(retreat?.status, "available");
    assert.equal(retreat?.task?.skill.args["emergency"], true);
    assert.equal(retreat?.task?.skill.args["mode"], "walk");

    const underground = evaluatePlaybook(
      context({
        ...settled,
        position: { x: 40, y: 36, z: 40 },
        surfaceY: 70,
        canSeeSky: false,
        health: 6,
        food: 18,
        inventory: [
          { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1 },
        ],
        entities: [
          {
            name: "僵尸",
            type: "minecraft:zombie",
            distance: 3,
            x: 41,
            y: 36,
            z: 40,
          },
        ],
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    const tunnelRetreat = underground.find(
      (item) => item.card.id === "safety.retreat",
    );
    assert.equal(tunnelRetreat?.status, "available");
    assert.equal(tunnelRetreat?.task?.skill.args["mode"], "dig");

    const armed = evaluatePlaybook(
      context({
        ...settled,
        position: { x: 40, y: 70, z: 40 },
        health: 20,
        inventory: [
          { section: "hotbar", slot: 0, item: "minecraft:stone_sword", count: 1 },
        ],
        entities: [
          {
            name: "僵尸",
            type: "minecraft:zombie",
            distance: 4,
            x: 41,
            y: 70,
            z: 40,
          },
        ],
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    assert.equal(
      armed.find((item) => item.card.id === "safety.retreat")?.status,
      "blocked",
    );
    assert.equal(
      armed.find((item) => item.card.id === "combat.engage")?.task?.skill.name,
      "attack",
    );
  });

  test("night without a bed keeps real work and never builds a shelter", () => {
    const cases = [
      {
        name: "open surface",
        snapshot: {
          inWorld: true,
          position: { x: 40, y: 64, z: 40 },
          surfaceY: 64,
          canSeeSky: true,
          health: 20,
          food: 18,
          timeOfDay: 14_000,
          shelterBuilt: false,
          inventory: [
            { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1 },
            { section: "main", slot: 1, item: "minecraft:dirt", count: 8 },
          ],
        },
      },
      {
        name: "open cave",
        snapshot: {
          inWorld: true,
          position: { x: 0, y: 60, z: 0 },
          surfaceY: 64,
          canSeeSky: false,
          health: 20,
          food: 18,
          timeOfDay: 13_000,
          shelterBuilt: false,
          floor: "minecraft:stone",
          inventory: [
            { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1 },
          ],
        },
      },
    ] as const;

    for (const item of cases) {
      const evaluations = evaluatePlaybook(
        context(item.snapshot),
        DEFAULT_GOAL_STRATEGY,
      );
      assert.equal(
        evaluations.some((evaluation) =>
          ["safety.dig_in", "safety.night_wait", "home.shelter"].includes(
            evaluation.card.id,
          ),
        ),
        false,
        item.name,
      );
      const nightHome = evaluations.find(
        (evaluation) => evaluation.card.id === "safety.night_home",
      );
      assert.equal(nightHome?.status, "blocked", item.name);
      assert.match(nightHome?.blockedReason ?? "", /没有床/u, item.name);
    }
  });

  test("night work is available at the configured dusk threshold", () => {
    const evaluations = evaluatePlaybook(
      context(
        {
          ...settled,
          timeOfDay: DEFAULT_GOAL_STRATEGY.nightReturnAt + 100,
          bedPlaced: false,
          bed: null,
          inventory: [
            ...settled.inventory,
            { section: "main", slot: 13, item: "minecraft:torch", count: 8 },
          ],
        },
        { stage: "iron" as GoalId },
      ),
      DEFAULT_GOAL_STRATEGY,
    );
    const nightWork = evaluations.find(
      (evaluation) => evaluation.card.id === "night.work",
    );
    assert.equal(nightWork?.status, "available");
    assert.ok(nightWork?.task);
    assert.notEqual(nightWork?.task?.skill.name, "wait");
  });

  test("night blocks ordinary surface hunting and wood gathering", () => {
    const hunt = evaluatePlaybook(
      context({
        inWorld: true,
        position: { x: 0, y: 64, z: 0 },
        surfaceY: 64,
        health: 20,
        food: 12,
        timeOfDay: 13_000,
        inventory: [],
        entities: [
          { name: "羊", type: "minecraft:sheep", distance: 5, x: 4, y: 64, z: 0 },
        ],
      }),
      DEFAULT_GOAL_STRATEGY,
    ).find((evaluation) => evaluation.card.id === "food.hunt");
    assert.equal(hunt?.status, "blocked");
    assert.match(hunt?.blockedReason ?? "", /夜间/u);

    const wood = evaluatePlaybook(
      context({
        inWorld: true,
        position: { x: 0, y: 64, z: 0 },
        surfaceY: 64,
        health: 20,
        food: 18,
        timeOfDay: 13_000,
        inventory: [],
        nearbyBlocks: [{ id: "minecraft:oak_log", count: 4 }],
      }),
      DEFAULT_GOAL_STRATEGY,
    ).find((evaluation) => evaluation.card.id === "stockpile.wood");
    assert.equal(wood?.status, "blocked");
    assert.match(wood?.blockedReason ?? "", /夜间/u);
  });

  test("a hurt body without a visible animal explores instead of sweeping leaves", () => {
    const evaluations = evaluatePlaybook(
      context(
        {
          inWorld: true,
          position: { x: 0, y: 64, z: 0 },
          surfaceY: 64,
          health: 6,
          food: 12,
          timeOfDay: 13_000,
          inventory: [],
          nearbyBlocks: [{ id: "minecraft:oak_leaves", count: 40 }],
        },
        { stage: "food" },
      ),
      DEFAULT_GOAL_STRATEGY,
    );
    assert.equal(
      evaluations.find((evaluation) => evaluation.card.id === "food.hunt")?.task
        ?.skill.name,
      "goto",
    );
    assert.equal(selectPlaybookCard(evaluations)?.card.id, "food.hunt");
  });
});
