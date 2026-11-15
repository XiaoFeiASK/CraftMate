import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BridgeHealth,
  GoalProgress,
  SeasonGoal,
} from "@craftmate/contracts";
import { AutonomousGoalPlanner } from "./autonomous-goal-planner.ts";
import type { GoalPlan, GoalPlanner, GoalPlanningInput } from "./goal-runtime.ts";
import type {
  GoalTaskChoiceRequest,
  GoalTaskChoiceResult,
  ModelProvider,
  PlanRequest,
  PlanResult,
  PlaybookChoiceRequest,
  PlaybookChoiceResult,
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

function ironOpportunityInput(): GoalPlanningInput {
  return {
    ...input({
      inWorld: true,
      position: { x: 18, y: 42, z: 250 },
      health: 20,
      food: 20,
      timeOfDay: 1_000,
      inventory: [
        { section: "main", slot: 9, item: "minecraft:stone_pickaxe", count: 1 },
        { section: "main", slot: 10, item: "minecraft:cobblestone", count: 8 },
        { section: "main", slot: 11, item: "minecraft:torch", count: 4 },
      ],
      nearbyBlocks: [
        { id: "minecraft:crafting_table" },
        {
          id: "minecraft:iron_ore",
          count: 1,
          x: 18,
          y: 42,
          z: 253,
          distance: 3.76,
          bearing: 75.24,
          visible: true,
        },
      ],
    }),
    goal: { ...goal, title: "获得铁器" },
    progress: {
      ...progress,
      stage: { id: "iron", title: "铁器与熔炉" },
      milestone: { id: "have-iron-pickaxe", title: "背包有铁镐" },
    },
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

function playbookProvider(
  choose: (request: PlaybookChoiceRequest) => Promise<PlaybookChoiceResult>,
): ModelProvider {
  return {
    id: "fake",
    model: "fake-playbook",
    plan: async (): Promise<PlanResult> => ({
      speech: "",
      skill: null,
      reason: "",
      provider: "fake",
      model: "fake-playbook",
    }),
    choosePlaybookCard: choose,
  };
}

const settledWorld: NonNullable<GoalPlanningInput["world"]> = {
  inWorld: true,
  position: { x: 8, y: 70, z: 8 },
  health: 20,
  food: 20,
  timeOfDay: 1_000,
  shelterBuilt: true,
  chestPlaced: true,
  bedPlaced: true,
  furnacePlaced: true,
  chest: { x: 8, y: 70, z: 8 },
  bed: { x: 9, y: 70, z: 8 },
  furnace: { x: 7, y: 70, z: 8 },
  inventory: [
    { section: "main", slot: 9, item: "minecraft:stone_pickaxe", count: 1 },
    { section: "main", slot: 10, item: "minecraft:oak_log", count: 8 },
    { section: "main", slot: 11, item: "minecraft:cobblestone", count: 16 },
    { section: "main", slot: 12, item: "minecraft:bread", count: 3 },
  ],
  nearbyBlocks: [{ id: "minecraft:crafting_table" }],
};

function playbookInput(
  world: GoalPlanningInput["world"] = settledWorld,
): GoalPlanningInput {
  return {
    ...input(world),
    progress: {
      ...progress,
      stage: { id: "food", title: "食物" },
      milestone: { id: "food-stock", title: "有食物储备" },
    },
  };
}

test("the optional model can rank a deterministic opening candidate", async () => {
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

test("an invalid model candidate falls back with one incident", async () => {
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
  const plan = await planner.planAsync(ironOpportunityInput());
  assert.notEqual(plan?.nextTask, null);
  assert.deepEqual(incidents, ["GOAL_MODEL_INVALID"]);
});

test("a slow model never blocks the next skill", async () => {
  let release: ((result: GoalTaskChoiceResult) => void) | null = null;
  const planner = new AutonomousGoalPlanner({
    provider: provider(async () => {
      return new Promise<GoalTaskChoiceResult>((resolve) => {
        release = resolve;
      });
    }),
    refreshIntervalMs: 0,
  });
  const world = ironOpportunityInput();

  const first = await planner.planAsync(world);
  assert.ok(first?.nextTask);
  assert.notEqual(release, null);
  release!({
    candidateId: "visible-ore",
    reason: "眼前就有铁矿",
    speech: "这块铁就在眼前，我先挖了。",
    provider: "fake",
    model: "fake-goal",
  });
  await new Promise((resolve) => setImmediate(resolve));

  const second = await planner.planAsync(world);
  assert.equal(second?.nextTask?.skill.name, "mine_block");
  assert.equal(second?.nextTask?.speech, "这块铁就在眼前，我先挖了。");
});

test("a critical safety card bypasses the playbook model", async () => {
  let calls = 0;
  const planner = new AutonomousGoalPlanner({
    provider: playbookProvider(async () => {
      calls += 1;
      return {
        cardId: "explore.surface",
        reason: "先去远处看看",
        provider: "fake",
        model: "fake-playbook",
      };
    }),
    synchronousModel: true,
  });
  const plan = await planner.planAsync(
    playbookInput({
      ...settledWorld,
      position: { x: 0, y: 70, z: 0 },
      health: 4,
    }),
  );
  assert.equal(calls, 0);
  assert.equal(plan?.cardId, "safety.retreat");
  assert.equal(plan?.cardModelChoice, false);
  assert.equal(plan?.nextTask?.skill.name, "goto");
});

test("blocked, unknown and empty card choices all fall back safely", async () => {
  const cases = [
    { cardId: "food.hunt", incident: true },
    { cardId: "does.not.exist", incident: true },
    { cardId: "", incident: false },
  ];
  for (const item of cases) {
    const incidents: string[] = [];
    const planner = new AutonomousGoalPlanner({
      provider: playbookProvider(async () => ({
        cardId: item.cardId,
        reason: "candidate",
        provider: "fake",
        model: "fake-playbook",
      })),
      synchronousModel: true,
      onIncident: (incident) => incidents.push(incident.code),
    });
    const plan = await planner.planAsync(playbookInput());
    assert.equal(plan?.cardModelChoice, false, item.cardId);
    assert.notEqual(plan?.cardId, "food.hunt", item.cardId);
    assert.equal(
      incidents.includes("GOAL_PLAYBOOK_INVALID"),
      item.incident,
      item.cardId,
    );
  }
});

test("card dwell avoids a redundant model call", async () => {
  let calls = 0;
  const planner = new AutonomousGoalPlanner({
    provider: playbookProvider(async () => {
      calls += 1;
      return {
        cardId: "explore.surface",
        reason: "地图还有没看过的区域",
        provider: "fake",
        model: "fake-playbook",
      };
    }),
    synchronousModel: true,
  });
  const first = await planner.planAsync(playbookInput());
  const second = await planner.planAsync(playbookInput());
  assert.equal(first?.cardId, second?.cardId);
  assert.equal(calls, 1);
});

test("an all-blocked playbook does not replay a blacklisted baseline route", async () => {
  const baseline: GoalPlan = {
    stage: { id: "food", title: "食物" },
    milestone: { id: "food-stock", title: "有食物储备" },
    nextTask: {
      intent: "move",
      text: "换一片区域重新观察",
      reason: "旧回退路线",
      skill: {
        name: "goto",
        args: {
          target: { x: 20, y: 64, z: 0 },
          candidates: [{ x: 20, y: 64, z: 0 }],
          acceptPartial: true,
          mode: "walk",
        },
        idempotencyKey: "baseline-route",
      },
    },
    milestones: [],
    verified: false,
  };
  const deterministic: GoalPlanner = { plan: () => baseline };
  const planner = new AutonomousGoalPlanner({
    provider: null,
    deterministic,
    readRouteBlacklist: () => [
      {
        id: "blacklist-route",
        sessionId: "session",
        dimension: "minecraft:overworld",
        kind: "point",
        x: 20,
        y: 64,
        z: 0,
        radius: 0.75,
        targetRef: "mainline.current",
        reasonCode: "E_UNREACHABLE",
        reasonDetail: "no route",
        source: "agent",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  });
  const plan = await planner.planAsync(
    input({
      inWorld: true,
      position: { x: 0, y: 64, z: 0 },
      health: 12,
      food: 10,
      timeOfDay: 1_000,
      inventory: [],
      nearbyBlocks: [],
      entities: [],
    }),
  );
  assert.equal(plan?.nextTask, null);
  assert.match(plan?.blockedReason ?? "", /没有可执行的玩法卡/u);
});
