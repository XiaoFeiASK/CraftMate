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
  goal: null,
  proposals: [],
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
          integrations: {
            model: {
              provider: "deepseek",
              baseUrl: "https://www.yyapi.cloud/v1",
              model: "deepseek-v4.1-flash",
              apiKeyConfigured: true,
              timeoutMs: 10_000,
            },
            voice: {
              provider: "volcengine-realtime",
              url: "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue",
              voiceId: "zh_female_vv_uranus_bigtts",
              apiKeyConfigured: true,
              instructions: "忠实朗读。",
              timeoutMs: 300_000,
            },
            douyin: { roomId: "", dyhubUrl: "ws://127.0.0.1:8757" },
          },
          settings: {
            goal: "盖房",
            goalDescription: "盖一间房子",
            goalMode: false,
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

  test("goal control is operator-only and proposals carry explicit gates", () => {
    assert.equal(
      clientMessageSchema.safeParse({
        type: "goalSet",
        payload: { title: "击败末影龙", description: "完整生存链" },
      }).success,
      true,
    );
    assert.equal(clientMessageSchema.safeParse({ type: "goalPause" }).success, true);
    assert.equal(clientMessageSchema.safeParse({ type: "goalResume" }).success, true);
    assert.equal(
      clientMessageSchema.safeParse({
        type: "proposalDecision",
        payload: { proposalId: "p1", status: "accepted", reason: "符合当前阶段" },
      }).success,
      true,
    );
    assert.equal(
      showSnapshotSchema.parse({
        ...snapshot,
        goal: {
          goalId: "g1",
          goalVersion: 1,
          status: "unverified",
          stage: { id: "wood", title: "获得木头" },
          milestone: { id: "logs", title: "背包有原木" },
          nextTask: "chop_tree",
          milestones: [],
          completed: 0,
          unverified: 0,
          lastFailure: null,
          updatedAt: 1,
        },
      }).goal?.status,
      "unverified",
    );
  });

  test("settings reject blank labels and out-of-range weights", () => {
    const valid = {
      goal: "盖房",
      goalDescription: "盖一间房子",
      goalMode: false,
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
    // Older rows without the new goal fields must keep working.
    const { goalDescription: _description, goalMode: _mode, ...legacy } = valid;
    assert.deepEqual(showSettingsSchema.parse(legacy).goalMode, false);
    assert.equal(showSettingsSchema.parse(legacy).goalDescription, "");
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
