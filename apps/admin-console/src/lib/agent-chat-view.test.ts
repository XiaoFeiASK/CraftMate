import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  BodyEvent,
  Decision,
  Proposal,
  ShowSnapshot,
  TelemetrySnapshot,
} from "@craftmate/contracts";
import { buildAgentChat, humanizeRuntimeText } from "./agent-chat-view.ts";

const decision = (overrides: Partial<Decision> = {}): Decision => ({
  id: "decision-1",
  eventId: "comment-1",
  nickname: "观众甲",
  text: "帮我砍点木头",
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
  speech: "好，我去砍树。",
  audienceRef: "hashed",
  trace: null,
  outcome: null,
  at: 1_000,
  ...overrides,
});

const snapshot = (
  decisions: readonly Decision[],
  proposals: readonly Proposal[] = [],
): ShowSnapshot => ({
  mode: "agent",
  stats: { received: 1, decided: 1, executed: 1, refused: 0, observed: 0, openCommitments: 0 },
  decisions,
  operatorNotice: null,
  goal: null,
  proposals,
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
  test("the conversation uses audience text and the agent's planned speech", () => {
    const turns = buildAgentChat(snapshot([decision()]), telemetry());

    assert.equal(turns[0]?.kind, "audience");
    assert.equal(turns[0]?.kind === "audience" ? turns[0].text : "", "帮我砍点木头");
    assert.equal(turns[1]?.kind, "agent");
    assert.equal(turns[1]?.kind === "agent" ? turns[1].text : "", "好，我去砍树。");
    assert.equal(JSON.stringify(turns).includes("模型理由"), false);
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

    assert.equal(agent?.text, "挖到了，材料已经收进背包。");
    assert.equal(
      agent?.meta.some((item) => item.label === "结果" && item.value.includes("1 处变化")),
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

  test("audience proposals are part of the conversation and can be decided inline", () => {
    const proposal: Proposal = {
      id: "proposal-1",
      sourceEventId: "comment-1",
      audienceRef: "viewer:hashed",
      text: "去挖点铁矿吧",
      votes: 3,
      intent: "mine",
      status: "pending",
      reason: "gate reason",
      risk: "low",
      goalAlignment: "aligned",
      createdAt: 1_000,
      decidedAt: null,
    };
    const turns = buildAgentChat(snapshot([decision()], [proposal]), telemetry());
    const turn = turns.find((entry) => entry.kind === "proposal");

    assert.equal(turn?.kind === "proposal" ? turn.text : "", "去挖点铁矿吧");
    assert.equal(turn?.kind === "proposal" ? turn.status : "", "pending");
    assert.equal(turns.filter((entry) => entry.kind === "proposal").length, 1);
  });

  test("body events replace the duplicate reflex origin line", () => {
    const worldEvent: BodyEvent = {
      name: "reflex",
      data: { kind: "falling", detail: "正在从高处下落", health: 12.5 },
      at: 1_000,
    };
    const turns = buildAgentChat(
      snapshot([
        decision({
          eventId: "reflex:falling:1001",
          nickname: "系统",
          intent: "danger",
          decision: "ACK_ONLY",
          skill: null,
        }),
      ]),
      telemetry(),
      [worldEvent],
    );

    assert.equal(
      turns.filter((turn) => turn.kind === "system" && turn.text.includes("坠落")).length,
      1,
    );
    assert.equal(
      turns.find((turn) => turn.kind === "system")?.text,
      "身体避险 · 坠落 · 正在从高处下落 · 生命 12.5",
    );
  });

  test("runtime skill names are humanized for the chat surface", () => {
    assert.equal(
      humanizeRuntimeText("决定执行 chop_tree，然后 mine_block"),
      "决定执行 砍树，然后 挖方块",
    );
  });
});
