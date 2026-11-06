import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BridgeHealth,
  GoalProgress,
  SeasonGoal,
} from "@craftmate/contracts";
import { AutonomousGoalPlanner } from "./autonomous-goal-planner.ts";
import type { GoalPlanningInput } from "./goal-runtime.ts";
import type {
  GoalTaskChoiceRequest,
  GoalTaskChoiceResult,
  ModelProvider,
  PlanRequest,
  PlanResult,
} from "./ports/model.ts";

const goal: SeasonGoal = {
  id: "goal-ai",
  title: "自由生存并建设家园",
  description: "先砍树，再生存与发育",
  status: "active",
  version: 1,
  setBy: "operator",
  setAt: 1_000,
};

const progress: GoalProgress = {
  goalId: goal.id,
  goalVersion: goal.version,
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
};

function health(skills: readonly string[]): BridgeHealth {
  return {
    connected: true,
    client: "test-body",
    owner: "agent",
    world: { inWorld: true },
    permission: "agent",
    generation: 1,
    skills: [...skills],
    queued: 0,
    running: 0,
    tick: 10,
    lastSeenAt: 1_000,
    watchdogMs: 2_000,
    incidents: [],
  };
}

function input(world: GoalPlanningInput["world"]): GoalPlanningInput {
  return {
    goal,
    progress,
    world,
    health: health([
      "chop_tree",
      "craft",
      "place_block",
      "mine_block",
      "attack",
      "eat",
      "goto",
      "sleep",
    ]),
    proposals: [],
    lastFailure: null,
    consecutiveFailures: 0,
  };
}

function provider(
  choose: (request: GoalTaskChoiceRequest) => Promise<GoalTaskChoiceResult>,
): ModelProvider {
  return {
    id: "fake",
    model: "fake-goal",
    plan: async (_request: PlanRequest): Promise<PlanResult> => ({
      speech: "",
      skill: null,
      reason: "",
      provider: "fake",
      model: "fake-goal",
    }),
    chooseGoalTask: choose,
  };
}

test("a visible opening offers chopping candidates and still picks wood", async () => {
  let calls = 0;
  const planner = new AutonomousGoalPlanner({
    provider: provider(async () => {
      calls += 1;
      return {
        candidateId: "current",
        reason: "先把眼前这根原木砍下来",
        speech: "先砍眼前这棵树。",
        provider: "fake",
        model: "fake-goal",
      };
    }),
    synchronousModel: true,
  });
  const plan = await planner.planAsync(input({
    inWorld: true,
    inventory: [],
    nearbyBlocks: [{ id: "minecraft:oak_log" }],
  }));
  assert.equal(calls, 1);
  assert.equal(plan?.nextTask?.skill.name, "chop_tree");
  assert.equal(plan?.nextTask?.speech, "先砍眼前这棵树。");
});

test("the model may choose survival from a validated shelter-stage candidate list", async () => {
  let offered: readonly string[] = [];
  const planner = new AutonomousGoalPlanner({
    provider: provider(async (request) => {
      offered = request.candidates.map((candidate) => candidate.id);
      assert.ok(request.candidates.every((candidate) => candidate.id !== "invent"));
      return {
        candidateId: "survival-food",
        reason: "先吃东西再考虑建床",
        speech: "我先把肚子填饱。",
        provider: "fake",
        model: "fake-goal",
      };
    }),
    synchronousModel: true,
  });
  const plan = await planner.planAsync(input({
    inWorld: true,
    health: 14,
    food: 8,
    timeOfDay: 1_000,
    foodAcquired: true,
    foodConsumed: true,
    inventory: [
      { section: "main", slot: 9, item: "minecraft:oak_log", count: 1 },
      { section: "main", slot: 10, item: "minecraft:oak_planks", count: 4 },
      { section: "main", slot: 11, item: "minecraft:crafting_table", count: 1 },
      { section: "main", slot: 12, item: "minecraft:wooden_pickaxe", count: 1 },
      { section: "main", slot: 13, item: "minecraft:cobblestone", count: 3 },
      { section: "main", slot: 14, item: "minecraft:stone_pickaxe", count: 1 },
      { section: "main", slot: 15, item: "minecraft:bread", count: 1 },
    ],
    nearbyBlocks: [{ id: "minecraft:crafting_table" }],
  }));
  assert.ok(offered.includes("survival-food"));
  assert.equal(plan?.nextTask?.skill.name, "eat");
  assert.match(plan?.nextTask?.reason ?? "", /AI 自主决策/u);
  assert.equal(plan?.nextTask?.speech, "我先把肚子填饱。");
});

