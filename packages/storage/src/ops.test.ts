import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { dafeiyu } from "@craftmate/agent";
import { openDatabase } from "./database.ts";
import { CostStore } from "./cost.ts";
import { MemoryStore, ReplayStore } from "./memory.ts";
import { PersonaVersionStore } from "./persona.ts";
import { SqliteCommitmentGate } from "./commitment-gate.ts";
import { ActionStore, CommitmentStore, DecisionStore, SessionStore, SourceStore } from "./stores.ts";

const temporaryDatabase = (): string => join(mkdtempSync(join(tmpdir(), "craftmate-ops-")), "show.db");

const withDb = (run: (db: ReturnType<typeof openDatabase>, context: ReturnType<SessionStore["bootstrap"]>) => void): void => {
  const db = openDatabase({ file: temporaryDatabase() });
  try {
    run(db, new SessionStore(db).bootstrap(dafeiyu, "盖房"));
  } finally {
    db.close();
  }
};

describe("memory review and recall", () => {
  test("a pending draft is not recallable until it is approved", () => {
    withDb((db, context) => {
      const memory = new MemoryStore(db, context.sessionId);
      const candidate = memory.propose(
        {
          subjectRef: "viewer:abc",
          family: "viewer",
          content: "小鲸鱼喜欢铁矿",
          disclosure: "full",
          confidence: 0.8,
          evidenceSourceIds: [],
        },
        context.sessionId,
      );

      assert.equal(memory.list().length, 0);
      assert.equal(memory.recall({ subjectRef: "viewer:abc", query: "铁矿", budgetTokens: 1_200 }).length, 0);
      assert.equal(memory.pendingCandidates()[0]?.id, candidate);

      const memoryId = memory.approveCandidate(candidate);
      const recalled = memory.recall({ subjectRef: "viewer:abc", query: "铁矿", budgetTokens: 1_200 });
      assert.equal(recalled.length, 1);
      assert.equal(recalled[0]?.memory.id, memoryId);
      assert.equal(memory.pendingCandidates().length, 0);
    });
  });

  test("recall respects the token budget and never leaks another viewer's memory", () => {
    withDb((db, context) => {
      const memory = new MemoryStore(db, context.sessionId);
      for (const content of ["第一条很长的记忆".repeat(20), "第二条很长的记忆".repeat(20)]) {
        const candidate = memory.propose(
          {
            subjectRef: "viewer:abc",
            family: "viewer",
            content,
            disclosure: "full",
            confidence: 0.8,
            evidenceSourceIds: [],
          },
          context.sessionId,
        );
        memory.approveCandidate(candidate);
      }

      const recalled = memory.recall({ subjectRef: "viewer:abc", query: "", budgetTokens: 100 });
      assert.equal(recalled.length, 1);
      assert.ok((recalled[0]?.tokens ?? 0) <= 100);
      assert.equal(memory.recall({ subjectRef: "viewer:other", query: "", budgetTokens: 1_200 }).length, 0);
    });
  });

  test("a forgotten memory drops out of recall but keeps its history", () => {
    withDb((db, context) => {
      const memory = new MemoryStore(db, context.sessionId);
      const memoryId = memory.approveCandidate(
        memory.propose(
          {
            subjectRef: "viewer:abc",
            family: "experience",
            content: "上次挖矿失败了",
            disclosure: "paraphrase",
            confidence: 0.5,
            evidenceSourceIds: [],
          },
          context.sessionId,
        ),
      );
      memory.forget(memoryId);

      assert.equal(memory.recall({ subjectRef: "viewer:abc", query: "", budgetTokens: 1_200 }).length, 0);
      assert.equal(memory.list("forgotten")[0]?.id, memoryId);
    });
  });

  test("outcomes accumulate and a failure keeps its concrete condition", () => {
    withDb((db, context) => {
      const memory = new MemoryStore(db, context.sessionId);
      const memoryId = memory.approveCandidate(
        memory.propose(
          {
            subjectRef: "viewer:abc",
            family: "experience",
            content: "从矿区西侧回营地更安全",
            disclosure: "paraphrase",
            confidence: 0.7,
            evidenceSourceIds: [],
          },
          context.sessionId,
        ),
      );

      assert.equal(memory.get(memoryId)?.successCount, 0);
      memory.recordOutcome(memoryId, { ok: true });
      const updated = memory.recordOutcome(memoryId, {
        ok: false,
        condition: "背包满时会被迫绕路",
        version: "1.20.1",
      });

      assert.equal(updated?.successCount, 1);
      assert.equal(updated?.failureCount, 1);
      assert.match(updated?.conditions ?? "", /背包满/);
      assert.equal(updated?.applicableVersion, "1.20.1");
      assert.equal(memory.recordOutcome("missing", { ok: true }), null);
    });
  });

  test("a rejected candidate is never written as a memory", () => {
    withDb((db, context) => {
      const memory = new MemoryStore(db, context.sessionId);
      const candidate = memory.propose(
        {
          subjectRef: "viewer:abc",
          family: "viewer",
          content: "不该记住的内容",
          disclosure: "hint",
          confidence: 0.2,
          evidenceSourceIds: [],
        },
        context.sessionId,
      );
      memory.rejectCandidate(candidate, "置信度太低");
      assert.equal(memory.list().length, 0);
    });
  });
});

