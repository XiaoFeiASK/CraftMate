import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BridgeHealth,
  GoalProgress,
  SeasonGoal,
  WorldSnapshot,
} from "@craftmate/contracts";
import type { TaskTreeSnapshot } from "../domain/tasks/task-tree.ts";
import { TaskTree } from "../domain/tasks/task-tree.ts";
import { GoalTreePlanner } from "./goal-tree-planner.ts";
import {
  GoalRuntime,
  MemoryGoalRuntimeStore,
  type GoalPlanningInput,
  type GoalPlanner,
  type GoalSettlement,
} from "./goal-runtime.ts";

function goal(
  goalKind: SeasonGoal["goalKind"] = "dragon",
  title = goalKind === "diamond-set" ? "集齐全套钻石装备" : "击败末影龙",
): SeasonGoal {
  return {
    id: `goal-${goalKind}`,
    title,
    description: "测试目标",
    goalKind,
    status: "active",
    version: 1,
    setBy: "operator",
    setAt: 1,
  };
}

function progress(value: SeasonGoal): GoalProgress {
  return {
    goalId: value.id,
    goalVersion: value.version,
    status: "unverified",
    stage: { id: "wood-and-table", title: "木头与工作台" },
    milestone: { id: "observe", title: "等待观察" },
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

function health(overrides: Partial<BridgeHealth> = {}): BridgeHealth {
  return {
    connected: true,
    client: "test-body",
    owner: "agent",
    permission: "agent",
    generation: 1,
    skills: [
      "chop_tree",
      "collect_items",
      "craft",
      "mine_block",
      "mine_tunnel",
      "goto",
      "place_block",
      "eat",
      "equip",
      "smelt",
      "deposit",
      "attack",
      "sleep",
      "explore",
      "run_plan",
    ],
    queued: 0,
    running: 0,
    tick: 1,
    lastSeenAt: 1,
    watchdogMs: 2_000,
    incidents: [],
    world: { inWorld: true, health: 20 },
    ...overrides,
  };
}

function input(
  world: Record<string, unknown>,
  value: SeasonGoal = goal(),
  overrides: Partial<GoalPlanningInput> = {},
): GoalPlanningInput {
  return {
    goal: value,
    progress: progress(value),
    world: world as WorldSnapshot,
    health: health(),
    proposals: [],
    lastFailure: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function emptyWorld(): Record<string, unknown> {
  return {
    inWorld: true,
    world: "minecraft:overworld",
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    inventory: [],
    nearbyBlocks: [
      {
        id: "minecraft:oak_log",
        x: 1,
        y: 64,
        z: 0,
        distance: 1,
        reachable: true,
        visible: true,
      },
    ],
    entities: [],
  };
}

function complete(planner: GoalTreePlanner, taskId: string, at = 2_000): void {
  const outcome: GoalSettlement = {
    status: "completed",
    at,
    changes: [{ kind: "block_broken", detail: "minecraft:oak_log" }],
  };
  planner.noteSettlement({
    decisionId: "decision-1",
    taskId,
    strategyKey: "strategy-1",
    outcome,
  });
}

test("the tree builds every stage up front but expands only the current one", () => {
  const planner = new GoalTreePlanner();
  const plan = planner.plan(input(emptyWorld()));
  assert.ok(plan?.nextTask);
  const snapshot = planner.treeSnapshot();
  assert.ok(snapshot);
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node] as const));
  const root = byId.get(snapshot.rootId);
  assert.equal(root?.kind, "goal");
  const stages = snapshot.nodes.filter((node) => node.kind === "stage");
  assert.equal(stages.length, 10);
  assert.ok(snapshot.nodes.some((node) => node.kind === "interrupt"));
  const expanded = stages.filter((stage) =>
    snapshot.nodes.some(
      (node) => node.parentId === stage.id && node.kind === "milestone",
    ),
  );
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0]?.state, "active");
  assert.ok(
    snapshot.nodes.some(
      (node) => node.kind === "skill" && node.state === "active",
    ),
  );
});