test("visible wood removes the opening explore candidate", async () => {
  let offered: readonly string[] = [];
  const planner = new AutonomousGoalPlanner({
    provider: provider(async (request) => {
      offered = request.candidates.map((candidate) => candidate.id);
      return {
        candidateId: "current",
        reason: "前方就能看到树，直接过去砍",
        speech: "树就在前面，我直接过去。",
        provider: "fake",
        model: "fake-goal",
      };
    }),
    synchronousModel: true,
  });
  const plan = await planner.planAsync({
    ...input({
      inWorld: true,
      position: { x: -70, y: 86, z: 68 },
      yaw: -90,
      inventory: [],
      nearbyBlocks: [{
        id: "minecraft:oak_log",
        count: 1,
        x: -42,
        y: 72,
        z: 61,
        distance: 29,
        bearing: -4,
        visible: true,
      }],
    }),
    lastFailure: "上一次探索没有找到树",
    consecutiveFailures: 1,
  });
  assert.equal(offered.includes("explore"), false);
  assert.equal(plan?.nextTask?.skill.name, "chop_tree");
});

test("a required craft is not preempted by an exploration detour", async () => {
  let offered: readonly string[] = [];
  const planner = new AutonomousGoalPlanner({
    provider: provider(async (request) => {
      offered = request.candidates.map((candidate) => candidate.id);
      return {
        candidateId: "current",
        reason: "先把熔炉做出来",
        speech: "先把熔炉做出来。",
        provider: "fake",
        model: "fake-goal",
      };
    }),
    synchronousModel: true,
  });
  const plan = await planner.planAsync({
    ...input({
      inWorld: true,
      position: { x: 2, y: 32, z: 16 },
      health: 20,
      food: 20,
      foodAcquired: true,
      foodConsumed: true,
      inventory: [
        { section: "main", slot: 9, item: "minecraft:stone_pickaxe", count: 1 },
        { section: "main", slot: 10, item: "minecraft:cobblestone", count: 30 },
        { section: "main", slot: 11, item: "minecraft:torch", count: 4 },
      ],
      nearbyBlocks: [{ id: "minecraft:crafting_table" }],
    }),
    goal: { ...goal, title: "获得铁器" },
    progress: {
      ...progress,
      stage: { id: "iron", title: "铁器与熔炉" },
      milestone: { id: "have-furnace", title: "背包或附近有熔炉" },
    },
  });
  assert.deepEqual(offered, []);
  assert.equal(plan?.nextTask?.skill.name, "craft");
  assert.equal(plan?.nextTask?.skill.args["item"], "minecraft:furnace");
});

test("a distant visible tree offers an approach instead of an impossible chop", async () => {
  let offered: readonly string[] = [];
  const planner = new AutonomousGoalPlanner({
    provider: provider(async (request) => {
      offered = request.candidates.map((candidate) => candidate.id);
      return {
        candidateId: "stockpile-wood",
        reason: "树在远处，先走过去再砍",
        speech: "那棵树离得有点远，我先过去。",
        provider: "fake",
        model: "fake-goal",
      };
    }),
    synchronousModel: true,
  });
  const plan = await planner.planAsync(input({
    inWorld: true,
    position: { x: -70, y: 86, z: 68 },
    yaw: -90,
    inventory: [],
    nearbyBlocks: [
      { id: "minecraft:oak_log", count: 4 },
      {
        id: "minecraft:oak_log",
        count: 1,
        x: -70,
        y: 92,
        z: 164,
        distance: 96,
        bearing: 0,
        visible: true,
      },
    ],
  }));
  assert.ok(offered.includes("stockpile-wood"));
  assert.equal(plan?.nextTask?.skill.name, "goto");
  assert.equal(plan?.nextTask?.skill.args["acceptPartial"], true);
  const stagedTarget = plan?.nextTask?.skill.args["target"] as
    | { readonly x: number; readonly y: number; readonly z: number }
    | undefined;
  assert.ok(stagedTarget !== undefined);
  assert.equal(stagedTarget.x, -70);
  assert.ok(stagedTarget.z > 68 && stagedTarget.z < 164);
});

