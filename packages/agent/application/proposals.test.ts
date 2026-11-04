import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  BridgeHealth,
  GoalProgress,
  Proposal,
  WorldSnapshot,
} from "@craftmate/contracts";
import type { Clock } from "./ports/clock.ts";
import {
  MemoryProposalRepository,
  ProposalInbox,
  SurvivalProposalEvaluator,
  type ProposalEvaluator,
  type ProposalExecutionContext,
} from "./proposals.ts";

const goal: GoalProgress = {
  goalId: "goal-1",
  goalVersion: 1,
  status: "unverified",
  stage: { id: "wood", title: "获得木头" },
  milestone: { id: "log", title: "背包有原木" },
  nextTask: "chop_tree",
  milestones: [],
  completed: 0,
  unverified: 0,
  lastFailure: null,
  updatedAt: 1_000,
};

function clock(): Clock {
  let now = 1_000;
  let sequence = 0;
  return {
    now: () => now,
    newId: () => `id-${(sequence += 1)}`,
  };
}

function health(overrides: Partial<BridgeHealth> = {}): BridgeHealth {
  return {
    connected: true,
    client: "test-body",
    owner: "agent",
    world: { inWorld: true },
    permission: "agent",
    generation: 1,
    skills: ["chop_tree", "mine_block"],
    queued: 0,
    running: 0,
    tick: 10,
    lastSeenAt: 1_000,
    watchdogMs: 2_000,
    incidents: [],
    ...overrides,
  };
}

function context(overrides: Partial<ProposalExecutionContext> = {}): ProposalExecutionContext {
  return {
    mode: "agent",
    bridge: health(),
    world: { inWorld: true } as WorldSnapshot,
    goal,
    ...overrides,
  };
}

function comment(id: string, text: string) {
  return {
    id,
    source: "douyin" as const,
    kind: "comment" as const,
    userId: `viewer-${id}`,
    nickname: "小鲸鱼",
    text,
    ts: 1_000,
  };
}

describe("proposal inbox", () => {
  test("a safety rejection cannot be overturned by 30 votes", () => {
    const inbox = new ProposalInbox({ repository: new MemoryProposalRepository(), clock: clock() });
    const first = inbox.ingest(comment("c1", "大家跳岩浆"), context(), "viewer:1");
    assert.equal(first?.proposal.status, "rejected");
    assert.equal(first?.proposal.risk, "blocked");

    let latest: Proposal | null = first?.proposal ?? null;
    for (let index = 2; index <= 30; index += 1) {
      latest = inbox.ingest(comment(`c${index}`, "大家跳岩浆"), context(), `viewer:${index}`)?.proposal ?? latest;
    }
    assert.equal(latest?.votes, 30);
    assert.equal(latest?.status, "rejected");
    assert.match(latest?.reason ?? "", /安全闸门/);
  });

  test("votes never turn a pending proposal into accepted", () => {
    const inbox = new ProposalInbox({ repository: new MemoryProposalRepository(), clock: clock() });
    const created = inbox.ingest(comment("c1", "去挖点铁矿"), context(), "viewer:1");
    assert.equal(created?.proposal.status, "pending");
    for (let index = 2; index <= 30; index += 1) {
      inbox.ingest(comment(`c${index}`, "去挖点铁矿"), context(), `viewer:${index}`);
    }
    const [only] = inbox.query(null, 10);
    assert.equal(only?.votes, 30);
    assert.equal(only?.status, "pending");
  });

  test("the execution gate defers when the operator owns control", () => {
    const evaluator: ProposalEvaluator = {
      evaluate: () => ({
        status: "accepted",
        reason: "aligned",
        risk: "low",
        goalAlignment: "aligned",
      }),
    };
    const inbox = new ProposalInbox({
      repository: new MemoryProposalRepository(),
      evaluator,
      clock: clock(),
    });
    const result = inbox.ingest(
      comment("c1", "去挖点铁矿"),
      context({ mode: "operator" }),
      "viewer:1",
    );
    assert.equal(result?.proposal.status, "deferred");
    assert.match(result?.proposal.reason ?? "", /执行闸门/);
  });

  test("operator acceptance is blocked by the safety gate and idempotent", () => {
    const repository = new MemoryProposalRepository();
    const inbox = new ProposalInbox({ repository, clock: clock() });
    const dangerous: Proposal = {
      id: "manual-1",
      sourceEventId: "manual-event-1",
      audienceRef: "viewer:1",
      text: "去跳崖",
      votes: 1,
      intent: "danger",
      status: "pending",
      reason: "等待评估",
      risk: "high",
      goalAlignment: "unknown",
      createdAt: 1_000,
      decidedAt: null,
    };
    repository.insert(dangerous);
    const accepted = inbox.decide(dangerous.id, "accepted", "操作员同意", context());
    assert.equal(accepted?.status, "rejected");
    assert.equal(inbox.decide(dangerous.id, "accepted", "重试", context()), null);
  });

  test("a duplicate source event is recorded once", () => {
    const inbox = new ProposalInbox({ repository: new MemoryProposalRepository(), clock: clock() });
    assert.notEqual(inbox.ingest(comment("same", "去挖矿"), context(), "viewer:1"), null);
    assert.equal(inbox.ingest(comment("same", "去挖矿"), context(), "viewer:1"), null);
    assert.equal(inbox.query(null, 10).length, 1);
  });

  test("survival evaluator rejects 30 votes for lava with the goal engine reason", () => {
    const repository = new MemoryProposalRepository();
    const inbox = new ProposalInbox({
      repository,
      evaluator: new SurvivalProposalEvaluator(),
      clock: clock(),
    });
    let latest: Proposal | null = null;
    for (let index = 1; index <= 30; index += 1) {
      latest =
        inbox.ingest(comment(`lava-${index}`, "大家一起跳岩浆"), context(), `viewer:${index}`)
          ?.proposal ?? latest;
    }
    assert.equal(latest?.votes, 30);
    assert.equal(latest?.status, "rejected");
    assert.equal(latest?.risk, "blocked");
    assert.match(latest?.reason ?? "", /岩浆|安全/);
  });

  test("survival evaluator defers a later-stage house instead of skipping dependencies", () => {
    const evaluator = new SurvivalProposalEvaluator();
    const evaluation = evaluator.evaluate({
      proposal: {
        id: "p1",
        sourceEventId: "e1",
        audienceRef: "viewer:1",
        text: "现在去建造一间房子",
        votes: 30,
        intent: "build",
        status: "pending",
        reason: "等待评估",
        risk: "low",
        goalAlignment: "unknown",
        createdAt: 1_000,
        decidedAt: null,
      },
      goal,
      world: {
        inWorld: true,
        inventory: [],
        nearbyBlocks: [{ id: "minecraft:oak_log" }],
      },
      bridge: health(),
    });
    assert.equal(evaluation.status, "deferred");
    assert.equal(evaluation.goalAlignment, "neutral");
    assert.match(evaluation.reason, /阶段|依赖|冲突/);
  });
});