test("a completed skill marks its task and the next plan evaluates the milestone", () => {
  const planner = new GoalTreePlanner();
  const first = planner.plan(input(emptyWorld()));
  assert.ok(first?.nextTask?.taskId);
  complete(planner, first.nextTask.taskId);
  const settled = planner.treeSnapshot();
  assert.ok(settled);
  assert.ok(
    settled.nodes.some(
      (node) =>
        node.id === first.nextTask?.taskId &&
        node.kind === "skill" &&
        node.state === "succeeded",
    ),
  );
  assert.ok(
    settled.nodes.some(
      (node) => node.kind === "task" && node.state === "succeeded",
    ),
  );

  const withLog = emptyWorld();
  withLog.inventory = [{ item: "minecraft:oak_log", count: 1 }];
  const second = planner.plan(
    input(withLog, goal(), {
      progress: {
        ...progress(goal()),
        stage: { id: "wood-and-table", title: "木头与工作台" },
      },
    }),
  );
  assert.ok(second);
  const next = planner.treeSnapshot();
  assert.ok(next);
  assert.ok(
    next.nodes.some(
      (node) =>
        node.kind === "milestone" &&
        node.intent === "已获得木头" &&
        node.state === "succeeded",
    ),
  );
});

test("a skill failure retries once before the milestone changes strategy", () => {
  const planner = new GoalTreePlanner();
  const first = planner.plan(input(emptyWorld()));
  assert.ok(first?.nextTask?.taskId);
  const failed: GoalSettlement = {
    status: "failed",
    errorCode: "E_UNREACHABLE",
    detail: "test failure",
    at: 2_000,
    changes: [],
  };
  planner.noteSettlement({
    decisionId: "decision-1",
    taskId: first.nextTask.taskId,
    strategyKey: "strategy-1",
    outcome: failed,
  });
  const retry = planner.plan(input(emptyWorld()));
  assert.equal(retry?.nextTask?.taskId, first.nextTask.taskId);
  const retried = planner.treeSnapshot();
  assert.ok(
    retried?.nodes.some(
      (node) =>
        node.id === first.nextTask?.taskId && node.failureCount === 1,
    ),
  );

  if (retry?.nextTask?.taskId === undefined) return;
  planner.noteSettlement({
    decisionId: "decision-2",
    taskId: retry.nextTask.taskId,
    strategyKey: "strategy-1",
    outcome: { ...failed, at: 3_000 },
  });
  const after = planner.plan(
    input(emptyWorld(), goal(), {
      lastFailure: "test failure",
      consecutiveFailures: 2,
    }),
  );
  assert.ok(after);
  const snapshot = planner.treeSnapshot();
  assert.ok(snapshot);
  assert.ok(
    snapshot.nodes.some(
      (node) =>
        node.id === first.nextTask?.taskId &&
        node.kind === "skill" &&
        node.state === "failed",
    ),
  );
  if (after.nextTask !== null) {
    assert.notEqual(after.nextTask.taskId, first.nextTask.taskId);
  }
});

