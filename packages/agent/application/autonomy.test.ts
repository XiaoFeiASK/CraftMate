import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeHealth } from "@craftmate/contracts";
import {
  AUTONOMY_COOLDOWN_MS,
  AUTONOMY_FAILURE_COOLDOWN_MS,
  nextAutonomousAction,
  type AutonomyState,
} from "./autonomy.ts";

function health(overrides: Partial<BridgeHealth> = {}): BridgeHealth {
  return {
    connected: true,
    client: "test-body",
    owner: "agent",
    world: {
      inWorld: true,
      position: { x: 10, y: 64, z: 20 },
      yaw: 0,
      health: 20,
      nearbyBlocks: [],
    },
    permission: "agent",
    generation: 1,
    skills: ["goto", "chop_tree", "mine_block"],
    queued: 0,
    running: 0,
    tick: 100,
    lastSeenAt: 1_000,
    watchdogMs: 2_000,
    incidents: [],
    ...overrides,
  };
}

function state(overrides: Partial<AutonomyState> = {}): AutonomyState {
  return {
    now: 10_000,
    mode: "agent",
    bridge: health(),
    enabled: true,
    lastAttemptAt: 0,
    miningBlockedUntil: 0,
    ...overrides,
  };
}

const log = {
  world: {
    inWorld: true,
    health: 20,
    nearbyBlocks: [{ id: "minecraft:oak_log", count: 1 }],
  },
};

test("stays idle unless the operator explicitly enables autonomy", () => {
  assert.equal(nextAutonomousAction(state({ enabled: false })), null);
  const { enabled: _enabled, ...withoutSetting } = state();
  assert.equal(nextAutonomousAction(withoutSetting), null);
});

test("chops one nearby log instead of wandering", () => {
  const action = nextAutonomousAction(
    state({
      bridge: health({
        world: {
          inWorld: true,
          health: 20,
          nearbyBlocks: [
            { id: "minecraft:birch_log", count: 3 },
            { id: "minecraft:dirt", count: 40 },
          ],
        },
      }),
    }),
  );
  assert.equal(action?.skill.name, "chop_tree");
  assert.deepEqual(action?.skill.args, { count: 1 });
});

test("never invents a goto target when there is nothing actionable nearby", () => {
  // The old implementation walked four blocks along the current heading here,
  // which produced unreachable routes and chat spam on real terrain.
  assert.equal(nextAutonomousAction(state()), null);
});

test("does not turn a failed chop into a blind walk", () => {
  const action = nextAutonomousAction(
    state({
      miningBlockedUntil: 10_000 + 5_000,
      bridge: health(log),
    }),
  );
  assert.equal(action, null);
});

test("never acts without healthy agent ownership", () => {
  const cases: AutonomyState[] = [
    state({ mode: "operator" }),
    state({ mode: "stopped" }),
    state({ bridge: null }),
    state({ bridge: health({ connected: false }) }),
    state({ bridge: health({ owner: "operator" }) }),
    state({ bridge: health({ permission: "stopped" }) }),
    state({ bridge: health({ world: { inWorld: false } }) }),
    state({ bridge: health({ world: { inWorld: true, health: 0 } }) }),
    state({ bridge: health({ world: { inWorld: true, health: 9 } }) }),
  ];
  for (const value of cases) assert.equal(nextAutonomousAction(value), null);
});

test("does not stack work while the body is busy", () => {
  assert.equal(nextAutonomousAction(state({ bridge: health({ queued: 1 }) })), null);
  assert.equal(nextAutonomousAction(state({ bridge: health({ running: 1 }) })), null);
});

test("waits for the cooldown between steps", () => {
  assert.equal(
    nextAutonomousAction(
      state({
        bridge: health(log),
        lastAttemptAt: 10_000 - AUTONOMY_COOLDOWN_MS + 1,
      }),
    ),
    null,
  );
  assert.notEqual(
    nextAutonomousAction(
      state({
        bridge: health(log),
        lastAttemptAt: 10_000 - AUTONOMY_COOLDOWN_MS,
      }),
    ),
    null,
  );
});

test("backs off farther after consecutive failures", () => {
  assert.equal(
    nextAutonomousAction(
      state({
        bridge: health(log),
        lastAttemptAt: 10_000 - AUTONOMY_COOLDOWN_MS,
        consecutiveFailures: 4,
      }),
    ),
    null,
  );
  assert.notEqual(
    nextAutonomousAction(
      state({
        bridge: health(log),
        lastAttemptAt: 10_000 - AUTONOMY_FAILURE_COOLDOWN_MS,
        consecutiveFailures: 4,
      }),
    ),
    null,
  );
});

test("does not issue a skill the body has not advertised", () => {
  assert.equal(
    nextAutonomousAction(
      state({
        bridge: health({
          skills: ["goto"],
          world: {
            inWorld: true,
            health: 20,
            nearbyBlocks: [{ id: "minecraft:oak_log", count: 1 }],
          },
        }),
      }),
    ),
    null,
  );
});

test("does not act while a hostile is close", () => {
  assert.equal(
    nextAutonomousAction(
      state({
        bridge: health({
          world: {
            inWorld: true,
            health: 20,
            nearbyBlocks: [{ id: "minecraft:oak_log", count: 1 }],
            entities: [
              { name: "Zombie", type: "minecraft:zombie", distance: 5 },
            ],
          },
        }),
      }),
    ),
    null,
  );
});

test("pauses while the player has a screen open", () => {
  assert.equal(
    nextAutonomousAction(
      state({
        bridge: health({
          world: {
            inWorld: true,
            health: 20,
            screenOpen: true,
            nearbyBlocks: [{ id: "minecraft:oak_log", count: 1 }],
          },
        }),
      }),
    ),
    null,
  );
});
