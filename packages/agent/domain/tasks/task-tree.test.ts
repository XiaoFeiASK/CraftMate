import assert from "node:assert/strict";
import { test } from "node:test";
import { TargetHysteresis, TaskScheduler } from "./scheduler.ts";
import { TaskTree } from "./task-tree.ts";

function clock() {
  let now = 1_000;
  return {
    now: () => now,
    advance: (ms = 1) => {
      now += ms;
    },
  };
}

test("only the active branch expands and advances in order", () => {
  const time = clock();
  const tree = new TaskTree(time.now);
  const root = tree.createRoot({
    intent: "iron set",
    targetFamily: "iron-set",
    successEvidence: ["six iron pieces"],
  });
  const [mine, smelt] = tree.expand(root.id, [
    { intent: "mine ore", targetFamily: "iron-ore" },
    { intent: "smelt ingots", targetFamily: "iron-ingot" },
  ]);
  assert.equal(tree.current?.id, mine!.id);
  assert.equal(smelt!.state, "pending");
  tree.complete(mine!.id, ["raw_iron +3"]);
  assert.equal(tree.current?.id, smelt!.id);
});

test("a task requiring evidence cannot complete without it", () => {
  const tree = new TaskTree();
  const root = tree.createRoot({
    intent: "mine",
    targetFamily: "iron-ore",
    successEvidence: ["raw_iron increased"],
  });
  assert.throws(() => tree.complete(root.id));
  tree.complete(root.id, ["raw_iron 1 -> 3"]);
  assert.equal(tree.get(root.id)?.state, "succeeded");
});

test("two failures of one source blacklist it and switch to the fallback", () => {
  const time = clock();
  const tree = new TaskTree(time.now);
  const root = tree.createRoot({ intent: "get iron", targetFamily: "iron" });
  const mine = tree.add({
    parentId: root.id,
    intent: "mine ore",
    targetFamily: "iron-ore",
    sourceKey: "ore:10,20,30",
  });
  const trade = tree.add({
    parentId: root.id,
    intent: "trade iron",
    targetFamily: "iron-trade",
    sourceKey: "trade:farmer",
  });
  tree.activate(mine.id);
  const first = tree.fail(mine.id, "unreachable", "no route");
  assert.equal(first.blacklisted, false);
  assert.equal(first.node.state, "blocked");
  tree.activate(mine.id);
  const second = tree.fail(mine.id, "unreachable", "no route again");
  assert.equal(second.blacklisted, true);
  assert.equal(tree.sourceBlocked("ore:10,20,30"), true);
  assert.equal(tree.current?.id, trade.id);
});

test("invalidating a branch preserves succeeded siblings and advances", () => {
  const tree = new TaskTree();
  const root = tree.createRoot({ intent: "gear", targetFamily: "iron-set" });
  const [first, second] = tree.expand(root.id, [
    { intent: "pickaxe", targetFamily: "iron-pickaxe" },
    { intent: "sword", targetFamily: "iron-sword" },
  ]);
  tree.complete(first!.id, ["pickaxe crafted"]);
  tree.invalidate(second!.id, "world changed");
  assert.equal(tree.get(first!.id)?.state, "succeeded");
  assert.equal(tree.get(second!.id)?.state, "invalidated");
  assert.equal(tree.current?.id, root.id);
});

test("survival preemption restores the interrupted cursor", () => {
  const tree = new TaskTree();
  const root = tree.createRoot({ intent: "iron", targetFamily: "iron" });
  const work = tree.add({ parentId: root.id, intent: "mine", targetFamily: "ore" });
  tree.activate(work.id);
  const survival = tree.preempt({
    intent: "retreat",
    targetFamily: "safety",
    priority: "survival",
  });
  assert.equal(tree.current?.id, survival.id);
  tree.complete(survival.id, ["safe"]);
  assert.equal(tree.resumeAfterPreemption()?.id, work.id);
});

