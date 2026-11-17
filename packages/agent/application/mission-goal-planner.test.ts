import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSkillArgs,
  type GoalProgress,
  type RouteBlacklist,
  type SeasonGoal,
  type WorldSnapshot,
} from "@craftmate/contracts";
import { MissionGoalPlanner } from "./mission-goal-planner.ts";
import type {
  GoalPlanningInput,
  GoalPlanner,
} from "./goal-runtime.ts";

function goal(): SeasonGoal {
  return {
    id: "goal-1",
    title: "铁全套与钻石装备",
    description: "完成铁套并取得三颗钻石",
    status: "active",
    version: 1,
    setBy: "operator",
    setAt: 1,
  };
}

function progress(): GoalProgress {
  return {
    goalId: "goal-1",
    goalVersion: 1,
    status: "active",
    stage: { id: "iron", title: "铁器" },
    milestone: { id: "have-iron-ingot", title: "获得铁锭" },
    nextTask: "",
    milestones: [],
    completed: 0,
    unverified: 0,
    lastFailure: null,
    consecutiveFailures: 0,
    retryAt: null,
    updatedAt: 1,
  };
}

function input(world: Record<string, unknown>): GoalPlanningInput {
  return {
    goal: goal(),
    progress: progress(),
    world: world as WorldSnapshot,
    health: {
      connected: true,
      client: "test",
      owner: "agent",
      skills: [
        "goto",
        "mine_block",
        "mine_tunnel",
        "craft",
        "smelt",
        "place_block",
        "run_plan",
      ],
      world: world as WorldSnapshot,
      queued: 0,
      running: 0,
      tick: 0,
      lastSeenAt: 1,
      watchdogMs: 2_000,
      permission: "agent",
      generation: 1,
      incidents: [],
    },
    proposals: [],
    lastFailure: null,
    consecutiveFailures: 0,
  } as GoalPlanningInput;
}

test("mission planner compiles one continuous smelt+craft job", () => {
  const plan = new MissionGoalPlanner().plan(input({
    inWorld: true,
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    inventory: [
      { item: "minecraft:stone_pickaxe", count: 1, durability: 100 },
      { item: "minecraft:cobblestone", count: 8 },
      { item: "minecraft:raw_iron", count: 3 },
      { item: "minecraft:coal", count: 2 },
      { item: "minecraft:stick", count: 2 },
      { item: "minecraft:torch", count: 4 },
    ],
    chestPlaced: true,
    bedPlaced: true,
    furnacePlaced: true,
    nearbyBlocks: [
      { id: "minecraft:furnace", x: 1, y: 64, z: 0, distance: 1 },
      { id: "minecraft:crafting_table", x: -1, y: 64, z: 0, distance: 1 },
    ],
  }));
  assert.equal(plan?.nextTask?.skill.name, "run_plan");
  // The bridge default is 30 seconds; a real furnace batch plus crafting
  // needs the plan's own 180-second budget.
  assert.ok((plan?.nextTask?.skill.deadlineTicks ?? 0) >= 180 * 20);
  const steps = plan?.nextTask?.skill.args["steps"];
  assert.ok(Array.isArray(steps));
  assert.equal(steps[0]?.skill, "smelt");
  assert.equal(steps[1]?.skill, "craft");
  assert.equal(steps[1]?.args.item, "minecraft:iron_pickaxe");
  assert.ok(plan?.nextTask?.acquisition);
});

test("a carried table is placed before the job's craft node", () => {
  const plan = new MissionGoalPlanner().plan(input({
    inWorld: true,
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    inventory: [
      { item: "minecraft:stone_pickaxe", count: 1, durability: 100 },
      { item: "minecraft:cobblestone", count: 8 },
      { item: "minecraft:raw_iron", count: 3 },
      { item: "minecraft:coal", count: 3 },
      { item: "minecraft:stick", count: 2 },
      { item: "minecraft:crafting_table", count: 3 },
      { item: "minecraft:torch", count: 4 },
    ],
    chestPlaced: true,
    bedPlaced: true,
    furnacePlaced: true,
    craftingTable: { x: 50, y: 64, z: 50 },
    nearbyBlocks: [
      { id: "minecraft:furnace", x: 1, y: 64, z: 0, distance: 1 },
    ],
  }));
  assert.equal(plan?.nextTask?.skill.name, "run_plan");
  const steps = plan?.nextTask?.skill.args["steps"];
  assert.ok(Array.isArray(steps));
  assert.equal(steps[0]?.skill, "place_block");
  assert.equal(steps[0]?.args.block, "minecraft:crafting_table");
  assert.equal(steps[1]?.skill, "smelt");
  assert.equal(steps[2]?.skill, "craft");
  // The later craft step names the table it placed itself. The plan must
  // declare that family, otherwise the body rejects the whole run_plan.
  assert.ok(parseSkillArgs("run_plan", plan?.nextTask?.skill.args));
});