test("a failed tree tunnel walks to the first stair cell instead of replaying itself", () => {
  const now = 1_000;
  const tree = new TaskTree(() => now);
  const root = tree.createRoot({
    id: "goal:test",
    kind: "goal",
    mode: "selector",
    handler: "goal",
    args: { goalKind: "dragon" },
    intent: "击败末影龙",
    targetFamily: "dragon",
    sourceKey: "goal:test",
  });
  const [stage] = tree.attach(root.id, [
    {
      id: "stage:diamond",
      kind: "stage",
      mode: "sequence",
      handler: "stage",
      args: { stage: "diamond-gear" },
      intent: "钻石装备",
      targetFamily: "diamond-gear",
      sourceKey: "stage:diamond-gear",
    },
  ]);
  const [milestone] = tree.attach(stage!.id, [
    {
      id: "milestone:pickaxe",
      kind: "milestone",
      mode: "sequence",
      handler: "milestone:diamond-gear:have-diamond-pickaxe",
      args: { stage: "diamond-gear", milestoneId: "have-diamond-pickaxe" },
      intent: "背包有钻石镐",
      targetFamily: "diamond-gear",
      sourceKey: "milestone:diamond-gear:have-diamond-pickaxe",
    },
  ]);
  const tunnelSignature =
    'diamond-gear:mine:mine_tunnel:{"length":0,"rememberMine":true,"targetY":57}';
  const [stuck] = tree.attach(milestone!.id, [
    {
      id: "task:stuck-tunnel",
      kind: "task",
      handler: "task",
      args: {
        task: {
          taskId: "task:stuck-tunnel",
          title: "沿复用矿道回营地",
          kind: "mine",
          stage: "diamond-gear",
          skill: {
            name: "mine_tunnel",
            args: { targetY: 57, length: 0, rememberMine: true },
            idempotencyKey: "stuck-tunnel",
          },
          critical: false,
          targetLock: null,
          signature: tunnelSignature,
        },
      },
      intent: "沿复用矿道回营地",
      targetFamily: "diamond-gear",
      sourceKey: tunnelSignature,
    },
  ]);
  const snapshot = tree.snapshot();
  const patched: TaskTreeSnapshot = {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => {
      if (node.id === stage!.id || node.id === milestone!.id) {
        return { ...node, state: "active" as const };
      }
      if (node.id === stuck!.id) {
        return {
          ...node,
          state: "failed" as const,
          failureCategory: "precondition" as const,
          failureDetail: "E_PRECONDITION: no safe mining direction from the current cell",
          failureCount: 2,
        };
      }
      return node;
    }),
  };
  const world = {
    inWorld: true,
    world: "minecraft:overworld",
    position: { x: 155.5, y: 73, z: -68.5 },
    canSeeSky: true,
    surfaceY: 73,
    health: 20,
    food: 20,
    inventory: [
      { item: "minecraft:iron_pickaxe", count: 1, durability: 67 },
      { item: "minecraft:cobblestone", count: 32 },
    ],
    nearbyBlocks: [],
    entities: [],
    mine: {
      entrance: { x: 153, y: 75, z: -69 },
      direction: "north",
      stair: { stand: { x: 153, y: 63, z: -80 }, depth: 12 },
    },
  };
  const plan = new GoalTreePlanner().plan(
    input(world, goal(), { treeSnapshot: patched }),
  );
  assert.equal(plan.nextTask?.skill.name, "goto");
  assert.deepEqual(plan.nextTask?.skill.args["target"], {
    x: 153,
    y: 74,
    z: -70,
  });
  assert.match(plan.nextTask?.text ?? "", /矿道第一阶/u);
});

test("a preempted skill is reset and routed through the interrupt branch", () => {
  const planner = new GoalTreePlanner();
  const first = planner.plan(input(emptyWorld()));
  assert.ok(first?.nextTask?.taskId);
  planner.noteSettlement({
    decisionId: "decision-1",
    taskId: first.nextTask.taskId,
    strategyKey: "strategy-1",
    outcome: {
      status: "preempted",
      errorCode: "E_DANGER",
      detail: "zombie",
      at: 2_000,
      changes: [],
    },
  });
  const danger = emptyWorld();
  danger.health = 4;
  danger.entities = [
    { type: "minecraft:zombie", name: "Zombie", distance: 2 },
  ];
  const next = planner.plan(input(danger));
  assert.ok(next?.nextTask);
  const snapshot = planner.treeSnapshot();
  assert.ok(snapshot);
  const interrupt = snapshot.nodes.find((node) => node.kind === "interrupt");
  assert.equal(interrupt?.state, "active");
  assert.equal(snapshot.pausedCursorId !== null, true);
  assert.ok(
    snapshot.nodes.some(
      (node) => node.parentId === interrupt?.id && node.kind === "task",
    ),
  );
});

