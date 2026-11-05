import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentEvent, IngressMetricsFrame } from "@craftmate/contracts";
import {
  AgentTelemetry,
  dispatchDirectSkill,
  failDirectDispatch,
  notConfiguredIngress,
  projectIngressFacts,
  TaskTelemetry,
  TaskDispatchError,
  unknownIngress,
} from "./telemetry.ts";

type Fact = IngressMetricsFrame["recent"][number];

function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "comment-1",
    at: 1_000,
    kind: "comment",
    accepted: true,
    reason: "",
    latencyMs: 12,
    ...overrides,
  };
}

describe("ingress telemetry projection", () => {
  test("an unconfigured or reset ingress has no numeric throughput", () => {
    for (const metrics of [
      unknownIngress("Ingress 正在连接新配置"),
      notConfiguredIngress(),
    ]) {
      assert.equal(metrics.received, null);
      assert.equal(metrics.forwarded, null);
      assert.equal(metrics.queued, null);
      assert.equal(metrics.dropped, null);
      assert.deepEqual(metrics.dropReasons, {});
      assert.equal(metrics.upstreamConnected, null);
      assert.equal(metrics.reconnects, null);
    }
  });

  test("an admitted fact is received and gated exactly once", () => {
    const seen = new Set<string>();
    const facts = [fact()];

    const first = projectIngressFacts(facts, seen);
    assert.deepEqual(first.map((event) => event.stage), ["ingress_received", "gated"]);
    assert.equal(first.every((event) => event.traceId === "comment-1"), true);
    assert.match(first[1]?.summary ?? "", /12ms/);

    // A reconnect replays the same bounded window; the second call must not
    // duplicate the pair in the event feed.
    assert.deepEqual(projectIngressFacts(facts, seen), []);
  });

  test("a dropped fact is received, then explicitly dropped instead of gated", () => {
    const seen = new Set<string>();
    const projected = projectIngressFacts(
      [
        fact({
          id: "comment-drop",
          accepted: false,
          reason: "rate limited",
          latencyMs: null,
        }),
      ],
      seen,
    );

    assert.deepEqual(projected.map((event) => event.stage), ["ingress_received", "dropped"]);
    assert.equal(projected[1]?.status, "skipped");
    assert.equal(projected[1]?.errorCode, "E_INGRESS_DROPPED");
    assert.match(projected[1]?.summary ?? "", /rate limited/);
    assert.equal(projected.some((event) => event.stage === "gated"), false);
  });

  test("old facts are forgotten so a later retry can be reported", () => {
    const seen = new Set<string>();
    projectIngressFacts([fact({ id: "first" })], seen);
    // The window moved on; the orchestrator forgets facts it can no longer
    // see, otherwise a retry with the same id would be silently suppressed.
    projectIngressFacts([fact({ id: "second" })], seen);
    const retried = projectIngressFacts(
      [fact({ id: "first", accepted: false, reason: "duplicate" })],
      seen,
    );

    assert.deepEqual(retried.map((event) => event.stage), ["ingress_received", "dropped"]);
  });
});

describe("direct task lifecycle telemetry", () => {
  test("queues, issues, runs, then joins progress to the visible task id", () => {
    const recorded: AgentEvent[] = [];
    const telemetry = new AgentTelemetry({
      history: [],
      now: () => 2_000,
    });
    const publish = (input: Parameters<typeof telemetry.record>[0]): void => {
      recorded.push(telemetry.record(input));
    };
    const taskTelemetry = new TaskTelemetry(publish);
    const issued: string[] = [];

    const commandId = dispatchDirectSkill({
      decision: {
        id: "decision-1",
        eventId: "comment-1",
        skill: {
          name: "mine_block",
          args: { block: "minecraft:stone", count: 1 },
          idempotencyKey: "direct-key",
        },
        priority: "command",
      },
      taskTelemetry,
      goalId: "goal-1",
      issue: (command) => issued.push(command.id),
      commandId: "command-1",
    });

    assert.equal(commandId, "command-1");
    assert.deepEqual(issued, ["command-1"]);
    assert.equal(taskTelemetry.taskId("decision-1"), "command-1");
    assert.deepEqual(recorded.map((event) => event.stage), ["task_queued", "task_running"]);
    assert.equal(recorded.every((event) => event.taskId === "command-1"), true);
    assert.equal(recorded.every((event) => event.decisionId === "decision-1"), true);
    assert.equal(recorded.every((event) => event.traceId === "comment-1"), true);

    const settledTaskId = taskTelemetry.settled({
      decisionId: "decision-1",
      traceId: "comment-1",
      // The body's task id is different; the operator-visible id must win.
      taskId: "body-task-1",
      status: "ok",
      summary: "任务完成",
      source: "bridge",
    });
    assert.equal(settledTaskId, "command-1");
    assert.equal(recorded.at(-1)?.taskId, "command-1");
    assert.equal(recorded.at(-1)?.stage, "task_settled");
    assert.equal(taskTelemetry.taskId("decision-1"), null);
  });

  test("an issue failure emits queued before the throw and never claims running", () => {
    const stages: string[] = [];
    const taskTelemetry = new TaskTelemetry((event) => {
      stages.push(event.stage);
    });

    let failure: unknown;
    try {
      dispatchDirectSkill({
        decision: {
          id: "decision-2",
          eventId: "comment-2",
          skill: {
            name: "mine_block",
            args: { block: "minecraft:stone" },
            idempotencyKey: "failed-key",
          },
          priority: "command",
        },
        taskTelemetry,
        goalId: null,
        issue: () => {
          throw new Error("body is not connected");
        },
        commandId: "command-2",
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof TaskDispatchError);
    assert.equal(failure.taskId, "command-2");
    assert.equal(failure.code, "E_INTERNAL");
    assert.deepEqual(stages, ["task_queued"]);
  });

  test("a queued task whose issue fails settles visibly", () => {
    const recorded: AgentEvent[] = [];
    const telemetry = new AgentTelemetry({ history: [], now: () => 3_000 });
    const taskTelemetry = new TaskTelemetry((event) => {
      recorded.push(telemetry.record(event));
    });

    let failure: TaskDispatchError | null = null;
    try {
      dispatchDirectSkill({
        decision: {
          id: "decision-3",
          eventId: "comment-3",
          skill: {
            name: "mine_block",
            args: { block: "minecraft:stone" },
            idempotencyKey: "unjoined-key",
          },
          priority: "command",
        },
        taskTelemetry,
        goalId: null,
        issue: () => {
          throw new Error("no body");
        },
        commandId: "command-3",
      });
    } catch (error) {
      assert.ok(error instanceof TaskDispatchError);
      failure = error;
    }
    assert.ok(failure);
    failDirectDispatch({
      taskTelemetry,
      decision: { id: "decision-3", eventId: "comment-3" },
      error: failure,
    });

    assert.deepEqual(
      recorded.map((event) => [event.stage, event.taskId]),
      [
        ["task_queued", "command-3"],
        ["task_settled", "command-3"],
      ],
    );
    assert.equal(recorded.at(-1)?.status, "failed");
  });
});