test("an unreachable remembered furnace is approached before compiling a smelt", () => {
  const plan = new MissionGoalPlanner().plan(input({
    inWorld: true,
    world: "minecraft:overworld",
    position: { x: 0.5, y: 64, z: 0.5 },
    surfaceY: 64,
    canSeeSky: true,
    health: 20,
    food: 20,
    inventory: [
      { item: "minecraft:stone_pickaxe", count: 1, durability: 100 },
      { item: "minecraft:raw_iron", count: 3 },
      { item: "minecraft:coal", count: 3 },
      { item: "minecraft:cobblestone", count: 8 },
      { item: "minecraft:stick", count: 2 },
      { item: "minecraft:torch", count: 4 },
    ],
    chestPlaced: true,
    bedPlaced: true,
    furnacePlaced: true,
    furnaceReachable: false,
    furnace: { x: 20, y: 64, z: 0 },
    // The aggregate observation proves a furnace exists somewhere nearby,
    // but not that its interaction face is in reach.
    nearbyBlocks: [{ id: "minecraft:furnace", count: 1 }],
  }));
  assert.ok(plan?.nextTask !== null && plan?.nextTask !== undefined);
  assert.equal(plan.nextTask.skill.name, "goto");
  assert.match(plan.nextTask.text, /熔炉/u);
  assert.doesNotMatch(plan.nextTask.text, /连续熔炼/u);
});

test("three diamonds end the acceptance mission", () => {
  const plan = new MissionGoalPlanner().plan(input({
    inWorld: true,
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    inventory: [
      { item: "minecraft:iron_pickaxe", count: 1 },
      { item: "minecraft:iron_sword", count: 1 },
      { item: "minecraft:iron_helmet", count: 1 },
      { item: "minecraft:iron_chestplate", count: 1 },
      { item: "minecraft:iron_leggings", count: 1 },
      { item: "minecraft:iron_boots", count: 1 },
      { item: "minecraft:diamond", count: 3 },
    ],
  }));
  assert.equal(plan?.complete, true);
  assert.equal(plan?.nextTask, null);
});

