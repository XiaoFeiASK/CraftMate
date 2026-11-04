import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  bridgeClientFrameSchema,
  bridgeErrorCodeSchema,
  bridgeServerFrameSchema,
  skillOutcomeSchema,
  skillCommandSchema,
  worldEventSchema,
  worldSnapshotSchema,
} from "./bridge.ts";

describe("bridge wire protocol", () => {
  test("round-trips every v1 frame type", () => {
    const frames = [
      { v: 1, type: "hello", token: "t", client: "sim", capabilities: ["mine"], skills: ["mine_block"] },
      { v: 1, type: "ack", id: "c-1", accepted: true, taskId: "t-1" },
      { v: 1, type: "progress", taskId: "t-1", phase: "mining", done: 1, total: 2 },
      { v: 1, type: "result", taskId: "t-1", status: "completed", ticks: 4 },
      {
        v: 1,
        type: "result",
        taskId: "t-2",
        status: "completed",
        data: { block: "minecraft:stone", position: { x: 1, y: 2, z: 3 } },
      },
      { v: 1, type: "event", seq: 1, tick: 2, name: "block_broken", data: {} },
      { v: 1, type: "ownership", owner: "operator", reason: "keyboard" },
      { v: 1, type: "heartbeat", tick: 2, owner: "agent", worldGeneration: 2, world: null },
    ];
    for (const frame of frames) {
      assert.equal(bridgeClientFrameSchema.safeParse(frame).success, true, JSON.stringify(frame));
    }

    const serverFrames = [
      {
        v: 1,
        type: "welcome",
        sessionId: "s",
        owner: "agent",
        generation: 1,
        capabilities: ["mine"],
        skills: ["mine_block"],
        heartbeatMs: 1000,
        watchdogMs: 500,
      },
      {
        v: 1,
        type: "cmd",
        id: "c-1",
        op: "mine_block",
        args: {},
        priority: "command",
        idempotencyKey: "k",
      },
      { v: 1, type: "cancel", taskId: "t-1", id: "c-1", reason: "stop" },
      { v: 1, type: "ownership", owner: "none", reason: "estop" },
      { v: 1, type: "heartbeat", tick: 1, owner: "agent" },
      { v: 1, type: "error", code: "E_SCHEMA", detail: "bad" },
    ];
    for (const frame of serverFrames) {
      assert.equal(bridgeServerFrameSchema.safeParse(frame).success, true, JSON.stringify(frame));
    }
  });

  test("rejects unknown capabilities, missing ids and invalid protocol versions", () => {
    assert.equal(
      bridgeClientFrameSchema.safeParse({
        v: 1,
        type: "hello",
        token: "t",
        client: "sim",
        capabilities: ["teleport"],
        skills: ["goto"],
      }).success,
      false,
    );
    assert.equal(
      skillCommandSchema.safeParse({
        v: 1,
        type: "cmd",
        id: "",
        op: "goto",
        args: {},
        priority: "command",
        idempotencyKey: "k",
      }).success,
      false,
    );
    assert.equal(
      worldEventSchema.safeParse({ v: 2, type: "event", seq: 1, tick: 1, name: "x", data: {} }).success,
      false,
    );
  });

  test("validates bounded semantic world snapshots carried by heartbeats", () => {
    const snapshot = worldSnapshotSchema.parse({
      inWorld: true,
      world: "minecraft:overworld",
      position: { x: 10.25, y: 64, z: -8.5 },
      cameraYaw: 145,
      cameraPitch: -12.5,
      health: 20,
      food: 18,
      hotbar: [{ slot: 0, item: "minecraft:stone", count: 32 }],
      nearbyBlocks: [{ id: "minecraft:stone", count: 12 }],
    });
    assert.equal(snapshot.position?.x, 10.25);
    assert.equal(snapshot.cameraYaw, 145);
    assert.equal(snapshot.cameraPitch, -12.5);
    assert.equal(snapshot.hotbar?.[0]?.count, 32);
    assert.equal(snapshot.nearbyBlocks?.[0]?.count, 12);
    assert.equal(
      worldSnapshotSchema.safeParse({
        inWorld: true,
        hotbar: [{ slot: 9, item: "minecraft:stone", count: 1 }],
      }).success,
      false,
    );
  });

  test("error codes are a closed enum, not free text", () => {
    assert.equal(bridgeErrorCodeSchema.safeParse("E_TIMEOUT").success, true);
    assert.equal(bridgeErrorCodeSchema.safeParse("timeout").success, false);
  });

  test("an interaction outcome distinguishes confirmed changes from unconfirmed submissions", () => {
    const confirmed = skillOutcomeSchema.parse({
      summary: "placed 1 x minecraft:oak_planks",
      changes: [
        {
          kind: "block_placed",
          detail: "minecraft:oak_planks",
          position: { x: 4, y: 65, z: -2 },
        },
      ],
    });
    assert.equal(confirmed.changes?.length, 1);
    assert.equal(confirmed.unconfirmed, undefined);

    const unconfirmed = skillOutcomeSchema.parse({
      summary: "swing submitted",
      unconfirmed: ["attack submission had no observable health change"],
      problem: "attack did not change the target's health",
    });
    assert.deepEqual(unconfirmed.changes, undefined);
    assert.equal(unconfirmed.unconfirmed?.length, 1);

    assert.equal(
      skillOutcomeSchema.safeParse({ changes: [{ kind: "", detail: "" }] }).success,
      false,
    );
  });
});
