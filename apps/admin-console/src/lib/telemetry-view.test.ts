import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentEvent } from "@craftmate/contracts";
import {
  currentWork,
  groupByTrace,
  ingressIsKnown,
  latestTraceGroup,
  pipelineFor,
} from "./telemetry-view.ts";

const event = (overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  id: "evt-1",
  at: 1_000,
  stage: "ingress_received",
  status: "ok",
  traceId: "comment-1",
  taskId: null,
  decisionId: "decision-1",
  goalId: null,
  durationMs: null,
  summary: "",
  errorCode: null,
  source: "ingress",
  ...overrides,
});

describe("workbench telemetry projection", () => {
  test("only reached pipeline stages get a status", () => {
    const [group] = groupByTrace([
      event({ id: "evt-2", at: 1_100, stage: "arbitrated", source: "agent" }),
      event(),
    ]);
    const steps = pipelineFor(group);
    assert.equal(steps.find((step) => step.stage === "ingress_received")?.status, "ok");
    assert.equal(steps.find((step) => step.stage === "arbitrated")?.status, "ok");
    assert.equal(steps.find((step) => step.stage === "planned")?.status, "pending");
    assert.equal(steps.find((step) => step.stage === "task_running")?.status, "pending");
  });

  test("a dropped event marks later stages skipped, not complete", () => {
    const [group] = groupByTrace([
      event({ id: "evt-2", at: 1_050, stage: "dropped", status: "skipped", errorCode: "E_INGRESS_DROPPED" }),
      event(),
    ]);
    const steps = pipelineFor(group);
    assert.equal(steps.find((step) => step.stage === "gated")?.status, "skipped");
    assert.equal(steps.find((step) => step.stage === "gated")?.at, 1_050);
    assert.equal(steps.find((step) => step.stage === "arbitrated")?.status, "skipped");
    assert.equal(steps.find((step) => step.stage === "task_settled")?.status, "skipped");
  });

  test("groups preserve trace, task and decision joins and keep null traces separate", () => {
    const groups = groupByTrace([
      event({ id: "evt-2", at: 2_000, stage: "task_running", taskId: "task-1", source: "goal" }),
      event(),
      event({ id: "evt-3", traceId: null, source: "control", decisionId: null }),
      event({ id: "evt-4", traceId: null, source: "control", decisionId: null }),
    ]);
    const comment = groups.find((group) => group.traceId === "comment-1");
    assert.equal(comment?.taskId, "task-1");
    assert.equal(comment?.decisionId, "decision-1");
    assert.equal(groups.filter((group) => group.traceId === null).length, 2);
  });

  test("a task-only frame joins its trace regardless of arrival order", () => {
    const groups = groupByTrace([
      event({
        id: "evt-voice",
        at: 2_000,
        stage: "voice_settled",
        traceId: null,
        taskId: "task-1",
        decisionId: null,
        source: "voice",
      }),
      event({ id: "evt-2", at: 1_100, stage: "task_running", taskId: "task-1" }),
      event(),
    ]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.traceId, "comment-1");
    assert.deepEqual(
      groups[0]?.events.map((item) => item.stage),
      ["ingress_received", "task_running", "voice_settled"],
    );
  });

  test("a newer system event does not replace the latest comment pipeline", () => {
    const groups = groupByTrace([
      event({
        id: "evt-settings",
        at: 3_000,
        stage: "settings_applied",
        traceId: null,
        decisionId: null,
        source: "control",
      }),
      event({ id: "evt-2", at: 1_100, stage: "task_settled", source: "goal" }),
      event(),
    ]);

    assert.equal(groups[0]?.traceId, null);
    assert.equal(latestTraceGroup(groups)?.traceId, "comment-1");
    assert.equal(latestTraceGroup(groups)?.terminal, "ok");
  });

  test("unknown ingress is not treated as a known zero", () => {
    assert.equal(
      ingressIsKnown({
        state: "unknown",
        detail: "尚未上报",
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
      }),
      false,
    );
    assert.equal(
      ingressIsKnown({
        state: "not_configured",
        detail: "未配置",
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
      }),
      false,
    );
  });

  test("current work never promotes raw comment or task prose into the header", () => {
    const snapshot = {
      mode: "agent" as const,
      stats: { received: 1, decided: 1, executed: 1, refused: 0, observed: 0, openCommitments: 0 },
      decisions: [{
        id: "decision-1",
        eventId: "trace-1",
        nickname: "观众甲",
        text: "这是一段绝不能出现的弹幕原文",
        intent: "mine" as const,
        decision: "EXECUTE" as const,
        priority: "vote" as const,
        reason: "这是一段模型判断理由",
        score: 1,
        stage: "planned" as const,
        speech: "这段语音也不能出现",
      skill: {
        name: "mine_block" as const,
        args: { block: "minecraft:iron_ore" },
        idempotencyKey: "key",
      },
        audienceRef: "hashed-viewer",
        trace: null,
        at: 1_000,
      }],
      operatorNotice: null,
      goal: null,
      proposals: [],
      sourceHealth: null,
      voiceStatus: null,
      bridge: null,
      model: null,
    };
    const work = currentWork(snapshot, {
      summary: "决定执行 mine_block",
      intent: "mine",
      reason: "仲裁与安全闸门给出的确定性判断",
      nextStep: "准备执行 mine_block",
      confidence: "observed",
    });
    assert.equal(work.label, "决定执行 mine_block");
    assert.equal(work.detail.includes("弹幕原文"), false);
    assert.equal(work.detail.includes("模型判断理由"), false);
    assert.match(work.detail, /意图 mine/);
  });

  test("a judgement remains visible when the body is not connected", () => {
    const work = currentWork(
      {
        mode: "agent",
        stats: { received: 0, decided: 0, executed: 0, refused: 0, observed: 0, openCommitments: 0 },
        decisions: [],
        operatorNotice: null,
        goal: null,
        proposals: [],
        sourceHealth: null,
        voiceStatus: null,
        bridge: null,
        model: null,
      },
      {
        summary: "决定排队，等待当前阶段",
        intent: "chat",
        reason: "仲裁与安全闸门给出的确定性判断",
        nextStep: "等待闸门与当前阶段",
        confidence: "observed",
      },
    );
    assert.equal(work.label, "决定排队，等待当前阶段");
    assert.equal(work.tone, "idle");
    assert.match(work.detail, /意图 chat/);
  });
});