describe("persona versions", () => {
  test("publishing keeps history and a rollback reactivates the old revision", () => {
    withDb((db) => {
      const versions = new PersonaVersionStore(db);
      const first = versions.publish("dafeiyu", { ...dafeiyu, tone: "软糯" });
      const second = versions.publish("dafeiyu", { ...dafeiyu, tone: "冷淡" });
      assert.equal(versions.active("dafeiyu")?.version.id, second.id);

      versions.activate("dafeiyu", first.id);
      const active = versions.active("dafeiyu");
      assert.equal(active?.version.id, first.id);
      assert.equal(active?.content.tone, "软糯");

      const history = versions.history("dafeiyu");
      assert.equal(history.length >= 2, true);
      assert.equal(history.filter((item) => item.state === "active").length, 1);
      const restored = history.find((item) => item.revision === second.revision);
      assert.equal(restored?.content.tone, "冷淡");
    });
  });
});

describe("replay timeline", () => {
  test("a trace id returns source, decision, commitment and action in order", () => {
    withDb((db, context) => {
      const sources = new SourceStore(db);
      const decisions = new DecisionStore(db);
      const commitments = new CommitmentStore(db, context);
      const actions = new ActionStore(db);
      const now = Date.now();
      const event = {
        id: "evt-1",
        source: "douyin" as const,
        kind: "comment" as const,
        userId: "viewer-1",
        nickname: "小鲸鱼",
        text: "去挖点铁矿",
        ts: 1_000,
      };
      const source = sources.append(context.sessionId, event);
      decisions.append(
        context,
        source.id,
        {
          id: "d-1",
          eventId: "evt-1",
          nickname: "小鲸鱼",
          text: "去挖点铁矿",
          intent: "mine",
          decision: "EXECUTE",
          priority: "command",
          reason: "可行",
          score: 0.8,
          stage: "planned",
          skill: { name: "mine_block", args: { block: "minecraft:iron_ore", count: 1 }, idempotencyKey: "k1" },
          speech: "我去挖。",
          audienceRef: "viewer:abc",
          trace: { provider: "fake", model: "fake-1", latencyMs: 12, degraded: false, detail: "" },
          at: now + 1,
        },
        "evt-1",
      );
      const commitment = {
        id: "c-1",
        audienceRef: "viewer:abc",
        sourceId: source.id,
        utterance: "我去挖。",
        status: "proposed" as const,
        revision: 1,
        createdAt: now,
        deadlineAt: null,
        planId: "d-1",
        spokenAt: null,
        closedAt: null,
      };
      commitments.reserve(commitment);
      actions.begin(context.sessionId, "d-1", {
        name: "mine_block",
        args: { block: "minecraft:iron_ore", count: 1 },
        idempotencyKey: "k1",
      }, "command");

      const timeline = new ReplayStore(db).timeline("evt-1");
      const kinds = timeline.map((entry) => entry.kind).sort();
      assert.deepEqual(kinds, ["action", "commitment", "decision", "source"]);
      for (let index = 1; index < timeline.length; index += 1) {
        assert.ok((timeline[index - 1]?.at ?? 0) <= (timeline[index]?.at ?? 0));
      }
      const decided = timeline.find((entry) => entry.kind === "decision");
      assert.equal(decided?.kind === "decision" ? decided.skill : null, "mine_block");
    });
  });
});

describe("cost budget", () => {
  test("records token usage even when the configured price is zero", () => {
    withDb((db, context) => {
      const costs = new CostStore(db);
      costs.record({
        sessionId: context.sessionId,
        provider: "deepseek",
        model: "m",
        cost: 0,
        promptTokens: 41,
        completionTokens: 2,
      });

      const row = db
        .prepare(
          "SELECT cost, prompt_tokens, completion_tokens FROM model_cost LIMIT 1",
        )
        .get() as { cost: number; prompt_tokens: number; completion_tokens: number };
      assert.equal(row.cost, 0);
      assert.equal(row.prompt_tokens, 41);
      assert.equal(row.completion_tokens, 2);
      assert.equal(costs.spentSince(0), 0);
    });
  });

  test("crossing the hourly limit asks for a degradation", () => {
    withDb((db, context) => {
      const costs = new CostStore(db);
      costs.record({ sessionId: context.sessionId, provider: "deepseek", model: "m", cost: 0.6 });
      costs.record({ sessionId: context.sessionId, provider: "deepseek", model: "m", cost: 0.6 });

      assert.equal(
        costs.budget({ hourlyLimit: 1, keyLimit: 0, provider: "deepseek" }).degraded,
        true,
      );
      assert.equal(costs.budget({ hourlyLimit: 5, keyLimit: 0, provider: "deepseek" }).degraded, false);
    });
  });
});

describe("voice commitment gate", () => {
  test("only an open commitment is allowed through, and only from a real file", () => {
    const file = temporaryDatabase();
    const db = openDatabase({ file });
    try {
      const context = new SessionStore(db).bootstrap(dafeiyu, "盖房");
      new CommitmentStore(db, context).reserve({
        id: "c-open",
        audienceRef: "viewer:abc",
        sourceId: null,
        utterance: "我去挖。",
        status: "proposed",
        revision: 1,
        createdAt: Date.now(),
        deadlineAt: null,
        planId: null,
        spokenAt: null,
        closedAt: null,
      });
    } finally {
      db.close();
    }

    const gate = new SqliteCommitmentGate(file);
    try {
      assert.equal(gate.isReserved("c-open"), true);
      assert.equal(gate.isReserved("c-missing"), false);
    } finally {
      gate.close();
    }

    const missing = new SqliteCommitmentGate(join(tmpdir(), "craftmate-no-such-db.sqlite"));
    try {
      assert.equal(missing.isReserved("c-open"), false);
    } finally {
      missing.close();
    }
  });
});
