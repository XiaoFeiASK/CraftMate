import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_GOAL_STRATEGY } from "@craftmate/contracts";
import { worldFactsFromSnapshot } from "../survival/facts.ts";
import type { GoalId } from "../survival/types.ts";
import {
  HARD_MEMORY_CONFIDENCE,
  PLAYBOOK_CARD_IDS,
  availableCards,
  evaluatePlaybook,
  memorySatisfiesPrecondition,
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
  test("the first release exposes every requested card exactly once", () => {
    const cards = evaluatePlaybook(context(settled), DEFAULT_GOAL_STRATEGY).map(
      (evaluation) => evaluation.card,
    );
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

  test("bounded recovery is only offered after a confirmed enclosed failure", () => {
    const snapshot = {
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
      context(snapshot, { lastFailure: "E_STUCK: no safe route" }),
      DEFAULT_GOAL_STRATEGY,
    ).find((item) => item.card.id === "recovery.escape");
    assert.equal(available?.status, "available");
    assert.equal(available?.task?.skill.name, "goto");
    const args = available?.task?.skill.args as {
      mode?: string;
      target?: { y?: number };
    };
    assert.equal(args.mode, "recover");
    assert.ok((args.target?.y ?? 0) <= 48 + 12);

    const unreachable = evaluatePlaybook(
      context(snapshot, { lastFailure: "E_UNREACHABLE: no route" }),
      DEFAULT_GOAL_STRATEGY,
    ).find((item) => item.card.id === "recovery.escape");
    assert.equal(unreachable?.status, "blocked");

    const openSky = evaluatePlaybook(
      context({ ...snapshot, enclosed: false }, { lastFailure: "E_STUCK" }),
      DEFAULT_GOAL_STRATEGY,
    ).find((item) => item.card.id === "recovery.escape");
    assert.equal(openSky?.status, "blocked");
  });

  test("a hazard blocks recovery while a normal point refusal may be overridden", () => {
    const base = context(
      {
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
      },
      { lastFailure: "E_STUCK" },
    );
    const blacklistEntry = (kind: "point" | "hazard") => ({
      id: `entry-${kind}`,
      sessionId: "session-1",
      dimension: "minecraft:overworld",
      kind,
      x: 12,
      y: 60,
      z: 12,
      radius: 1,
      targetRef: null,
      reasonCode: "E_STUCK",
      reasonDetail: null,
      source: "agent" as const,
      expiresAt: 60_000,
      createdAt: 0,
      updatedAt: 0,
    });
    const withHazard = evaluatePlaybook(
      {
        ...base,
        facts: { ...base.facts, routeBlacklist: [blacklistEntry("hazard")] },
      },
      DEFAULT_GOAL_STRATEGY,
    ).find((item) => item.card.id === "recovery.escape");
    assert.equal(withHazard?.status, "blocked");
    assert.match(withHazard?.blockedReason ?? "", /路线黑名单/u);

    const withPoint = evaluatePlaybook(
      {
        ...base,
        facts: { ...base.facts, routeBlacklist: [blacklistEntry("point")] },
      },
      DEFAULT_GOAL_STRATEGY,
    ).find((item) => item.card.id === "recovery.escape");
    assert.equal(withPoint?.status, "available");
  });

  test("deterministic fallback prefers safety and recovery over exploration", () => {
    const evaluations = evaluatePlaybook(
      context({ ...settled, position: { x: 0, y: 70, z: 0 }, health: 4 }),
      DEFAULT_GOAL_STRATEGY,
    );
    const selected = selectPlaybookCard(evaluations);
    assert.ok(selected);
    assert.equal(selected.card.group, "safety");
    assert.equal(selected.card.critical, true);
  });

  test("a low-health state exposes the critical retreat card", () => {
    const evaluations = evaluatePlaybook(
      context({ ...settled, position: { x: 0, y: 70, z: 0 }, health: 4 }),
      DEFAULT_GOAL_STRATEGY,
    );
    const retreat = evaluations.find((item) => item.card.id === "safety.retreat");
    assert.equal(retreat?.status, "available");
    assert.ok(retreat?.task);
  });

  test("a hurt unarmed body runs away instead of digging a temporary shelter", () => {
    const evaluations = evaluatePlaybook(
      context({
        inWorld: true,
        position: { x: 40, y: 64, z: 40 },
        surfaceY: 64,
        canSeeSky: true,
        health: 6,
        food: 18,
        timeOfDay: 1_000,
        shelterBuilt: false,
        floor: "minecraft:dirt",
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
        inventory: [
          { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1 },
          { section: "main", slot: 1, item: "minecraft:dirt", count: 8 },
        ],
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    const retreat = evaluations.find((evaluation) => evaluation.card.id === "safety.retreat");
    assert.equal(retreat?.status, "available");
    assert.equal(retreat?.task?.skill.name, "goto");
    const target = (retreat?.task?.skill.args as { target?: { x?: number; z?: number } }).target;
    assert.ok(target);
    assert.ok(
      Math.hypot((target.x ?? 0) - 41, (target.z ?? 0) - 40) > 10,
      "retreat target must be well away from the zombie",
    );
  });

  test("a healthy unarmed body backs away when a zombie is already within reach", () => {
    const evaluations = evaluatePlaybook(
      context({
        inWorld: true,
        position: { x: 40, y: 64, z: 40 },
        surfaceY: 64,
        canSeeSky: true,
        health: 20,
        food: 18,
        timeOfDay: 14_000,
        shelterBuilt: false,
        floor: "minecraft:dirt",
        entities: [
          {
            name: "僵尸",
            type: "minecraft:zombie",
            distance: 7,
            x: 46,
            y: 64,
            z: 40,
          },
        ],
        inventory: [
          { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1 },
          { section: "main", slot: 1, item: "minecraft:dirt", count: 8 },
        ],
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    const retreat = evaluations.find((evaluation) => evaluation.card.id === "safety.retreat");
    assert.equal(retreat?.status, "available");
    assert.equal(retreat?.task?.skill.name, "goto");
  });

  test("a healthy armed body fights instead of retreating from a zombie", () => {
    const evaluations = evaluatePlaybook(
      context({
        ...settled,
        position: { x: 40, y: 70, z: 40 },
        health: 20,
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
        inventory: [
          { section: "hotbar", slot: 0, item: "minecraft:stone_sword", count: 1 },
        ],
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    const retreat = evaluations.find((evaluation) => evaluation.card.id === "safety.retreat");
    assert.equal(retreat?.status, "blocked");
    assert.match(retreat?.blockedReason ?? "", /血量和武器足够/u);
    const combat = evaluations.find((evaluation) => evaluation.card.id === "combat.engage");
    assert.equal(combat?.status, "available");
    assert.equal(combat?.task?.skill.name, "attack");
  });

  test("a hurt body without a usable pickaxe still retreats by walking", () => {
    const evaluations = evaluatePlaybook(
      context({
        inWorld: true,
        position: { x: 40, y: 64, z: 40 },
        surfaceY: 64,
        canSeeSky: true,
        health: 6,
        food: 18,
        timeOfDay: 1_000,
        shelterBuilt: false,
        floor: "minecraft:dirt",
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
        inventory: [
          { section: "main", slot: 1, item: "minecraft:dirt", count: 8 },
        ],
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    const retreat = evaluations.find((evaluation) => evaluation.card.id === "safety.retreat");
    assert.equal(retreat?.status, "available");
    assert.equal(retreat?.task?.skill.name, "goto");
  });

  test("a hurt body already at camp eats or forages instead of retreating in place", () => {
    const evaluations = evaluatePlaybook(
      context({ ...settled, health: 4, food: 6 }),
      DEFAULT_GOAL_STRATEGY,
    );
    const retreat = evaluations.find((item) => item.card.id === "safety.retreat");
    assert.equal(retreat?.status, "blocked");
    assert.match(retreat?.blockedReason ?? "", /营地/u);
    const selected = selectPlaybookCard(evaluations);
    assert.notEqual(selected?.card.id, "safety.retreat");
  });

  test("a hurt body with no camp does not retreat sideways on the surface", () => {
    const evaluations = evaluatePlaybook(
      context({
        inWorld: true,
        position: { x: 40, y: 70, z: 40 },
        surfaceY: 70,
        canSeeSky: true,
        health: 6,
        food: 18,
        timeOfDay: 1_000,
        shelterBuilt: false,
        floor: "minecraft:dirt",
        inventory: [
          { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1 },
          { section: "main", slot: 1, item: "minecraft:dirt", count: 8 },
        ],
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    const retreat = evaluations.find((item) => item.card.id === "safety.retreat");
    assert.equal(retreat?.status, "blocked");
    assert.match(retreat?.blockedReason ?? "", /食物|恢复/u);
    assert.notEqual(selectPlaybookCard(evaluations)?.card.id, "safety.retreat");
  });

  test("a hurt body underground climbs toward daylight when it has no camp", () => {
    const evaluations = evaluatePlaybook(
      context({
        inWorld: true,
        position: { x: 40, y: 50, z: 40 },
        surfaceY: 70,
        canSeeSky: false,
        health: 6,
        food: 18,
        timeOfDay: 1_000,
        shelterBuilt: false,
        floor: "minecraft:stone",
        inventory: [
          { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1 },
          { section: "main", slot: 1, item: "minecraft:dirt", count: 8 },
        ],
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    const retreat = evaluations.find((item) => item.card.id === "safety.retreat");
    assert.equal(retreat?.status, "available");
    assert.equal(retreat?.task?.skill.name, "goto");
    const target = (retreat?.task?.skill.args as { target?: { y?: number } }).target;
    assert.ok((target?.y ?? 0) > 50);
  });

  test("a hurt body without a bed keeps working instead of digging a nightly shelter", () => {
    const evaluations = evaluatePlaybook(
      context({
        inWorld: true,
        position: { x: 40, y: 50, z: 40 },
        surfaceY: 70,
        canSeeSky: false,
        health: 6,
        food: 18,
        timeOfDay: 14_000,
        shelterBuilt: false,
        enclosed: true,
        floor: "minecraft:stone",
        inventory: [
          { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1 },
          { section: "main", slot: 1, item: "minecraft:dirt", count: 8 },
        ],
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    const retreat = evaluations.find((item) => item.card.id === "safety.retreat");
    assert.equal(retreat?.status, "blocked");
    assert.match(retreat?.blockedReason ?? "", /夜间|地下/u);
    assert.equal(
      evaluations.some((item) => item.card.id === "safety.dig_in"),
      false,
    );
    assert.equal(
      evaluations.some((item) => item.card.id === "safety.night_wait"),
      false,
    );
    const nightHome = evaluations.find(
      (item) => item.card.id === "safety.night_home",
    );
    assert.equal(nightHome?.status, "blocked");
    assert.match(nightHome?.blockedReason ?? "", /没有床/u);
  });

  test("stale or low-confidence mine memories cannot satisfy the exit gate", () => {
    const miningFacts = {
      ...settled,
      mineEntrance: null,
      inventory: [
        { section: "main", slot: 9, item: "minecraft:stone_pickaxe", count: 1 },
        { section: "main", slot: 10, item: "minecraft:cobblestone", count: 16 },
        { section: "main", slot: 11, item: "minecraft:bread", count: 3 },
      ],
      nearbyBlocks: [],
    } as const;
    const stale = {
      id: "wm-stale",
      sessionId: "session",
      kind: "mine" as const,
      label: "旧矿洞",
      dimension: "minecraft:overworld",
      x: 4,
      y: 50,
      z: 4,
      payload: {},
      confidence: 0.9,
      source: "body" as const,
      observedAt: 10,
      expiresAt: 500,
      createdAt: 10,
      updatedAt: 10,
    };
    const lowConfidence = {
      ...stale,
      id: "wm-low",
      confidence: HARD_MEMORY_CONFIDENCE - 0.01,
      expiresAt: null,
    };
    assert.equal(memorySatisfiesPrecondition(stale, 1_000), false);
    assert.equal(memorySatisfiesPrecondition(lowConfidence, 1_000), false);

    const evaluations = evaluatePlaybook(
      context(miningFacts, {
        stage: "iron",
        memory: [stale, lowConfidence],
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    const descend = evaluations.find((item) => item.card.id === "mine.descend");
    assert.equal(descend?.status, "blocked");
    assert.match(descend?.blockedReason ?? "", /安全出口/u);
  });

  test("the configured dwell applies to noncritical cards, not safety gates", () => {
    const cards = evaluatePlaybook(
      context(settled),
      { ...DEFAULT_GOAL_STRATEGY, cardMinDwellMs: 120_000 },
    ).map((evaluation) => evaluation.card);
    const explore = cards.find((card) => card.id === "explore.surface");
    const retreat = cards.find((card) => card.id === "safety.retreat");
    assert.equal(explore?.minDwellMs, 120_000);
    assert.equal(retreat?.minDwellMs, 0);
  });

  test("the nightly return threshold only sends a body with a bed home", () => {
    const away = evaluatePlaybook(
      context({
        ...settled,
        position: { x: 72, y: 70, z: 72 },
        timeOfDay: 13_000,
      }),
      DEFAULT_GOAL_STRATEGY,
    ).find((evaluation) => evaluation.card.id === "safety.night_home");
    assert.equal(away?.status, "available");
    assert.equal(away?.task?.critical, true);
    assert.equal(away?.task?.skill.name, "goto");

    const dusk = evaluatePlaybook(
      context({
        ...settled,
        position: { x: 72, y: 70, z: 72 },
        timeOfDay: DEFAULT_GOAL_STRATEGY.nightReturnAt,
      }),
      DEFAULT_GOAL_STRATEGY,
    ).find((evaluation) => evaluation.card.id === "safety.night_home");
    assert.equal(dusk?.status, "blocked");
    assert.match(dusk?.blockedReason ?? "", /还没黑|天黑/u);

    const sleeping = evaluatePlaybook(
      context({
        ...settled,
        timeOfDay: 13_000,
      }),
      DEFAULT_GOAL_STRATEGY,
    ).find((evaluation) => evaluation.card.id === "safety.night_home");
    assert.equal(sleeping?.task?.skill.name, "sleep");
  });

  test("dusk without a bed keeps the body on useful work instead of digging in", () => {
    const evaluations = evaluatePlaybook(
      context({
        inWorld: true,
        position: { x: 0, y: 64, z: 0 },
        surfaceY: 64,
        health: 20,
        food: 18,
        timeOfDay: DEFAULT_GOAL_STRATEGY.nightReturnAt - 500,
        shelterBuilt: false,
        inventory: [
          { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1 },
        ],
        mineEntrance: { x: 0, y: 64, z: 0 },
        mine: {
          entrance: { x: 0, y: 64, z: 0 },
          direction: "east",
          stair: {
            stand: { x: 0, y: 64, z: 0 },
            depth: 1,
            pending: { id: "minecraft:stone", x: 1, y: 63, z: 0 },
          },
        },
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    assert.equal(
      evaluations.some((evaluation) => evaluation.card.id === "safety.dig_in"),
      false,
    );
    assert.equal(
      evaluations.some((evaluation) => evaluation.card.id === "safety.night_wait"),
      false,
    );
    const nightHome = evaluations.find(
      (evaluation) => evaluation.card.id === "safety.night_home",
    );
    assert.equal(nightHome?.status, "blocked");
  });

  test("surface work closes at night-return time, before the sky is dark", () => {
    const evaluations = evaluatePlaybook(
      context({
        inWorld: true,
        position: { x: 0, y: 64, z: 0 },
        surfaceY: 64,
        canSeeSky: true,
        health: 20,
        food: 10,
        timeOfDay: DEFAULT_GOAL_STRATEGY.nightReturnAt + 100,
        shelterBuilt: false,
        inventory: [
          { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1 },
        ],
        nearbyBlocks: [
          { id: "minecraft:oak_log", count: 4 },
          { id: "minecraft:oak_leaves", count: 12 },
        ],
        entities: [{ name: "牛", type: "minecraft:cow", distance: 8 }],
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    for (const id of [
      "stockpile.wood",
      "explore.surface",
      "food.hunt",
      "food.forage",
    ]) {
      const card = evaluations.find((evaluation) => evaluation.card.id === id);
      assert.equal(card?.status, "blocked", id);
      assert.match(card?.blockedReason ?? "", /天黑后/u, id);
    }
  });

  test("a first night without a bed never starts a shelter or a wait action", () => {
    const evaluations = evaluatePlaybook(
      context({
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
        mineEntrance: { x: 0, y: 64, z: 0 },
        floor: "minecraft:grass_block",
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    for (const id of ["safety.dig_in", "safety.night_wait"]) {
      assert.equal(
        evaluations.some((evaluation) => evaluation.card.id === id),
        false,
        id,
      );
    }
    assert.equal(
      evaluations.some(
        (evaluation) =>
          evaluation.status === "available" &&
          (evaluation.task?.skill.name === "wait" ||
            /避难|竖井/u.test(evaluation.task?.title ?? "")),
      ),
      false,
    );
    const nightHome = evaluations.find(
      (evaluation) => evaluation.card.id === "safety.night_home",
    );
    assert.equal(nightHome?.status, "blocked");
    assert.match(nightHome?.blockedReason ?? "", /没有床/u);
  });

  test("a mine entrance is not a bed and never authorises a nightly shelter", () => {
    const evaluations = evaluatePlaybook(
      context({
        inWorld: true,
        position: { x: 0, y: 64, z: 0 },
        surfaceY: 64,
        canSeeSky: true,
        health: 20,
        food: 18,
        timeOfDay: 14_000,
        shelterBuilt: false,
        mineEntrance: { x: 0, y: 64, z: 0 },
        floor: "minecraft:stone",
        inventory: [
          { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1 },
          { section: "main", slot: 1, item: "minecraft:dirt", count: 8 },
        ],
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    const nightHome = evaluations.find(
      (evaluation) => evaluation.card.id === "safety.night_home",
    );
    assert.equal(nightHome?.status, "blocked");
    assert.match(nightHome?.blockedReason ?? "", /没有床/u);
    assert.equal(
      evaluations.some((evaluation) => evaluation.card.id === "safety.dig_in"),
      false,
    );
  });

  test("an open cave at night keeps working instead of pretending to be shelter", () => {
    const evaluations = evaluatePlaybook(
      context({
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
      }),
      DEFAULT_GOAL_STRATEGY,
    );
    for (const id of ["safety.dig_in", "safety.night_wait"]) {
      assert.equal(
        evaluations.some((evaluation) => evaluation.card.id === id),
        false,
        id,
      );
    }
    const nightHome = evaluations.find(
      (evaluation) => evaluation.card.id === "safety.night_home",
    );
    assert.equal(nightHome?.status, "blocked");
    assert.match(nightHome?.blockedReason ?? "", /没有床/u);
    assert.equal(
      evaluations.some((evaluation) => evaluation.card.id === "home.shelter"),
      false,
    );
  });

  test("night without a bed offers real work instead of an idle plan", () => {
    const evaluations = evaluatePlaybook(
      context(
        {
          inWorld: true,
          position: { x: 40, y: 64, z: 40 },
          surfaceY: 64,
          canSeeSky: true,
          health: 20,
          food: 18,
          timeOfDay: 14_000,
          inventory: [
            { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1, durability: 96 },
            { section: "main", slot: 1, item: "minecraft:stone_sword", count: 1 },
            { section: "main", slot: 2, item: "minecraft:crafting_table", count: 1 },
            { section: "main", slot: 3, item: "minecraft:cobblestone", count: 16 },
            { section: "main", slot: 4, item: "minecraft:oak_log", count: 8 },
            { section: "main", slot: 5, item: "minecraft:coal", count: 1 },
          ],
        },
        { stage: "shelter" as GoalId },
      ),
      DEFAULT_GOAL_STRATEGY,
    );
    const nightWork = evaluations.find(
      (evaluation) => evaluation.card.id === "night.work",
    );
    assert.equal(nightWork?.status, "available");
    assert.ok(nightWork?.task);
    assert.notEqual(nightWork?.task?.skill.name, "wait");
    assert.doesNotMatch(
      nightWork?.task?.title ?? "",
      /小屋|庇护|避难|夜间保持移动/u,
    );
  });

  test("night work yields to a real bed", () => {
    const nightWork = evaluatePlaybook(
      context({
        ...settled,
        position: { x: 72, y: 70, z: 72 },
        timeOfDay: 14_000,
      }),
      DEFAULT_GOAL_STRATEGY,
    ).find((evaluation) => evaluation.card.id === "night.work");
    assert.equal(nightWork?.status, "blocked");
    assert.match(nightWork?.blockedReason ?? "", /有床|睡觉/u);
  });

  test("a critically hurt body does not wander off to reobserve", () => {
    const reobserve = evaluatePlaybook(
      context(
        {
          ...settled,
          health: 4,
          food: 8,
          timeOfDay: 1_000,
        },
        {
          stage: "food" as GoalId,
          lastFailure: "hunger is too low to mine",
          consecutiveFailures: 1,
        },
      ),
      DEFAULT_GOAL_STRATEGY,
    ).find((evaluation) => evaluation.card.id === "recovery.reobserve");
    assert.equal(reobserve?.status, "blocked");
    assert.match(reobserve?.blockedReason ?? "", /血量|恢复|食物/u);
  });

  test("night work still makes progress when the pickaxe is missing", () => {
    const nightWork = evaluatePlaybook(
      context(
        {
          inWorld: true,
          position: { x: 40, y: 64, z: 40 },
          surfaceY: 64,
          canSeeSky: true,
          health: 20,
          food: 18,
          timeOfDay: 14_000,
          inventory: [
            { section: "main", slot: 1, item: "minecraft:crafting_table", count: 1 },
            { section: "main", slot: 2, item: "minecraft:cobblestone", count: 16 },
            { section: "main", slot: 3, item: "minecraft:oak_log", count: 8 },
            { section: "main", slot: 4, item: "minecraft:stick", count: 4 },
          ],
        },
        { stage: "shelter" as GoalId },
      ),
      DEFAULT_GOAL_STRATEGY,
    ).find((evaluation) => evaluation.card.id === "night.work");
    assert.equal(nightWork?.status, "available");
    assert.ok(nightWork?.task);
    assert.ok(
      ["craft", "place_block", "mine_block", "goto"].includes(
        nightWork?.task?.skill.name ?? "",
      ),
    );
  });

  test("the catalog never offers a hut-building card", () => {
    const evaluations = evaluatePlaybook(
      context(
        {
          inWorld: true,
          position: { x: 0, y: 70, z: 0 },
          surfaceY: 70,
          canSeeSky: true,
          health: 20,
          food: 18,
          timeOfDay: 14_000,
          shelterBuilt: false,
          inventory: [
            { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1 },
            { section: "main", slot: 1, item: "minecraft:cobblestone", count: 32 },
            { section: "main", slot: 2, item: "minecraft:oak_planks", count: 16 },
          ],
        },
        { stage: "shelter" as GoalId },
      ),
      DEFAULT_GOAL_STRATEGY,
    );
    assert.equal(
      evaluations.some((evaluation) => evaluation.card.id === "home.shelter"),
      false,
    );
    assert.equal(
      evaluations.some(
        (evaluation) =>
          evaluation.status === "available" &&
          /小屋|建房|庇护所/u.test(evaluation.task?.title ?? ""),
      ),
      false,
    );
  });

  test("night blocks surface hunting and wood gathering", () => {
    const hunt = evaluatePlaybook(
      context(
        {
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
        },
        { stage: "food" },
      ),
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
});
