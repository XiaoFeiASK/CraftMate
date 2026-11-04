import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { dafeiyu } from "@craftmate/agent";
import type { Proposal } from "@craftmate/contracts";
import { openDatabase } from "./database.ts";
import { GoalRuntimeSqliteStore, SqliteProposalRepository } from "./goals.ts";
import { SessionStore } from "./stores.ts";

const temporaryDatabase = (): string =>
  join(mkdtempSync(join(tmpdir(), "craftmate-goal-")), "show.db");

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "proposal-1",
    sourceEventId: "comment-1",
    audienceRef: "viewer:1",
    text: "去挖点铁矿",
    votes: 1,
    intent: "mine",
    status: "pending",
    reason: "等待目标引擎",
    risk: "low",
    goalAlignment: "unknown",
    createdAt: 1_000,
    decidedAt: null,
    ...overrides,
  };
}

describe("goal runtime storage", () => {
  test("goal evidence survives a restart without replaying an in-flight task", () => {
    const file = temporaryDatabase();
    const first = openDatabase({ file });
    const context = new SessionStore(first).bootstrap(dafeiyu, "击败末影龙");
    const store = new GoalRuntimeSqliteStore(first, context);
    store.save({
      goal: {
        id: "goal-1",
        title: "击败末影龙",
        description: "完整生存链",
        status: "unverified",
        version: 1,
        setBy: "operator",
        setAt: 1_000,
      },
      enabled: true,
      progress: {
        goalId: "goal-1",
        goalVersion: 1,
        status: "unverified",
        stage: { id: "wood", title: "获得木头" },
        milestone: { id: "logs", title: "背包有原木" },
        nextTask: "chop_tree",
        milestones: [],
        completed: 0,
        unverified: 0,
        lastFailure: null,
        updatedAt: 1_000,
      },
      currentDecisionId: "decision-1",
      currentStrategyKey: "wood:chop",
      lastFailure: null,
      lastFailureStrategy: null,
      consecutiveFailures: 0,
      retryAt: 0,
      updatedAt: 1_000,
    });
    first.close();

    const second = openDatabase({ file });
    const reopened = new GoalRuntimeSqliteStore(second, context).load();
    assert.equal(reopened?.goal?.title, "击败末影龙");
    assert.equal(reopened?.currentDecisionId, "decision-1");
    assert.equal(reopened?.progress?.status, "unverified");
    second.close();
  });

  test("a proposal source event and vote are deduped in SQLite", () => {
    const db = openDatabase({ file: temporaryDatabase() });
    const context = new SessionStore(db).bootstrap(dafeiyu, "击败末影龙");
    const store = new SqliteProposalRepository(db, context);
    assert.notEqual(store.insert(proposal()), null);
    assert.equal(store.insert(proposal()), null);

    assert.equal(
      store.addVote({
        proposalId: "proposal-1",
        sourceEventId: "vote-1",
        audienceRef: "viewer:2",
        at: 1_100,
      }),
      2,
    );
    assert.equal(
      store.addVote({
        proposalId: "proposal-1",
        sourceEventId: "vote-1",
        audienceRef: "viewer:2",
        at: 1_200,
      }),
      null,
    );
    assert.equal(store.get("proposal-1")?.votes, 2);
    db.close();
  });
});