test("a tool-lost interrupt clears once a usable pickaxe is back", () => {
  const planner = new GoalTreePlanner();
  const lost = emptyWorld();
  lost.pickaxeLost = true;
  const during = planner.plan(input(lost));
  assert.ok(during);
  const duringSnap = planner.treeSnapshot();
  assert.ok(duringSnap);
  const interrupt = duringSnap.nodes.find((node) => node.kind === "interrupt");
  assert.equal(interrupt?.state, "active");
  assert.ok(interrupt?.id);

  const recovered = emptyWorld();
  recovered.pickaxeLost = false;
  recovered.inventory = [
    { item: "minecraft:stone_pickaxe", count: 1, durability: 100 },
  ];
  const after = planner.plan(input(recovered));
  const afterSnap = planner.treeSnapshot();
  assert.ok(afterSnap);
  assert.equal(
    afterSnap.nodes.find((node) => node.id === interrupt?.id)?.state,
    "succeeded",
  );
  assert.equal(afterSnap.pausedCursorId, null);
  assert.ok(after?.nextTask);
  assert.notEqual(after?.nextTask?.skill.name, "attack");
});

test("diamond-set acceptance requires all six diamond pieces", () => {
  const pieces = [
    "minecraft:diamond_pickaxe",
    "minecraft:diamond_sword",
    "minecraft:diamond_helmet",
    "minecraft:diamond_chestplate",
    "minecraft:diamond_leggings",
    "minecraft:diamond_boots",
  ];
  const five = emptyWorld();
  five.inventory = pieces.slice(0, 5).map((item) => ({ item, count: 1 }));
  const partial = new GoalTreePlanner().plan(
    input(five, goal("diamond-set"), {
      progress: progress(goal("diamond-set")),
    }),
  );
  assert.notEqual(partial?.complete, true);

  const six = emptyWorld();
  six.inventory = pieces.map((item) => ({ item, count: 1 }));
  const planner = new GoalTreePlanner();
  const done = planner.plan(
    input(six, goal("diamond-set"), {
      progress: progress(goal("diamond-set")),
    }),
  );
  assert.equal(done?.complete, true);
  assert.equal(done?.nextTask, null);
  const snapshot = planner.treeSnapshot();
  assert.equal(
    snapshot?.nodes.find((node) => node.id === snapshot.rootId)?.state,
    "succeeded",
  );
});

test("the runtime persists the tree engine snapshot and restores it without replay", () => {
  let now = 1_000;
  let serial = 0;
  const clock = {
    now: () => now,
    newId: () => `id-${(serial += 1)}`,
  };
  const store = new MemoryGoalRuntimeStore();
  const bridge = health();
  const world = emptyWorld() as WorldSnapshot;
  const first = new GoalRuntime({
    store,
    planner: new GoalTreePlanner(),
    clock,
    failureBaseMs: 1_000,
  });
  first.setGoal({
    title: "击败末影龙",
    description: "完整生存链",
    goalKind: "dragon",
  });
  const dispatch = first.beginStep({ mode: "agent", bridge, world });
  assert.ok(dispatch);
  assert.ok(
    first.currentProgress?.taskTree?.nodes.some((node) => node.kind === "goal"),
  );
  assert.equal(
    first.settle(dispatch.decision.id, {
      status: "completed",
      at: 2_000,
      changes: [{ kind: "block_broken", detail: "minecraft:oak_log" }],
    }),
    true,
  );
  const record = first.snapshot();
  assert.ok(record.taskTree);
  assert.ok(
    record.taskTree.nodes.some(
      (node) => node.kind === "skill" && node.state === "succeeded",
    ),
  );
  assert.ok(
    first.currentProgress?.taskTree?.nodes.some(
      (node) => node.kind === "task" && node.state === "succeeded",
    ),
  );

  now = 3_000;
  const second = new GoalRuntime({
    store,
    planner: new GoalTreePlanner(),
    clock,
    failureBaseMs: 1_000,
  });
  second.restore();
  const restored = second.snapshot();
  assert.equal(restored.taskTree?.rootId, record.taskTree.rootId);
  assert.ok(
    restored.taskTree?.nodes.some(
      (node) => node.kind === "skill" && node.state === "succeeded",
    ),
  );
  const next = second.beginStep({ mode: "agent", bridge, world });
  assert.ok(next, second.currentProgress?.lastFailure ?? "no task after restore");
});