test("an unknown model candidate falls back to the deterministic plan", async () => {
  const incidents: string[] = [];
  const planner = new AutonomousGoalPlanner({
    provider: provider(async () => ({
      candidateId: "invent-a-skill",
      reason: "bad",
      provider: "fake",
      model: "fake-goal",
    })),
    onIncident: (incident) => incidents.push(incident.code),
    synchronousModel: true,
  });
  const plan = await planner.planAsync(input({
    inWorld: true,
    health: 14,
    food: 8,
    timeOfDay: 1_000,
    foodAcquired: true,
    foodConsumed: true,
    inventory: [
      { section: "main", slot: 9, item: "minecraft:oak_log", count: 1 },
      { section: "main", slot: 10, item: "minecraft:oak_planks", count: 4 },
      { section: "main", slot: 11, item: "minecraft:crafting_table", count: 1 },
      { section: "main", slot: 12, item: "minecraft:wooden_pickaxe", count: 1 },
      { section: "main", slot: 13, item: "minecraft:cobblestone", count: 3 },
      { section: "main", slot: 14, item: "minecraft:stone_pickaxe", count: 1 },
      { section: "main", slot: 15, item: "minecraft:bread", count: 1 },
    ],
    nearbyBlocks: [{ id: "minecraft:crafting_table" }],
  }));
  assert.notEqual(plan?.nextTask, null);
  assert.deepEqual(incidents, ["GOAL_MODEL_INVALID"]);
});

test("a slow model never blocks the next skill and is applied to the next plan", async () => {
  let release: ((result: GoalTaskChoiceResult) => void) | null = null;
  let calls = 0;
  const planner = new AutonomousGoalPlanner({
    provider: provider(async () => {
      calls += 1;
      return new Promise<GoalTaskChoiceResult>((resolve) => {
        release = resolve;
      });
    }),
    refreshIntervalMs: 0,
  });
  const world: GoalPlanningInput["world"] = {
    inWorld: true,
    health: 14,
    food: 8,
    timeOfDay: 1_000,
    foodAcquired: true,
    foodConsumed: true,
    inventory: [
      { section: "main", slot: 9, item: "minecraft:oak_log", count: 1 },
      { section: "main", slot: 10, item: "minecraft:oak_planks", count: 4 },
      { section: "main", slot: 11, item: "minecraft:crafting_table", count: 1 },
      { section: "main", slot: 12, item: "minecraft:wooden_pickaxe", count: 1 },
      { section: "main", slot: 13, item: "minecraft:cobblestone", count: 3 },
      { section: "main", slot: 14, item: "minecraft:stone_pickaxe", count: 1 },
      { section: "main", slot: 15, item: "minecraft:bread", count: 1 },
    ],
    nearbyBlocks: [{ id: "minecraft:crafting_table" }],
  };

  const first = await planner.planAsync(input(world));
  assert.ok(first?.nextTask);
  assert.equal(calls, 1);

  assert.notEqual(release, null);
  release!({
    candidateId: "survival-food",
    reason: "先补食物",
    speech: "我先把肚子填饱。",
    provider: "fake",
    model: "fake-goal",
  });
  await new Promise((resolve) => setImmediate(resolve));

  const second = await planner.planAsync(input(world));
  assert.equal(second?.nextTask?.skill.name, "eat");
  assert.equal(second?.nextTask?.speech, "我先把肚子填饱。");
});
