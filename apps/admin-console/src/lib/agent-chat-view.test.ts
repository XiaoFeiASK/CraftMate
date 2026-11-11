import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  Decision,
  ShowSnapshot,
  TelemetrySnapshot,
} from "@craftmate/contracts";
import { buildAgentChat, humanizeRuntimeText } from "./agent-chat-view.ts";

const decision = (overrides: Partial<Decision> = {}): Decision => ({
  id: "decision-1",
  eventId: "comment-1",
  nickname: "观众甲",
  text: "这是一段绝不能出现在聊天里的弹幕原文",
  intent: "mine",
  decision: "EXECUTE",
  priority: "vote",
  reason: "这是一段绝不能出现在聊天里的模型理由",
  score: 1,
  stage: "planned",
  skill: {
    name: "chop_tree",
    args: { count: 1 },
    idempotencyKey: "key-1",
  },
  speech: "这段语音原文也不能出现",
  audienceRef: "hashed",
  trace: null,
  outcome: null,
  at: 1_000,
  ...overrides,
});

const snapshot = (decisions: readonly Decision[]): ShowSnapshot => ({
  mode: "agent",
  stats: { received: 1, decided: 1, executed: 1, refused: 0, observed: 0, openCommitments: 0 },
  decisions,
  operatorNotice: null,
  goal: null,
  proposals: [],
  sourceHealth: null,
  voiceStatus: null,
  bridge: null,
  model: null,
});

const telemetry = (
  overrides: Partial<TelemetrySnapshot> = {},
): TelemetrySnapshot => ({
  events: [],
  judgement: null,
  ingress: {
    state: "not_configured",
    detail: "抖音房间未配置",
    roomId: null,
    lastEventAt: null,
    received: null,
    forwarded: null,
    queued: null,
    dropped: null,
    dropReasons: {},
    upstreamConnected: null,
    reconnects: null,
    updatedAt: null,
  },
  generatedAt: 1_000,
  ...overrides,
});

describe("agent chat projection", () => {
  test("raw audience text, reasons and speech stay out of the transcript", () => {
    const turns = buildAgentChat(snapshot([decision()]), telemetry());
    const rendered = JSON.stringify(turns);

    assert.equal(rendered.includes("弹幕原文"), false);
    assert.equal(rendered.includes("模型理由"), false);
    assert.equal(rendered.includes("语音原文"), false);
    assert.equal(turns[0]?.kind, "audience");
    assert.equal(turns[1]?.kind, "agent");
  });

  test("reflex decisions become a safety system line, not an audience bubble", () => {
    const turns = buildAgentChat(
      snapshot([
        decision({
          eventId: "reflex:drowning:1001",
          nickname: "系统",
          intent: "danger",
          decision: "ACK_ONLY",
          skill: null,
        }),
      ]),
      telemetry(),
    );

    assert.deepEqual(turns.map((turn) => turn.kind), ["system", "agent"]);
    assert.match(turns[0]?.kind === "system" ? turns[0].text : "", /溺水/);
  });

  test("a completed action is described as completed instead of waiting", () => {
    const turns = buildAgentChat(
      snapshot([
        decision({
          outcome: {
            status: "completed",
            outcome: {
              changes: [
                {
                  kind: "block_broken",
                  detail: "minecraft:birch_log",
                  position: { x: 32, y: 65, z: 119 },
                },
              ],
            },
            at: 1_100,
          },
        }),
      ]),
      telemetry(),
    );
    const agent = turns.find((turn) => turn.kind === "agent");

    assert.equal(agent?.text, "砍树完成，世界证据已经回传。");
    assert.equal(
      agent?.meta.some((item) => item.value.includes("minecraft:birch_log")),
      true,
    );
  });

  test("a stale judgement is not attached to a different current decision", () => {
    const turns = buildAgentChat(
      snapshot([
        decision({
          id: "decision-2",
          eventId: "reflex:falling:1001",
          intent: "danger",
          decision: "ACK_ONLY",
          skill: null,
        }),
      ]),
      telemetry({
        judgement: {
          summary: "决定执行 mine_block",
          intent: "mine",
          reason: "旧判断",
          nextStep: "准备执行 mine_block",
          confidence: "observed",
        },
      }),
    );

    assert.equal(
      turns.some((turn) => turn.kind === "agent" && turn.text.includes("mine_block")),
      false,
    );
  });

  test("runtime skill names are humanized for the chat surface", () => {
    assert.equal(
      humanizeRuntimeText("决定执行 chop_tree，然后 mine_block"),
      "决定执行 砍树，然后 挖方块",
    );
  });
});