test("an incompatible persisted tree is discarded and rebuilt", () => {
  const legacy = {
    schemaVersion: 1,
    rootId: "old-root",
    cursorId: "old-root",
    pausedCursorId: null,
    nodes: [],
    failures: [],
    updatedAt: 1,
  };
  const planner = new GoalTreePlanner();
  const plan = planner.plan(
    input(emptyWorld(), goal(), {
      treeSnapshot: legacy as never,
    }),
  );
  assert.ok(plan?.nextTask);
  const snapshot = planner.treeSnapshot();
  assert.equal(snapshot?.schemaVersion, 2);
  assert.notEqual(snapshot?.rootId, "old-root");
  assert.equal(
    snapshot?.nodes.find((node) => node.id === snapshot.rootId)?.kind,
    "goal",
  );
});

test("a body reconnect revives a tree branch blocked by transient failures", () => {
  let now = 1_000;
  let serial = 0;
  const clock = {
    now: () => now,
    newId: () => `id-${(serial += 1)}`,
  };
  const store = new MemoryGoalRuntimeStore();
  const runtime = new GoalRuntime({
    store,
    planner: new GoalTreePlanner(),
    clock,
    failureBaseMs: 1,
    failureMaxMs: 1,
    circuitFailureThreshold: 99,
  });
  runtime.restore();
  runtime.setGoal({
    title: "击败末影龙",
    description: "完整生存链",
    goalKind: "dragon",
  });
  const world = emptyWorld() as WorldSnapshot;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const issued = runtime.beginStep({ mode: "agent", bridge: health(), world });
    assert.ok(issued, `attempt ${attempt + 1} should be issued`);
    assert.equal(
      runtime.settle(issued.decision.id, {
        status: "failed",
        errorCode: "E_STUCK",
        detail: "ceiling target is a player facility",
        at: now,
      }),
      true,
    );
    now += 10;
  }
  assert.equal(
    runtime.beginStep({ mode: "agent", bridge: health(), world }),
    null,
    "the failed branch stays blocked while the same body is connected",
  );
  assert.equal(runtime.currentProgress?.status, "blocked");

  const revived = runtime.beginStep({
    mode: "agent",
    bridge: health({ generation: 2 }),
    world,
  });
  assert.ok(revived, runtime.currentProgress?.lastFailure ?? "reconnect must revive");
  assert.equal(
    runtime.currentProgress?.taskTree?.nodes.some(
      (node) => node.state === "blocked" || node.state === "failed",
    ),
    false,
  );
});