test("snapshot restore keeps cursor, evidence and blacklist", () => {
  const time = clock();
  const tree = new TaskTree(time.now);
  const root = tree.createRoot({ intent: "iron", targetFamily: "iron" });
  const mine = tree.add({
    parentId: root.id,
    intent: "mine",
    targetFamily: "ore",
    sourceKey: "source:x",
  });
  tree.fail(mine.id, "not_observed", "missing");
  tree.activate(mine.id);
  tree.fail(mine.id, "not_observed", "missing again");
  const restored = TaskTree.restore(tree.snapshot(), time.now);
  assert.equal(restored.current?.id, root.id);
  assert.equal(restored.sourceBlocked("source:x"), true);
  assert.equal(restored.snapshot().nodes.length, 2);
});

test("target hysteresis requires two 20% wins but changes invalid targets at once", () => {
  const hysteresis = new TargetHysteresis();
  const current = { key: "a", score: 10, at: 1 };
  const challenger = { key: "b", score: 13, at: 2 };
  assert.equal(hysteresis.observe(current)?.key, "a");
  assert.equal(hysteresis.observe(challenger)?.key, "a");
  assert.equal(hysteresis.observe(challenger)?.key, "b");
  assert.equal(hysteresis.observe({ key: "c", score: 1, at: 3 }, false)?.key, "c");
});

test("the scheduler never lets optional work preempt survival", () => {
  const scheduler = new TaskScheduler();
  const base = {
    parentId: null,
    kind: "task",
    mode: null,
    handler: "task",
    args: {},
    trigger: null,
    targetFamily: "x",
    quantity: 1,
    preconditions: [],
    successEvidence: [],
    sourceKey: "x",
    fallbackNodeId: null,
    failureCategory: null,
    failureDetail: null,
    failureCount: 0,
    reason: null,
    createdAt: 1,
    updatedAt: 1,
  } as const;
  const survival = { ...base, id: "task:s", intent: "eat", priority: "survival", state: "active" } as const;
  const optional = { ...base, id: "task:o", intent: "decorate", priority: "optional", state: "active" } as const;
  assert.equal(scheduler.choose([optional, survival])?.id, "task:s");
  assert.equal(scheduler.shouldPreempt(optional, survival), true);
  assert.equal(scheduler.shouldPreempt(survival, optional), false);
});

test("the scheduler never executes a blocked or waiting node", () => {
  const scheduler = new TaskScheduler();
  const base = {
    parentId: null,
    kind: "task",
    mode: null,
    handler: "task",
    args: {},
    trigger: null,
    targetFamily: "x",
    quantity: 1,
    preconditions: [],
    successEvidence: [],
    sourceKey: "x",
    fallbackNodeId: null,
    failureCategory: null,
    failureDetail: null,
    failureCount: 0,
    reason: null,
    createdAt: 1,
    updatedAt: 1,
    priority: "goal",
  } as const;
  const blocked = {
    ...base,
    id: "task:blocked",
    intent: "blocked work",
    state: "blocked",
  } as const;
  const waiting = {
    ...base,
    id: "task:waiting",
    intent: "waiting work",
    state: "waiting",
  } as const;
  const active = {
    ...base,
    id: "task:active",
    intent: "real work",
    state: "active",
  } as const;
  assert.equal(scheduler.choose([blocked, waiting]) ?? null, null);
  assert.equal(scheduler.choose([blocked, active, waiting])?.id, "task:active");
});

test("a reconnect revives failed branches without erasing completed work", () => {
  const time = clock();
  const tree = new TaskTree(time.now);
  const root = tree.createRoot({ intent: "get iron", targetFamily: "iron" });
  const [mine, smelt] = tree.expand(root.id, [
    {
      intent: "mine ore",
      targetFamily: "iron-ore",
      sourceKey: "ore:10,20,30",
    },
    { intent: "smelt ingots", targetFamily: "iron-ingot" },
  ]);
  tree.activate(mine!.id);
  tree.fail(mine!.id, "unreachable", "no route");
  tree.activate(mine!.id);
  tree.fail(mine!.id, "unreachable", "no route again");
  assert.equal(tree.sourceBlocked("ore:10,20,30"), true);
  tree.complete(smelt!.id, ["iron ingot +1"]);

  assert.equal(tree.reviveFailures("body reconnected"), 1);
  assert.equal(tree.get(mine!.id)?.state, "pending");
  assert.equal(tree.get(smelt!.id)?.state, "succeeded");
  assert.equal(tree.sourceBlocked("ore:10,20,30"), false);
});
