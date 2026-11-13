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
  PlaybookChoiceRequest,
  PlaybookChoiceResult,
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

test("starvation is a state gate instead of a model choice", async () => {
  let calls = 0;
  const planner = new AutonomousGoalPlanner({
    provider: provider(async () => {
      calls += 1;
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
  assert.equal(calls, 0);
  assert.equal(plan?.nextTask?.critical, true);
  assert.equal(plan?.nextTask?.skill.name, "eat");
  assert.match(plan?.nextTask?.reason ?? "", /饿了先吃|目标阶段/u);
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

test("visible iron ore is offered as state-driven work before a furnace trip", async () => {
  let offered: readonly string[] = [];
  const planner = new AutonomousGoalPlanner({
    provider: provider(async (request) => {
      offered = request.candidates.map((candidate) => candidate.id);
      return {
        candidateId: "visible-ore",
        reason: "铁矿石就在脚边，先挖两块再回熔炉",
        speech: "旁边就有铁矿，我先挖了再说。",
        provider: "fake",
        model: "fake-goal",
      };
    }),
    synchronousModel: true,
  });
  const plan = await planner.planAsync(input({
    inWorld: true,
    position: { x: 21.5, y: 43, z: 252.7 },
    canSeeSky: false,
    surfaceY: 80,
    health: 20,
    food: 20,
    foodAcquired: true,
    foodConsumed: true,
    chestPlaced: true,
    chest: { x: 10, y: 60, z: 10 },
    bedPlaced: true,
    bed: { x: 11, y: 60, z: 10 },
    furnacePlaced: true,
    furnace: { x: 38, y: 82, z: 253 },
    inventory: [
      { section: "hotbar", slot: 0, item: "minecraft:stone_pickaxe", count: 1, durability: 48 },
      { section: "hotbar", slot: 1, item: "minecraft:cobblestone", count: 49 },
      { section: "hotbar", slot: 2, item: "minecraft:oak_log", count: 8 },
      { section: "hotbar", slot: 3, item: "minecraft:stick", count: 6 },
      { section: "hotbar", slot: 4, item: "minecraft:torch", count: 4 },
      { section: "main", slot: 9, item: "minecraft:raw_iron", count: 1 },
    ],
    nearbyBlocks: [
      { id: "minecraft:crafting_table" },
      { id: "minecraft:iron_ore", count: 10 },
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
  }));
  assert.ok(offered.includes("visible-ore"));
  assert.equal(offered.includes("explore"), false);
  assert.equal(plan?.nextTask?.skill.name, "mine_block");
  assert.equal(plan?.nextTask?.skill.args["block"], "minecraft:iron_ore");
  assert.equal(plan?.nextTask?.skill.args["count"], 1);
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
      chestPlaced: true,
      bedPlaced: true,
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

test("a missing pickaxe is a state gate the model cannot outvote", async () => {
  let calls = 0;
  const planner = new AutonomousGoalPlanner({
    provider: provider(async () => {
      calls += 1;
      return {
        candidateId: "explore",
        reason: "先去别处逛逛",
        speech: "先四处看看。",
        provider: "fake",
        model: "fake-goal",
      };
    }),
    synchronousModel: true,
  });
  const plan = await planner.planAsync({
    ...input({
      inWorld: true,
      position: { x: 4, y: 80, z: 4 },
      health: 20,
      food: 20,
      timeOfDay: 1_000,
      inventory: [
        { section: "main", slot: 9, item: "minecraft:oak_planks", count: 4 },
        { section: "main", slot: 10, item: "minecraft:stick", count: 2 },
      ],
      nearbyBlocks: [{ id: "minecraft:crafting_table" }],
      craftingTableNearby: true,
      craftingTableReachable: true,
    }),
    goal: { ...goal, title: "获得石头工具" },
    progress: {
      ...progress,
      stage: { id: "stone-tools", title: "木镐与石镐" },
      milestone: { id: "have-wooden-pickaxe", title: "拥有能挖石头的镐" },
    },
  });
  assert.equal(calls, 0);
  assert.equal(plan?.nextTask?.critical, true);
  assert.equal(plan?.nextTask?.skill.name, "craft");
  assert.equal(plan?.nextTask?.skill.args["item"], "minecraft:wooden_pickaxe");
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

test("a completed shelter is not offered again during the iron stage", async () => {
  let offered: readonly string[] = [];
  const planner = new AutonomousGoalPlanner({
    provider: provider(async (request) => {
      offered = request.candidates.map((candidate) => candidate.id);
      return {
        candidateId: "current",
        reason: "熔炉就在旁边，先把火把做出来",
        speech: "先做几根火把。",
        provider: "fake",
        model: "fake-goal",
      };
    }),
    synchronousModel: true,
  });
  const plan = await planner.planAsync({
    ...input({
      inWorld: true,
      position: { x: 40.5, y: 70, z: 40.5 },
      canSeeSky: true,
      surfaceY: 70,
      food: 20,
      foodAcquired: true,
      foodConsumed: true,
      chestPlaced: true,
      chest: { x: 10, y: 70, z: 8 },
      bedPlaced: true,
      bed: { x: 11, y: 70, z: 8 },
      inventory: [
        { section: "main", slot: 9, item: "minecraft:stone_pickaxe", count: 1 },
        { section: "main", slot: 10, item: "minecraft:cobblestone", count: 3 },
        { section: "main", slot: 11, item: "minecraft:coal", count: 1 },
        { section: "main", slot: 12, item: "minecraft:stick", count: 4 },
      ],
      nearbyBlocks: [
        { id: "minecraft:crafting_table" },
        { id: "minecraft:furnace" },
      ],
    }),
    progress: {
      ...progress,
      stage: { id: "iron", title: "铁器与熔炉" },
      milestone: { id: "have-torches", title: "背包有 4 个火把" },
    },
  });
  assert.equal(offered.includes("home-shelter"), false);
  assert.equal(plan?.nextTask?.skill.name, "craft");
  assert.equal(plan?.nextTask?.skill.args["item"], "minecraft:torch");
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
  const plan = await planner.planAsync(ironOpportunityInput());
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
  const world = ironOpportunityInput();

  const first = await planner.planAsync(world);
  assert.ok(first?.nextTask);
  assert.equal(calls, 1);

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

test("cached model copy is discarded when the deterministic strategy changes", async () => {
  let release: ((result: GoalTaskChoiceResult) => void) | null = null;
  const planner = new AutonomousGoalPlanner({
    provider: provider(async () => {
      return new Promise<GoalTaskChoiceResult>((resolve) => {
        release = resolve;
      });
    }),
    refreshIntervalMs: 60_000,
  });

  const chopping = await planner.planAsync(input({
    inWorld: true,
    inventory: [],
    nearbyBlocks: [{ id: "minecraft:oak_log" }],
  }));
  assert.equal(chopping?.nextTask?.skill.name, "chop_tree");
  assert.notEqual(release, null);

  release!({
    candidateId: "current",
    reason: "先把眼前这根原木砍下来",
    speech: "先砍眼前这棵树。",
    provider: "fake",
    model: "fake-goal",
  });
  await new Promise((resolve) => setImmediate(resolve));

  const searching = await planner.planAsync(input({
    inWorld: true,
    inventory: [],
    nearbyBlocks: [],
  }));
  assert.ok(searching?.nextTask);
  assert.notEqual(searching?.nextTask?.skill.name, "chop_tree");
  assert.notEqual(searching?.nextTask?.reason, "先把眼前这根原木砍下来");
  assert.equal(searching?.nextTask?.speech, undefined);
});

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

const awayFromCamp: NonNullable<GoalPlanningInput["world"]> = {
  ...settledWorld,
  position: { x: 0, y: 70, z: 0 },
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
  const plan = await planner.planAsync(playbookInput({ ...awayFromCamp, health: 4 }));
  assert.equal(calls, 0);
  assert.equal(plan?.cardId, "safety.retreat");
  assert.equal(plan?.cardModelChoice, false);
  assert.equal(plan?.nextTask?.skill.name, "goto");
});

test("a playbook task clears a stale blocked reason from the milestone", async () => {
  const blockedBaseline = {
    stage: { id: "wood-and-table", title: "木头与工作台" },
    milestone: { id: "have-wooden-pickaxe", title: "拥有木镐" },
    nextTask: null,
    milestones: [],
    verified: false,
    blockedReason: "目标引擎没有返回可执行任务",
  } satisfies GoalPlan;
  const deterministic: GoalPlanner = { plan: () => blockedBaseline };
  const planner = new AutonomousGoalPlanner({
    provider: null,
    deterministic,
    synchronousModel: true,
  });
  const plan = await planner.planAsync(
    playbookInput({
      ...settledWorld,
      food: 6,
      inventory: [
        { section: "main", slot: 9, item: "minecraft:apple", count: 2 },
      ],
    }),
  );
  assert.equal(plan?.cardId, "safety.eat");
  assert.equal(plan?.nextTask?.skill.name, "eat");
  assert.equal(plan?.blockedReason, null);
});

test("a model-selected blocked card is rejected and falls back deterministically", async () => {
  const incidents: string[] = [];
  const planner = new AutonomousGoalPlanner({
    provider: playbookProvider(async () => ({
      cardId: "food.hunt",
      reason: "去打猎",
      provider: "fake",
      model: "fake-playbook",
    })),
    synchronousModel: true,
    onIncident: (incident) => incidents.push(incident.code),
  });
  const plan = await planner.planAsync(playbookInput());
  assert.equal(plan?.cardId, "explore.surface");
  assert.equal(plan?.cardModelChoice, false);
  assert.notEqual(plan?.cardFallbackReason, null);
  assert.deepEqual(incidents, ["GOAL_PLAYBOOK_INVALID"]);
});

test("an unknown playbook card id is rejected without changing the run", async () => {
  const planner = new AutonomousGoalPlanner({
    provider: playbookProvider(async () => ({
      cardId: "does.not.exist",
      reason: "未知卡",
      provider: "fake",
      model: "fake-playbook",
    })),
    synchronousModel: true,
  });
  const plan = await planner.planAsync(playbookInput());
  assert.equal(plan?.cardId, "explore.surface");
  assert.equal(plan?.nextTask?.skill.name, "goto");
});

test("a timed-out playbook choice falls back instead of stalling", async () => {
  const planner = new AutonomousGoalPlanner({
    provider: playbookProvider(
      () => new Promise<PlaybookChoiceResult>(() => {}),
    ),
    synchronousModel: true,
    deadlineMs: 20,
  });
  const plan = await planner.planAsync(playbookInput());
  assert.equal(plan?.cardId, "explore.surface");
  assert.equal(plan?.cardModelChoice, false);
});

test("a card stays for its minimum dwell and skips a redundant model call", async () => {
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
  assert.equal(first?.cardId, "explore.surface");
  assert.equal(second?.cardId, "explore.surface");
  assert.match(second?.cardReason ?? "", /继续当前玩法卡/u);
  assert.equal(calls, 1);
});

test("a failure at a task boundary immediately reconsiders the active card", async () => {
  let calls = 0;
  const explorer: NonNullable<GoalPlanningInput["world"]> = {
    ...settledWorld,
    position: { x: 0, y: 64, z: 0 },
    inventory: [
      { section: "main", slot: 9, item: "minecraft:stone_pickaxe", count: 1 },
      { section: "main", slot: 10, item: "minecraft:oak_log", count: 4 },
      { section: "main", slot: 11, item: "minecraft:bread", count: 3 },
    ],
    nearbyBlocks: [
      {
        id: "minecraft:oak_log",
        count: 1,
        x: 4,
        y: 64,
        z: 4,
        distance: 5,
        bearing: 0,
        visible: true,
      },
    ],
  };
  const planner = new AutonomousGoalPlanner({
    provider: playbookProvider(async (request) => {
      calls += 1;
      const cardId = calls === 1 ? "explore.surface" : "stockpile.wood";
      assert.ok(request.cards.some((card) => card.id === cardId));
      return {
        cardId,
        reason: calls === 1 ? "先去探索" : "改去补木材",
        provider: "fake",
        model: "fake-playbook",
      };
    }),
    synchronousModel: true,
  });
  const first = await planner.planAsync(playbookInput(explorer));
  const second = await planner.planAsync({
    ...playbookInput(explorer),
    lastFailure: "前方没有可走的路",
    consecutiveFailures: 1,
  });
  assert.equal(first?.cardId, "explore.surface");
  assert.equal(second?.cardId, "stockpile.wood");
  assert.equal(calls, 2);
});

test("a critical card that failed twice yields to its recovery card", async () => {
  const planner = new AutonomousGoalPlanner({
    provider: null,
    synchronousModel: true,
  });
  const hurtHungry = { ...awayFromCamp, health: 4, food: 6 };
  const first = await planner.planAsync(playbookInput(hurtHungry));
  assert.equal(first?.cardId, "safety.retreat");

  const second = await planner.planAsync({
    ...playbookInput(hurtHungry),
    lastFailure: "approach made no progress",
    consecutiveFailures: 1,
  });
  assert.equal(second?.cardId, "safety.retreat");

  const third = await planner.planAsync({
    ...playbookInput(hurtHungry),
    lastFailure: "approach made no progress",
    consecutiveFailures: 2,
  });
  assert.notEqual(third?.cardId, second?.cardId);
  assert.equal(third?.cardId, "safety.eat");
  assert.ok(third?.nextTask);
  assert.match(third?.cardReason ?? "", /连续失败/u);
});

test("a critical state interrupts an active card before its dwell expires", async () => {
  let calls = 0;
  const planner = new AutonomousGoalPlanner({
    provider: playbookProvider(async () => {
      calls += 1;
      return {
        cardId: "explore.surface",
        reason: "先去地图边缘看看",
        provider: "fake",
        model: "fake-playbook",
      };
    }),
    synchronousModel: true,
  });
  const exploring = await planner.planAsync(playbookInput());
  assert.equal(exploring?.cardId, "explore.surface");

  const retreating = await planner.planAsync(
    playbookInput({ ...awayFromCamp, health: 4 }),
  );
  assert.equal(retreating?.cardId, "safety.retreat");
  assert.equal(retreating?.cardModelChoice, false);
  assert.equal(retreating?.nextTask?.critical, true);
  assert.equal(calls, 1);
});

test("a newly critical state also overrides a cached noncritical choice", async () => {
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
    refreshIntervalMs: 60_000,
  });
  await planner.planAsync(playbookInput());
  await new Promise((resolve) => setImmediate(resolve));

  const retreating = await planner.planAsync(
    playbookInput({ ...awayFromCamp, health: 4 }),
  );
  assert.equal(retreating?.cardId, "safety.retreat");
  assert.equal(retreating?.cardModelChoice, false);
  assert.equal(calls, 1);
});