test("a blocked tree retries after a cooldown without a reconnect", () => {
  let now = 1_000;
  let serial = 0;
  const clock = {
    now: () => now,
    newId: () => `id-${(serial += 1)}`,
  };
  const node = (
    id: string,
    parentId: string | null,
    kind: "goal" | "stage" | "milestone" | "skill",
    state: "active" | "blocked" | "failed" | "pending",
  ) => ({
    id,
    parentId,
    kind,
    mode: kind === "goal" ? ("selector" as const) : ("sequence" as const),
    handler: "task",
    args: {},
    trigger: null,
    intent: id,
    targetFamily: "diamond-gear",
    quantity: 1,
    preconditions: [],
    successEvidence: [],
    priority: "goal" as const,
    state,
    sourceKey: `source:${id}`,
    fallbackNodeId: null,
    failureCategory: null,
    failureDetail: null,
    failureCount: 0,
    reason: null,
    createdAt: 1,
    updatedAt: 1,
  });
  const parked: TaskTreeSnapshot = {
    schemaVersion: 2,
    rootId: "goal",
    cursorId: "skill",
    pausedCursorId: null,
    nodes: [
      node("goal", null, "goal", "active"),
      node("stage", "goal", "stage", "blocked"),
      node("milestone", "stage", "milestone", "blocked"),
      node("skill", "milestone", "skill", "failed"),
    ],
    failures: [],
    updatedAt: 1,
  };
  const reopened: TaskTreeSnapshot = {
    ...parked,
    nodes: parked.nodes.map((entry) =>
      entry.state === "blocked" || entry.state === "failed"
        ? { ...entry, state: "pending" as const }
        : entry,
    ),
  };
  let retryCalls = 0;
  let revived = 0;
  const planner: GoalPlanner = {
    engine: "tree",
    retryFailed() {
      retryCalls += 1;
      // The first connection is also a "reconnect"; an empty runtime has no
      // tree yet, so that call must not count as the cooldown retry.
      if (retryCalls === 1) return 0;
      revived = 3;
      return 3;
    },
    treeSnapshot: () => (revived > 0 ? reopened : parked),
    plan: () => ({
      stage: { id: "diamond-gear", title: "钻石装备" },
      milestone: { id: "have-diamond-pickaxe", title: "背包有钻石镐" },
      nextTask:
        revived > 0
          ? {
              intent: "move",
              text: "重新出发",
              reason: "退避结束",
              skill: {
                name: "goto",
                args: { target: { x: 0, y: 64, z: 0 } },
                idempotencyKey: "retry-1",
              },
              taskId: "skill",
            }
          : null,
      milestones: [],
      verified: false,
      blockedReason: revived > 0 ? null : "里程碑连续失败 2 次",
      treeSnapshot: revived > 0 ? reopened : parked,
    }),
  };
  const runtime = new GoalRuntime({
    store: new MemoryGoalRuntimeStore(),
    planner,
    clock,
    failureBaseMs: 1,
    failureMaxMs: 1,
    blockedRetryBaseMs: 1_000,
    circuitFailureThreshold: 99,
  });
  runtime.restore();
  runtime.setGoal({
    title: "击败末影龙",
    description: "完整生存链",
    goalKind: "dragon",
  });
  const world = emptyWorld() as WorldSnapshot;
  const bridge = health();

  assert.equal(runtime.beginStep({ mode: "agent", bridge, world }), null);
  assert.equal(runtime.currentProgress?.status, "blocked");
  assert.equal(
    runtime.beginStep({ mode: "agent", bridge, world }),
    null,
    "the parked tree stays quiet during the cooldown",
  );

  now += 1_001;
  const retried = runtime.beginStep({ mode: "agent", bridge, world });
  assert.ok(
    retried,
    runtime.currentProgress?.lastFailure ?? "the cooldown must reopen the tree",
  );
  assert.equal(retryCalls, 2);
  assert.equal(revived, 3);
  assert.equal(
    runtime.currentProgress?.taskTree?.nodes.some(
      (entry) => entry.state === "blocked" || entry.state === "failed",
    ),
    false,
  );
});

test("a consumed iron pickaxe reopens the completed iron stage", () => {
  const base = new GoalTreePlanner();
  const dragon = goal();
  base.plan(input(emptyWorld(), dragon));
  const snapshot = base.treeSnapshot();
  assert.ok(snapshot);
  const completedBeforeIron = new Set([
    "wood-and-table",
    "stone-tools",
    "food",
    "shelter",
  ]);
  const nodes = snapshot.nodes.map((node) => {
    if (node.kind !== "stage") return node;
    return completedBeforeIron.has(node.targetFamily) ||
      node.targetFamily === "iron"
      ? { ...node, state: "succeeded" as const }
      : node;
  });
  const world = {
    ...emptyWorld(),
    inventory: [
      { item: "minecraft:crafting_table", count: 1 },
      { item: "minecraft:oak_planks", count: 8 },
      { item: "minecraft:stone_pickaxe", count: 1 },
      { item: "minecraft:cobblestone", count: 16 },
      { item: "minecraft:chest", count: 1 },
      { item: "minecraft:red_bed", count: 1 },
      { item: "minecraft:furnace", count: 1 },
      { item: "minecraft:torch", count: 8 },
      { item: "minecraft:raw_iron", count: 8 },
      { item: "minecraft:coal", count: 8 },
    ],
  };
  const planner = new GoalTreePlanner();
  const plan = planner.plan(
    input(world, dragon, {
      treeSnapshot: { ...snapshot, nodes, updatedAt: snapshot.updatedAt + 1 },
    }),
  );
  assert.equal(plan?.stage.id, "iron");
  assert.ok(plan?.nextTask, plan?.blockedReason ?? "the iron stage must produce work");
});
