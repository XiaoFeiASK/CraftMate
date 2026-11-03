import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  clientMessageSchema,
  serverMessageSchema,
  showSnapshotSchema,
  type ShowSnapshot,
} from "./control.ts";
import { showSettingsSchema } from "./settings.ts";

const snapshot: ShowSnapshot = {
  mode: "agent",
  stats: { received: 3, decided: 2, executed: 1, refused: 0, observed: 1, openCommitments: 0 },
  decisions: [],
  operatorNotice: null,
  sourceHealth: null,
  voiceStatus: null,
  bridge: null,
  model: {
    state: "disabled",
    provider: null,
    model: null,
    detail: "未配置模型",
  },
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
          settings: {
            goal: "盖房",
            goalProgress: 20,
            worldName: "本地世界",
            gameVersion: "1.21.11",
            accountLabel: "直播号",
            integrations: { douyinRoomId: "", deepseekModel: "" },
            persona: {
              name: "大肥鱼",
              identity: "鲸鱼娘",
              tone: "软糯",
              values: ["不吹牛"],
              boundaries: ["不念隐私"],
              weights: { obedience: 0.6, risk: 0.45, sass: 0.5, patience: 0.5, gluttony: 0.75 },
              voice: { provider: "volcengine", voiceId: "dafeiyu", speed: 1 },
            },
          },
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

  test("settings reject blank labels and out-of-range weights", () => {
    const valid = {
      goal: "盖房",
      goalProgress: 20,
      worldName: "本地世界",
      gameVersion: "1.21.11",
      accountLabel: "直播号",
      integrations: { douyinRoomId: "", deepseekModel: "" },
      persona: {
        name: "大肥鱼",
        identity: "鲸鱼娘",
        tone: "软糯",
        values: [],
        boundaries: [],
        weights: { obedience: 0.6, risk: 0.45, sass: 0.5, patience: 0.5, gluttony: 0.75 },
        voice: { provider: "volcengine", voiceId: "dafeiyu", speed: 1 },
      },
    };
    assert.equal(showSettingsSchema.safeParse(valid).success, true);
    assert.equal(showSettingsSchema.safeParse({ ...valid, goal: "   " }).success, false);
    assert.equal(
      showSettingsSchema.safeParse({
        ...valid,
        persona: { ...valid.persona, weights: { ...valid.persona.weights, risk: 1.4 } },
      }).success,
      false,
    );
  });
});
