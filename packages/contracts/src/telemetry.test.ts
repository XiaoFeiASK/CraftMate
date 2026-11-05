import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  agentEventSchema,
  ingressMetricsFrameSchema,
  telemetrySnapshotSchema,
} from "./telemetry.ts";

describe("agent telemetry contract", () => {
  test("round-trips the join keys the console groups by", () => {
    const parsed = agentEventSchema.parse({
      id: "evt-1",
      at: 1_000,
      stage: "task_settled",
      status: "degraded",
      traceId: "comment-1",
      taskId: "task-1",
      decisionId: "decision-1",
      goalId: "goal-1",
      durationMs: 42,
      summary: "任务完成：挖到 3 块铁矿",
      errorCode: null,
      source: "bridge",
    });
    assert.equal(parsed.traceId, "comment-1");
    assert.equal(parsed.taskId, "task-1");
    assert.equal(parsed.decisionId, "decision-1");
    assert.equal(parsed.goalId, "goal-1");
  });

  test("bounds summaries and rejects a negative duration", () => {
    assert.equal(
      agentEventSchema.safeParse({
        id: "evt-1",
        at: 1_000,
        stage: "planned",
        summary: "x".repeat(601),
        source: "agent",
      }).success,
      false,
    );
    assert.equal(
      agentEventSchema.safeParse({
        id: "evt-1",
        at: 1_000,
        stage: "planned",
        durationMs: -1,
        source: "agent",
      }).success,
      false,
    );
  });

  test("a metrics frame accepts unknown counters but never a fabricated negative", () => {
    assert.equal(
      ingressMetricsFrameSchema.safeParse({
        state: "open",
        detail: "监听中",
        lastEventAt: null,
        received: 0,
        forwarded: 0,
        queued: 0,
        dropped: 0,
        dropReasons: {},
        upstreamConnected: true,
        reconnects: 0,
      }).success,
      true,
    );
    assert.equal(
      ingressMetricsFrameSchema.safeParse({
        state: "open",
        detail: "监听中",
        lastEventAt: null,
        received: -1,
        forwarded: 0,
        queued: 0,
        dropped: 0,
        dropReasons: {},
        upstreamConnected: true,
        reconnects: 0,
      }).success,
      false,
    );
    const empty = telemetrySnapshotSchema.parse({
      events: [],
      judgement: null,
      ingress: {
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
      },
      generatedAt: 0,
    });
    assert.equal(empty.ingress.received, null);
  });
});
