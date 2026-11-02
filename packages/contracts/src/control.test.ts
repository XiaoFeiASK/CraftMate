import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  clientMessageSchema,
  serverMessageSchema,
  showSnapshotSchema,
  type ShowSnapshot,
} from "./control.ts";

const snapshot: ShowSnapshot = {
  mode: "agent",
  stats: { received: 3, executed: 1, refused: 0, observed: 1, openCommitments: 0 },
  decisions: [],
  operatorNotice: null,
  sourceHealth: null,
};

describe("control protocol", () => {
  test("accepts the hello handshake and rejects unvalidated messages", () => {
    assert.equal(clientMessageSchema.safeParse({ type: "hello" }).success, true);
    assert.equal(clientMessageSchema.safeParse({ type: "comment", payload: {} }).success, false);
  });

  test("accepts a complete snapshot and rejects a missing stats field", () => {
    assert.equal(showSnapshotSchema.safeParse(snapshot).success, true);
    const { openCommitments: _, ...rest } = snapshot.stats;
    assert.equal(showSnapshotSchema.safeParse({ ...snapshot, stats: rest }).success, false);
  });

  test("round-trips ready and operator messages", () => {
    assert.equal(
      serverMessageSchema.safeParse({
        type: "ready",
        payload: {
          persona: { id: "dafeiyu", name: "大肥鱼", identity: "鲸鱼娘", weights: { risk: 0.45 } },
          snapshot,
        },
      }).success,
      true,
    );
    assert.equal(
      serverMessageSchema.safeParse({
        type: "operator",
        payload: { kind: "whisper", text: "先别跳" },
      }).success,
      true,
    );
  });
});
