import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { explore } from "./tasks.ts";
import {
  nearestEntityWithinHeight,
  worldFactsFromSnapshot,
} from "./facts.ts";
import type { NearbyEntity } from "./types.ts";

const pig: NearbyEntity = {
  type: "minecraft:pig",
  name: "Pig",
  distance: 10,
  x: 10,
  y: 70,
  z: 0,
};
const cow: NearbyEntity = {
  type: "minecraft:cow",
  name: "Cow",
  distance: 5,
  x: 5,
  y: 70,
  z: 0,
};

function snapshot(entities: readonly NearbyEntity[], health = 20) {
  return {
    inWorld: true,
    world: "minecraft:overworld",
    position: { x: 0, y: 70, z: 0 },
    health,
    food: 20,
    timeOfDay: 1_000,
    entities,
  };
}

const entityLock = {
  kind: "entity" as const,
  ref: "minecraft:pig:Pig",
  dimension: "minecraft:overworld",
  x: 10,
  y: 70,
  z: 0,
  cardId: "food.hunt",
  lockedAt: 0,
  expiresAt: 10_000,
};

function blacklist(overrides: Partial<{
  kind: "entity" | "point" | "region" | "hazard";
  x: number;
  y: number;
  z: number;
  radius: number;
  expiresAt: number | null;
}> = {}) {
  return {
    id: "blacklist-1",
    sessionId: "session-1",
    dimension: "minecraft:overworld",
    kind: "point" as const,
    x: 10,
    y: 70,
    z: 0,
    radius: 2,
    targetRef: null,
    reasonCode: "E_UNREACHABLE",
    reasonDetail: "no route",
    source: "agent" as const,
    expiresAt: 60_000,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("navigation facts", () => {
  test("a valid entity lock hides other animals on the same layer", () => {
    const facts = worldFactsFromSnapshot(snapshot([cow, pig]), {
      targetLock: entityLock,
      now: 1_000,
    });
    assert.deepEqual(facts.entities?.map((entity) => entity.type), ["minecraft:pig"]);
  });

  test("a moved or expired entity lock is ignored instead of pinning the view", () => {
    const moved = worldFactsFromSnapshot(
      snapshot([{ ...pig, x: 30, distance: 30 }, cow]),
      { targetLock: entityLock, now: 1_000 },
    );
    assert.equal(moved.entities?.length, 2);

    const expired = worldFactsFromSnapshot(snapshot([cow, pig]), {
      targetLock: { ...entityLock, expiresAt: 500 },
      now: 1_000,
    });
    assert.equal(expired.entities?.length, 2);
    assert.equal(expired.targetLock, null);
  });

  test("a target that moved more than eight blocks vertically releases", () => {
    const moved = worldFactsFromSnapshot(
      snapshot([{ ...pig, y: 60, distance: 14 }]),
      { targetLock: entityLock, now: 1_000 },
    );
    assert.equal(moved.targetLock, null);
  });

  test("target selection prefers an animal on the body's own layer", () => {
    const facts = worldFactsFromSnapshot(
      snapshot([
        {
          ...pig,
          y: 78,
          distance: 3,
        },
        {
          ...cow,
          y: 70,
          distance: 7,
        },
      ]),
    );
    const chosen = nearestEntityWithinHeight(facts, /pig|cow/u, 20, 12);
    assert.equal(chosen?.type, "minecraft:cow");
  });

  test("low health or a nearby hostile releases the lock immediately", () => {
    const hurt = worldFactsFromSnapshot(snapshot([cow, pig], 6), {
      targetLock: entityLock,
      now: 1_000,
    });
    assert.equal(hurt.targetLock, null);
    assert.equal(hurt.entities?.length, 2);

    const threatened = worldFactsFromSnapshot(
      snapshot([
        cow,
        {
          type: "minecraft:zombie",
          name: "Zombie",
          distance: 3,
          x: 3,
          y: 70,
          z: 0,
        },
      ]),
      { targetLock: entityLock, now: 1_000 },
    );
    assert.equal(threatened.targetLock, null);
  });

  test("a blacklisted entity is not offered as a fresh target", () => {
    const facts = worldFactsFromSnapshot(snapshot([cow, pig]), {
      routeBlacklist: [blacklist({ kind: "entity" })],
      now: 1_000,
    });
    assert.deepEqual(facts.entities?.map((entity) => entity.type), ["minecraft:cow"]);
  });

  test("an explore lock covered by the blacklist cannot bypass it", () => {
    const lock = {
      kind: "explore" as const,
      ref: "explore:wood-and-table:wood",
      dimension: "minecraft:overworld",
      x: 10,
      y: 70,
      z: 0,
      cardId: null,
      lockedAt: 0,
      expiresAt: 60_000,
    };
    const facts = worldFactsFromSnapshot(snapshot([]), {
      targetLock: lock,
      routeBlacklist: [blacklist()],
      now: 1_000,
    });
    const task = explore(
      facts,
      "wood-and-table",
      "寻找木材",
      "wood",
      1,
      () => "new-id",
      8,
      16,
    );
    const target = task.skill.args.target as { x: number; y: number; z: number };
    assert.notDeepEqual(target, { x: 10, y: 70, z: 0 });
    const nextLock = task.targetLock;
    assert.ok(nextLock !== undefined);
    assert.ok(
      Math.hypot(nextLock.x - 10, nextLock.z - 0) > 1 ||
        Math.abs(nextLock.y - 70) > 4,
    );
  });
});