test("mission planner injects durable route refusals before planning", () => {
  const refusal: RouteBlacklist = {
    id: "route-1",
    sessionId: "session-1",
    dimension: "minecraft:overworld",
    kind: "region",
    x: 12,
    y: 40,
    z: -8,
    radius: 12,
    targetRef: null,
    reasonCode: "E_ENCLOSED",
    reasonDetail: "old mine tunnel",
    source: "agent",
    expiresAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
  let received: readonly RouteBlacklist[] | undefined;
  const baseline: GoalPlanner = {
    plan: (planning) => {
      received = planning.routeBlacklist;
      return {
        stage: { id: "iron", title: "铁器" },
        milestone: { id: "have-iron-ingot", title: "获得铁锭" },
        nextTask: null,
        milestones: [],
        verified: false,
      };
    },
  };
  const planner = new MissionGoalPlanner({
    baseline,
    readRouteBlacklist: () => [refusal],
  });
  const plan = planner.plan(input({
    inWorld: true,
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    inventory: [
      { item: "minecraft:stone_pickaxe", count: 1, durability: 100 },
      { item: "minecraft:iron_sword", count: 1 },
    ],
  }));
  assert.ok(plan !== null);
  assert.deepEqual(received, [refusal]);
});

test("compiled mission stages still honour repeated failure recovery", () => {
  const world = {
    inWorld: true,
    world: "minecraft:overworld",
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    inventory: [
      { item: "minecraft:stone_pickaxe", count: 1, durability: 100 },
      { item: "minecraft:torch", count: 8 },
    ],
    nearbyBlocks: [],
  };
  const baseline: GoalPlanner = {
    plan: () => ({
      stage: { id: "wood-and-table", title: "木头与工作台" },
      milestone: { id: "stale", title: "旧进度" },
      nextTask: null,
      milestones: [],
      verified: false,
    }),
  };
  const planner = new MissionGoalPlanner({ baseline });
  const first = planner.plan(input(world));
  assert.ok(first?.nextTask !== null && first?.nextTask !== undefined);
  const failedTask = first.nextTask;
  assert.notEqual(failedTask.taskId, undefined);
  const failedStrategy = first.strategyKey;
  assert.notEqual(failedStrategy, undefined);

  const repeated = planner.plan({
    ...input(world),
    failures: [
      {
        taskId: failedTask.taskId!,
        stage: "iron",
        code: "E_ENCLOSED",
        detail: "no reachable route",
        attempts: 1,
      },
      {
        taskId: failedTask.taskId!,
        stage: "iron",
        code: "E_ENCLOSED",
        detail: "no reachable route",
        attempts: 2,
      },
    ],
    lastFailureStrategy: failedStrategy!,
  });
  assert.ok(repeated?.nextTask !== null && repeated?.nextTask !== undefined);
  assert.notEqual(repeated.nextTask.taskId, failedTask.taskId);
  assert.equal(repeated.nextTask.skill.name, "goto");
});

test("an iron mission does not regress to an earlier unverified food stage", () => {
  const plan = new MissionGoalPlanner().plan(input({
    inWorld: true,
    world: "minecraft:overworld",
    position: { x: 0, y: 48, z: 0 },
    health: 20,
    food: 15,
    timeOfDay: 16_000,
    surfaceY: 70,
    canSeeSky: false,
    inventory: [
      { item: "minecraft:stone_pickaxe", count: 1, durability: 100 },
      { item: "minecraft:iron_pickaxe", count: 1, durability: 250 },
      { item: "minecraft:coal", count: 9 },
      { item: "minecraft:stick", count: 8 },
      { item: "minecraft:torch", count: 4 },
    ],
    chestPlaced: true,
    bedPlaced: true,
    furnacePlaced: true,
    nearbyBlocks: [
      { id: "minecraft:crafting_table", x: 1, y: 48, z: 0, distance: 1 },
    ],
    mine: {
      entrance: { x: 0, y: 48, z: 0 },
      direction: "east",
      stair: {
        stand: { x: 0, y: 48, z: 0 },
        depth: 0,
        pending: { id: "minecraft:stone", x: 1, y: 48, z: 0 },
      },
      branch: {
        stand: { x: 0, y: 48, z: 0 },
        distance: 0,
        pending: { id: "minecraft:stone", x: 1, y: 48, z: 0 },
      },
    },
  }));
  assert.equal(plan?.stage.id, "iron");
  assert.ok(plan?.nextTask !== null && plan?.nextTask !== undefined);
  assert.notEqual(plan.nextTask.skill.name, "eat");
});

test("a survive mission keeps the baseline task when its food stage is already complete", () => {
  const baseline: GoalPlanner = {
    plan: () => ({
      stage: { id: "iron", title: "铁器" },
      milestone: { id: "have-iron-ingot", title: "获得铁锭" },
      nextTask: {
        intent: "move",
        text: "低血量撤离 僵尸",
        reason: "生命值过低，先离开危险区域",
        critical: true,
        skill: {
          name: "goto",
          args: {
            target: { x: 8, y: 70, z: 8 },
            candidates: [{ x: 8, y: 70, z: 8 }],
            mode: "walk",
            emergency: true,
          },
          idempotencyKey: "test:retreat",
        },
        taskId: "task:test-retreat",
      },
      milestones: [],
      verified: true,
    }),
  };
  const planner = new MissionGoalPlanner({ baseline });
  const plan = planner.plan(input({
    inWorld: true,
    position: { x: 0, y: 70, z: 0 },
    health: 1.5,
    food: 16,
    foodAcquired: true,
    foodConsumed: true,
    inventory: [
      { item: "minecraft:stone_pickaxe", count: 1, durability: 80 },
      { item: "minecraft:stone_sword", count: 1, durability: 80 },
    ],
  }));
  assert.ok(plan?.nextTask !== null && plan?.nextTask !== undefined);
  assert.equal(plan.nextTask.skill.name, "goto");
  assert.equal(plan.cardId, "strategy.survive");
});
