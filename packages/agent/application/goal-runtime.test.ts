import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BridgeHealth, SkillCall } from "@craftmate/contracts";
import type { Clock } from "./ports/clock.ts";
import {
  GoalRuntime,
  MemoryGoalRuntimeStore,
  SurvivalGoalPlanner,
  type GoalPlan,
  type GoalPlanner,
  type GoalRuntimeContext,
} from "./goal-runtime.ts";
import type { TaskFailure } from "../domain/index.ts";

function testClock(): { readonly clock: Clock; advance(ms: number): void } {
  let now = 1_000;
  let sequence = 0;
  return {
    clock: {
      now: () => now,
      newId: () => `id-${(sequence += 1)}`,
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

function health(overrides: Partial<BridgeHealth> = {}): BridgeHealth {
  return {
    connected: true,
    client: "test-body",
    owner: "agent",
    world: { inWorld: true, health: 20, screenOpen: false },
    permission: "agent",
    generation: 1,
    skills: ["chop_tree"],
    queued: 0,
    running: 0,
    tick: 10,
    lastSeenAt: 1_000,
    watchdogMs: 2_000,
    incidents: [],
    ...overrides,
  };
}

function context(overrides: Partial<GoalRuntimeContext> = {}): GoalRuntimeContext {
  return {
    mode: "agent",
    bridge: health(),
    world: { inWorld: true, health: 20, screenOpen: false },
    ...overrides,
  };
}

const skill: SkillCall = {
  name: "chop_tree",
  args: { count: 1 },
  idempotencyKey: "chop-1",
};

function planner(
  overrides: Partial<GoalPlan> = {},
  task: SkillCall | null = skill,
  taskId?: string,
): GoalPlanner {
  return {
    plan: () => ({
      stage: { id: "wood", title: "获得木头" },
      milestone: { id: "logs", title: "背包有原木" },
      nextTask: task === null
        ? null
        : {
            intent: "mine",
            text: "砍一根原木",
            reason: "目标：获得木头",
            skill: task,
            ...(taskId === undefined ? {} : { taskId }),
          },
      milestones: [
        { id: "logs", title: "背包有原木", status: "unverified" },
        { id: "table", title: "制作工作台", status: "unverified" },
      ],
      verified: false,
      ...overrides,
    }),
  };
}

function runtime(goalPlanner: GoalPlanner = planner()) {
  const { clock, advance } = testClock();
  const store = new MemoryGoalRuntimeStore();
  const value = new GoalRuntime({ store, planner: goalPlanner, clock, failureBaseMs: 2_000 });
  value.restore();
  value.setGoal({ title: "击败末影龙", description: "完整生存链" });
  return { value, clock, advance, store };
}

describe("goal runtime", () => {
  test("issues one task at a time and waits for its terminal outcome", () => {
    const { value } = runtime();
    const first = value.beginStep(context());
    assert.ok(first);
    assert.equal(first.decision.decision, "EXECUTE");
    assert.equal(first.decision.skill?.name, "chop_tree");
    assert.equal(value.beginStep(context()), null);

    assert.equal(
      value.settle(first.decision.id, {
        status: "completed",
        at: 2_000,
        changes: [{ kind: "block_broken", detail: "minecraft:oak_log" }],
      }),
      true,
    );
    const second = value.beginStep(context());
    assert.ok(second);
    assert.notEqual(second.decision.id, first.decision.id);
  });

  test("unverified progress stays explicit and never becomes a percentage", () => {
    const { value } = runtime();
    value.beginStep(context());
    const progress = value.currentProgress;
    assert.equal(progress?.status, "unverified");
    assert.equal(progress?.completed, 0);
    assert.equal(progress?.unverified, 2);
    assert.equal("percent" in (progress ?? {}), false);
  });

  test("pause interrupts the in-flight task and release resumes planning", () => {
    const { value } = runtime();
    const first = value.beginStep(context());
    assert.ok(first);
    const interruption = value.pause();
    assert.equal(interruption?.decisionId, first.decision.id);
    assert.equal(interruption?.commandId, first.commandId);
    assert.equal(value.beginStep(context()), null);
    assert.equal(value.currentProgress?.status, "paused");

    value.resume();
    assert.notEqual(value.beginStep(context()), null);
  });

  test("operator takeover pauses without issuing another task", () => {
    const { value } = runtime();
    assert.equal(value.beginStep(context({ mode: "operator" })), null);
    assert.equal(value.currentProgress?.status, "paused");
    assert.match(value.currentProgress?.lastFailure ?? "", /接管或急停/);
  });

  test("a threat does not pause the planner that must choose fight or flight", () => {
    const { value } = runtime();
    const next = value.beginStep(
      context({
        bridge: health({
          incidents: [{ kind: "threat", detail: "骷髅离你 6 格", at: 1_000 }],
        }),
      }),
    );
    assert.ok(next);
    assert.equal(next.decision.skill?.name, "chop_tree");
    assert.notEqual(value.currentProgress?.status, "paused");
  });

  test("a failed strategy backs off and keeps the autonomous run alive", () => {
    const { value, advance } = runtime();
    const first = value.beginStep(context());
    assert.ok(first);
    value.settle(first.decision.id, {
      status: "failed",
      errorCode: "E_PRECONDITION",
      detail: "没有可站立的接近点",
      at: 1_000,
    });
    assert.equal(value.beginStep(context()), null);
    advance(2_000);
    assert.equal(value.currentProgress?.consecutiveFailures, 1);
    assert.equal(value.currentProgress?.retryAt, 3_000);
    const retry = value.beginStep(context());
    assert.ok(retry);
    assert.notEqual(retry.decision.skill?.idempotencyKey, first.decision.skill?.idempotencyKey);

    value.settle(retry.decision.id, {
      status: "failed",
      errorCode: "E_PRECONDITION",
      detail: "仍然没有可站立的接近点",
      at: 3_500,
    });
    advance(4_500);
    assert.equal(value.currentProgress?.status, "active");
    assert.match(value.currentProgress?.lastFailure ?? "", /仍然没有可站立的接近点/);
    assert.equal(value.currentProgress?.consecutiveFailures, 2);
    assert.notEqual(value.currentProgress?.retryAt, null);
    advance(value.currentProgress?.retryAt ?? 0);
    assert.ok(value.beginStep(context()));
  });

  test("a success clears the retry projection instead of leaving a stale backoff", () => {
    const { value, advance } = runtime();
    const first = value.beginStep(context());
    assert.ok(first);
    value.settle(first.decision.id, {
      status: "failed",
      errorCode: "E_PRECONDITION",
      detail: "暂时无法接近",
      at: 1_000,
    });
    assert.notEqual(value.currentProgress?.retryAt, null);
    advance(2_000);

    value.setGoal({ title: "重新开始", description: "清除旧退避" });
    const next = value.beginStep(context());
    assert.ok(next);
    value.settle(next.decision.id, {
      status: "completed",
      at: 4_000,
      changes: [{ kind: "block_broken", detail: "minecraft:oak_log" }],
    });
    assert.equal(value.currentProgress?.consecutiveFailures, 0);
    assert.equal(value.currentProgress?.retryAt, null);
  });

  test("failure evidence keeps the task id separate from the strategy key", () => {
    const { value } = runtime(planner({ strategyKey: "wood:chop" }, {
      ...skill,
      idempotencyKey: "chop-real",
    }, "task:real-1"));
    const first = value.beginStep(context());
    assert.ok(first);
    assert.equal(first.taskId, "task:real-1");
    assert.equal(first.strategyKey, "wood:chop");
    value.settle(first.decision.id, {
      status: "failed",
      errorCode: "E_PRECONDITION",
      detail: "没有可站立的接近点",
      at: 1_000,
    });
    const stored = value.snapshot();
    assert.equal(stored.failures?.[0]?.taskId, "task:real-1");
    assert.equal(stored.lastFailureStrategy, "wood:chop");
  });

  test("goal replacement increments the version and invalidates work", () => {
    const { value } = runtime();
    const first = value.beginStep(context());
    assert.ok(first);
    const replacement = value.setGoal({ title: "盖一间小屋", description: "海边" });
    assert.equal(replacement.goal.version, 2);
    assert.equal(replacement.interruption?.decisionId, first.decision.id);
    assert.equal(value.currentProgress?.goalVersion, 2);
  });

  test("restore keeps the goal and discards the old in-flight plan", () => {
    const { clock } = testClock();
    const store = new MemoryGoalRuntimeStore();
    const first = new GoalRuntime({ store, planner: planner(), clock });
    first.setGoal({ title: "击败末影龙", description: "完整生存链" });
    const issued = first.beginStep(context());
    assert.ok(issued);
    assert.notEqual(store.load()?.currentDecisionId, null);

    const restored = new GoalRuntime({ store, planner: planner(), clock });
    restored.restore();
    assert.equal(restored.currentGoal?.title, "击败末影龙");
    assert.equal(restored.snapshot().currentDecisionId, null);
    assert.match(restored.currentProgress?.lastFailure ?? "", /重启前任务终态未知/);

    const resumed = restored.beginStep(context());
    assert.ok(resumed);
    assert.notEqual(resumed.decision.eventId, issued.decision.eventId);
  });

  test("survival planner derives the real first task from observed facts", () => {
    const goalPlanner = new SurvivalGoalPlanner();
    const plan = goalPlanner.plan({
      goal: {
        id: "goal-1",
        title: "击败末影龙",
        description: "完整生存链",
        status: "active",
        version: 1,
        setBy: "operator",
        setAt: 1_000,
      },
      progress: {
        goalId: "goal-1",
        goalVersion: 1,
        status: "unverified",
        stage: { id: "wood-and-table", title: "木头与工作台" },
        milestone: { id: "have-log", title: "已获得木头" },
        nextTask: "",
        milestones: [],
        completed: 0,
        unverified: 0,
        lastFailure: null,
        consecutiveFailures: 0,
        retryAt: null,
        updatedAt: 1_000,
      },
      world: {
        inWorld: true,
        inventory: [],
        nearbyBlocks: [{ id: "minecraft:oak_log" }],
      },
      health: health({ skills: ["chop_tree", "craft", "place_block"] }),
      proposals: [],
      lastFailure: null,
      consecutiveFailures: 0,
    });
    assert.equal(plan.stage.id, "wood-and-table");
    assert.equal(plan.nextTask?.skill.name, "chop_tree");
    assert.equal(plan.verified, false);
    assert.ok(plan.milestones.some((milestone) => milestone.status === "completed") === false);
  });

  test("survival planner reports a real blocked reason instead of inventing a task", () => {
    const plan = new SurvivalGoalPlanner().plan({
      goal: {
        id: "goal-1",
        title: "获得铁器",
        description: "",
        status: "active",
        version: 1,
        setBy: "operator",
        setAt: 1_000,
      },
      progress: {
        goalId: "goal-1",
        goalVersion: 1,
        status: "unverified",
        stage: { id: "iron", title: "铁器与熔炉" },
        milestone: { id: "have-furnace", title: "背包或附近有熔炉" },
        nextTask: "",
        milestones: [],
        completed: 0,
        unverified: 0,
        lastFailure: null,
        consecutiveFailures: 0,
        retryAt: null,
        updatedAt: 1_000,
      },
      world: { inWorld: true, inventory: [] },
      health: health({ skills: ["chop_tree", "craft", "place_block", "mine_block"] }),
      proposals: [],
      lastFailure: null,
      consecutiveFailures: 0,
    });
    assert.equal(plan.nextTask, null);
    assert.ok((plan.blockedReason ?? "").length > 0);
  });

  test("restore keeps failure history so a failed strategy is not replayed", () => {
    const { value, store } = runtime();
    const first = value.beginStep(context());
    assert.ok(first);
    value.settle(first.decision.id, {
      status: "failed",
      errorCode: "E_PRECONDITION",
      detail: "附近没有可站立的接近点",
      at: 1_000,
    });
    assert.equal(store.load()?.failures?.length, 1);

    const restored = new GoalRuntime({ store, planner: planner(), clock: testClock().clock });
    restored.restore();
    assert.equal(restored.snapshot().failures?.length, 1);
    assert.match(restored.snapshot().lastFailureStrategy ?? "", /chop_tree/);
  });

  test("a successful task resets the same-stage failure sequence", () => {
    let calls = 0;
    const alternating: GoalPlanner = {
      plan: () => {
        calls += 1;
        const next =
          calls === 1
            ? skill
            : { ...skill, args: { count: 2 }, idempotencyKey: "chop-2" };
        return {
          stage: { id: "wood", title: "获得木头" },
          milestone: { id: "logs", title: "背包有原木" },
          nextTask: {
            intent: "mine",
            text: "砍一根原木",
            reason: "目标：获得木头",
            skill: next,
            taskId: `task:${calls}`,
          },
          milestones: [],
          verified: false,
        };
      },
    };
    const { value, advance, store } = runtime(alternating);
    const first = value.beginStep(context());
    assert.ok(first);
    value.settle(first.decision.id, {
      status: "failed",
      errorCode: "E_PRECONDITION",
      detail: "第一次失败",
      at: 1_000,
    });
    assert.equal(store.load()?.failures?.length, 1);

    advance(2_001);
    const second = value.beginStep(context());
    assert.ok(second);
    value.settle(second.decision.id, {
      status: "completed",
      at: 4_000,
      changes: [{ kind: "block_broken", detail: "minecraft:oak_log" }],
    });
    assert.equal(store.load()?.failures?.length, 0);

    const third = value.beginStep(context());
    assert.ok(third);
    value.settle(third.decision.id, {
      status: "failed",
      errorCode: "E_PRECONDITION",
      detail: "成功后再次失败",
      at: 5_000,
    });
    assert.deepEqual(
      store.load()?.failures?.map((entry) => entry.detail),
      ["成功后再次失败"],
    );
  });

  test("survival recovery counts the current failure once", () => {
    const failure: TaskFailure = {
      taskId: "task:previous-chop",
      stage: "wood-and-table",
      code: "E_PRECONDITION",
      detail: "tree is behind a wall",
      attempts: 1,
    };
    const plan = new SurvivalGoalPlanner().plan({
      goal: goal(),
      progress: progress(),
      world: {
        inWorld: true,
        inventory: [{ section: "main", slot: 9, item: "minecraft:oak_log", count: 1 }],
      },
      health: health({ skills: ["chop_tree", "craft", "place_block"] }),
      proposals: [],
      lastFailure: failure.detail,
      consecutiveFailures: 1,
      failures: [failure],
      lastFailureStrategy: "wood-and-table:craft:craft:{\"count\":1,\"item\":\"minecraft:oak_planks\"}",
    });
    assert.equal(plan.nextTask?.skill.name, "craft");
    assert.equal(plan.blockedReason, null);
  });

  test("survival recovery retries a repeated strategy after fresh observation", () => {
    const first: TaskFailure = {
      taskId: "task:wood-and-table:craft:craft:{\"count\":1,\"item\":\"minecraft:oak_planks\"}",
      stage: "wood-and-table",
      code: "E_PRECONDITION",
      detail: "planks were not crafted",
      attempts: 1,
    };
    const second: TaskFailure = {
      taskId: "task:wood-and-table:craft:craft:{\"count\":1,\"item\":\"minecraft:oak_planks\"}",
      stage: "wood-and-table",
      code: "E_PRECONDITION",
      detail: "table cannot be placed",
      attempts: 2,
    };
    const plan = new SurvivalGoalPlanner().plan({
      goal: goal(),
      progress: progress(),
      world: {
        inWorld: true,
        inventory: [{ section: "main", slot: 9, item: "minecraft:oak_log", count: 1 }],
      },
      health: health({ skills: ["chop_tree", "craft", "place_block"] }),
      proposals: [],
      lastFailure: second.detail,
      consecutiveFailures: 2,
      failures: [first, second],
      lastFailureStrategy: "wood-and-table:craft:craft:{\"count\":1,\"item\":\"minecraft:oak_planks\"}",
    });
    assert.equal(plan.nextTask?.skill.name, "craft");
    assert.equal(plan.blockedReason, null);
    assert.match(plan.nextTask?.reason ?? "", /重新观察后重试/);
  });

  test("a craft stuck approaching its station changes area instead of retrying", () => {
    const strategy =
      "stone-tools:craft:craft:{\"count\":1,\"item\":\"minecraft:wooden_pickaxe\"}";
    const first: TaskFailure = {
      taskId: `task:${strategy}`,
      stage: "stone-tools",
      code: "E_PRECONDITION",
      detail: "crafting table approach made no progress for 3 seconds",
      attempts: 1,
    };
    const second: TaskFailure = { ...first, attempts: 2 };
    const plan = new SurvivalGoalPlanner().plan({
      goal: goal(),
      progress: progress(),
      world: {
        inWorld: true,
        inventory: [
          { section: "main", slot: 9, item: "minecraft:oak_planks", count: 6 },
          { section: "main", slot: 10, item: "minecraft:stick", count: 4 },
        ],
        nearbyBlocks: [{ id: "minecraft:crafting_table" }],
      },
      health: health({ skills: ["goto", "craft", "place_block", "chop_tree"] }),
      proposals: [],
      lastFailure: second.detail,
      consecutiveFailures: 2,
      failures: [first, second],
      lastFailureStrategy: strategy,
    });
    assert.equal(plan.nextTask?.skill.name, "goto");
    assert.match(plan.nextTask?.reason ?? "", /换一片区域|重新观察/u);
  });

  test("a repeated unreachable food target sweeps beyond the hunt window", () => {
    const foodWorld = {
      inWorld: true,
      health: 20,
      food: 20,
      inventory: [
        { section: "hotbar" as const, slot: 0, item: "minecraft:stone_pickaxe", count: 1 },
        { section: "hotbar" as const, slot: 1, item: "minecraft:cobblestone", count: 3 },
      ],
      nearbyBlocks: [{ id: "minecraft:grass_block" }],
      entities: [
        {
          name: "鸡",
          type: "minecraft:chicken",
          distance: 38,
        },
      ],
      position: { x: 0, y: 64, z: 0 },
      timeOfDay: 2_000,
    };
    const firstPlan = new SurvivalGoalPlanner().plan({
      goal: goal(),
      progress: progress(),
      world: foodWorld,
      health: health({ skills: ["attack", "goto", "craft", "place_block"] }),
      proposals: [],
      lastFailure: null,
      consecutiveFailures: 0,
    });
    assert.equal(firstPlan.stage.id, "food");
    assert.equal(firstPlan.nextTask?.skill.name, "attack");
    const strategy = firstPlan.strategyKey;
    assert.ok(strategy);
    const first: TaskFailure = {
      taskId: `task:${strategy}`,
      stage: "food",
      code: "E_PRECONDITION",
      detail: "no reachable route to minecraft:chicken",
      attempts: 1,
    };
    const second: TaskFailure = { ...first, attempts: 2 };
    const detour = new SurvivalGoalPlanner().plan({
      goal: goal(),
      progress: progress(),
      world: foodWorld,
      health: health({ skills: ["attack", "goto", "craft", "place_block"] }),
      proposals: [],
      lastFailure: second.detail,
      consecutiveFailures: 2,
      failures: [first, second],
      lastFailureStrategy: strategy,
    });
    assert.equal(detour.nextTask?.skill.name, "goto");
    const target = detour.nextTask?.skill.args.target as {
      readonly x: number;
      readonly z: number;
    };
    assert.ok(Math.hypot(target.x, target.z) >= 40);
  });

  test("a repeated chopping timeout moves to a fresh observation area", () => {
    const plan = new SurvivalGoalPlanner().plan({
      goal: goal(),
      progress: progress(),
      world: {
        inWorld: true,
        inventory: [],
        nearbyBlocks: [{ id: "minecraft:oak_log", count: 12 }],
        position: { x: -46.5, y: 72, z: 166.5 },
      },
      health: health({ skills: ["chop_tree", "goto", "craft", "place_block"] }),
      proposals: [],
      lastFailure: null,
      consecutiveFailures: 0,
    });
    assert.equal(plan.stage.id, "wood-and-table");
    assert.equal(plan.nextTask?.skill.name, "chop_tree");
    const strategy = plan.strategyKey;
    assert.ok(strategy);
    const first: TaskFailure = {
      taskId: `task:${strategy}`,
      stage: "wood-and-table",
      code: "timeout",
      detail: "deadline passed",
      attempts: 1,
    };
    const second: TaskFailure = { ...first, attempts: 2 };
    const detour = new SurvivalGoalPlanner().plan({
      goal: goal(),
      progress: progress(),
      world: {
        inWorld: true,
        inventory: [],
        nearbyBlocks: [{ id: "minecraft:oak_log", count: 12 }],
        position: { x: -46.5, y: 72, z: 166.5 },
      },
      health: health({ skills: ["chop_tree", "goto", "craft", "place_block"] }),
      proposals: [],
      lastFailure: second.detail,
      consecutiveFailures: 2,
      failures: [first, second],
      lastFailureStrategy: strategy,
    });
    assert.equal(detour.nextTask?.skill.name, "goto");
    assert.match(detour.nextTask?.reason ?? "", /换一片区域|重新观察/u);
  });

  test("a task that failed once is retried after fresh observation", () => {
    const failure: TaskFailure = {
      taskId: "task:wood-and-table:gather:chop_tree:{\"count\":1}",
      stage: "wood-and-table",
      code: "E_PRECONDITION",
      detail: "previous approach timed out",
      attempts: 1,
    };
    const plan = new SurvivalGoalPlanner().plan({
      goal: goal(),
      progress: progress(),
      world: {
        inWorld: true,
        inventory: [],
        nearbyBlocks: [{ id: "minecraft:oak_log" }],
      },
      health: health({ skills: ["chop_tree", "craft", "place_block"] }),
      proposals: [],
      lastFailure: failure.detail,
      consecutiveFailures: 1,
      failures: [failure],
      lastFailureStrategy:
        "wood-and-table:gather:chop_tree:{\"count\":1}",
    });
    assert.equal(plan.nextTask?.skill.name, "chop_tree");
    assert.equal(
      plan.strategyKey,
      "wood-and-table:gather:chop_tree:{\"count\":1}",
    );
    assert.match(plan.nextTask?.reason ?? "", /重试/);
  });

  test("survival recovery changes strategy in the same planning round", () => {
    const first: TaskFailure = {
      taskId: "task:previous-chop",
      stage: "wood-and-table",
      code: "E_PRECONDITION",
      detail: "tree is behind a wall",
      attempts: 1,
    };
    const plan = new SurvivalGoalPlanner().plan({
      goal: goal(),
      progress: progress(),
      world: {
        inWorld: true,
        inventory: [{ section: "main", slot: 9, item: "minecraft:oak_log", count: 1 }],
        nearbyBlocks: [{ id: "minecraft:oak_log" }],
      },
      health: health({ skills: ["chop_tree", "craft", "place_block"] }),
      proposals: [],
      lastFailure: first.detail,
      consecutiveFailures: 1,
      failures: [first],
      lastFailureStrategy: "wood-and-table:gather:chop_tree:{\"count\":1}",
    });
    assert.notEqual(plan.nextTask, null);
    assert.notEqual(
      plan.strategyKey,
      "wood-and-table:gather:chop_tree:{\"count\":1}",
    );
  });

  test("a non-terminal goal is not marked complete when no task is available", () => {
    const done: GoalPlanner = {
      plan: () => ({
        stage: { id: "wood-and-table", title: "木头与工作台" },
        milestone: { id: "have-log", title: "已获得木头" },
        nextTask: null,
        milestones: [],
        verified: true,
        complete: true,
      }),
    };
    const { value } = runtime(done);
    assert.equal(value.beginStep(context()), null);
    assert.notEqual(value.currentGoal?.status, "completed");
    assert.notEqual(value.currentProgress?.status, "completed");
  });

});

function goal() {
  return {
    id: "goal-1",
    title: "击败末影龙",
    description: "完整生存链",
    status: "active" as const,
    version: 1,
    setBy: "operator" as const,
    setAt: 1_000,
  };
}

function progress() {
  return {
    goalId: "goal-1",
    goalVersion: 1,
    status: "unverified" as const,
    stage: { id: "wood-and-table", title: "木头与工作台" },
    milestone: { id: "have-planks", title: "背包有 4 块木板" },
    nextTask: "",
    milestones: [],
    completed: 0,
    unverified: 0,
    lastFailure: null,
    consecutiveFailures: 0,
    retryAt: null,
    updatedAt: 1_000,
  };
}
