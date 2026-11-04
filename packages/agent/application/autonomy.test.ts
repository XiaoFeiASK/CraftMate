import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeHealth } from "@craftmate/contracts";
import {
  AUTONOMY_COOLDOWN_MS,
  AUTONOMY_STUCK_TURN_DEGREES,
  AUTONOMY_TURN_DEGREES,
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
    lastAttemptAt: 0,
    sequence: 0,
    origin: null,
    spawn: null,
    miningBlockedUntil: 0,
    ...overrides,
  };
}

test("chops a nearby log before exploring", () => {
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

test("explores four blocks when there is no nearby log", () => {
  const action = nextAutonomousAction(state());
  assert.equal(action?.skill.name, "goto");
  const target = action?.skill.args.target as { x: number; y: number; z: number };
  assert.equal(target.x, 10);
  assert.equal(target.y, 64);
  assert.equal(target.z, 24);
});

test("rotates the exploration heading between steps", () => {
  const action = nextAutonomousAction(state({ sequence: 3 }));
  const target = action?.skill.args.target as { x: number; y: number; z: number };
  const yaw = (AUTONOMY_TURN_DEGREES * 3 * Math.PI) / 180;
  assert.ok(Math.abs(target.x - (10 - Math.sin(yaw) * 4)) < 0.0001);
  assert.ok(Math.abs(target.z - (20 + Math.cos(yaw) * 4)) < 0.0001);
});

test("keeps the current heading until a route actually fails", () => {
  const first = nextAutonomousAction(state());
  const second = nextAutonomousAction(state());
  assert.deepEqual(first?.skill.args.target, second?.skill.args.target);
  assert.match(first?.reason ?? "", /沿当前朝向/);
});

test("explores on its navigation heading instead of the camera yaw", () => {
  const action = nextAutonomousAction(
    state({
      heading: 90,
      bridge: health({
        world: {
          inWorld: true,
          position: { x: 10, y: 64, z: 20 },
          yaw: 0,
          health: 20,
          nearbyBlocks: [],
        },
      }),
    }),
  );
  const target = action?.skill.args.target as { x: number; y: number; z: number };
  assert.ok(Math.abs(target.x - 6) < 0.0001);
  assert.ok(Math.abs(target.z - 20) < 0.0001);
});

test("a failed route turns by 45 degrees instead of a fixed square", () => {
  const action = nextAutonomousAction(state({ sequence: 1 }));
  const target = action?.skill.args.target as { x: number; y: number; z: number };
  const yaw = (AUTONOMY_TURN_DEGREES * Math.PI) / 180;
  assert.ok(Math.abs(target.x - (10 - Math.sin(yaw) * 4)) < 0.0001);
  assert.ok(Math.abs(target.z - (20 + Math.cos(yaw) * 4)) < 0.0001);
  assert.match(action?.reason ?? "", /转向后继续探索/);
});

test("turns farther after repeated route failures", () => {
  const action = nextAutonomousAction(state({ sequence: 2, routeFailures: 2 }));
  const target = action?.skill.args.target as { x: number; y: number; z: number };
  const yaw = (AUTONOMY_STUCK_TURN_DEGREES * 2 * Math.PI) / 180;
  assert.ok(Math.abs(target.x - (10 - Math.sin(yaw) * 4)) < 0.0001);
  assert.ok(Math.abs(target.z - (20 + Math.cos(yaw) * 4)) < 0.0001);
});

test("steps back toward the exploration centre instead of walking to an exact point", () => {
  const action = nextAutonomousAction(
    state({
      origin: { x: 0, z: 0 },
      bridge: health({
        world: {
          inWorld: true,
          position: { x: 11, y: 64, z: 0 },
          yaw: -90,
          health: 20,
          nearbyBlocks: [],
        },
      }),
    }),
  );
  assert.equal(action?.skill.name, "goto");
  assert.deepEqual(action?.skill.args.target, { x: 7, y: 64, z: 0 });
  assert.match(action?.reason ?? "", /边界/);
});

test("explores while mining is paused after a failed chop", () => {
  const action = nextAutonomousAction(
    state({
      miningBlockedUntil: 10_000 + 5_000,
      bridge: health({
        world: {
          inWorld: true,
          health: 20,
          position: { x: 10, y: 64, z: 20 },
          yaw: 0,
          nearbyBlocks: [{ id: "minecraft:oak_log", count: 1 }],
        },
      }),
    }),
  );
  assert.equal(action?.skill.name, "goto");
  assert.doesNotMatch(action?.reason ?? "", /原木/);
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
  ];
  for (const value of cases) assert.equal(nextAutonomousAction(value), null);
});

test("does not stack work while the body is busy", () => {
  assert.equal(nextAutonomousAction(state({ bridge: health({ queued: 1 }) })), null);
  assert.equal(nextAutonomousAction(state({ bridge: health({ running: 1 }) })), null);
});

test("waits for the cooldown between steps", () => {
  assert.equal(
    nextAutonomousAction(state({ lastAttemptAt: 10_000 - AUTONOMY_COOLDOWN_MS + 1 })),
    null,
  );
  assert.notEqual(
    nextAutonomousAction(state({ lastAttemptAt: 10_000 - AUTONOMY_COOLDOWN_MS })),
    null,
  );
});

test("does not issue a skill the body has not advertised", () => {
  assert.equal(
    nextAutonomousAction(state({ bridge: health({ skills: ["chop_tree"] }) })),
    null,
  );
});
