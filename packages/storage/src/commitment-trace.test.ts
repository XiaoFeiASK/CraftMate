import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dafeiyu } from "@craftmate/agent";
import { CommitmentLedger } from "@craftmate/agent/domain";
import { CommitmentStore, DecisionStore, ReplayStore, SessionStore, SourceStore, openDatabase } from "./index.ts";
import type { Decision } from "@craftmate/contracts";

const temporaryDatabase = (): string => join(mkdtempSync(join(tmpdir(), "craftmate-trace-")), "show.db");

describe("commitment source tracing", () => {
  test("a commitment can be traced back to its originating source event", () => {
    const file = temporaryDatabase();
    const db = openDatabase({ file });
    try {
      const context = new SessionStore(db).bootstrap(dafeiyu, "测试目标");
      const sources = new SourceStore(db);
      const decisions = new DecisionStore(db);
      const commitments = new CommitmentStore(db, context);
      const replay = new ReplayStore(db);

      // Simulate an audience event arriving
      const event = {
        id: "evt-trace-1",
        source: "douyin" as const,
        kind: "comment" as const,
        userId: "viewer-123",
        nickname: "测试观众",
        text: "去挖铁矿",
        ts: Date.now(),
      };

      // Record the source
      const source = sources.append(context.sessionId, event);
      assert.ok(source.inserted, "source should be inserted");

      // Create a decision linked to this source
      const decision: Decision = {
        id: "d-trace-1",
        eventId: event.id,
        nickname: event.nickname,
        text: event.text,
        intent: "mine",
        decision: "EXECUTE",
        priority: "command",
        reason: "可行",
        score: 0.8,
        stage: "planned",
        skill: { name: "mine_block", args: { material: "iron_ore" } },
        speech: "好的，我去挖铁矿。",
        audienceRef: "viewer:abc123",
        trace: { provider: "deepseek", model: "test", latencyMs: 100, degraded: false },
        at: Date.now(),
      };
      decisions.append(context, source.id, decision, event.id);

      // Create a commitment with the source linked
      const ledger = new CommitmentLedger({ journal: commitments });
      const commitment = ledger.reserve({
        audienceRef: decision.audienceRef,
        sourceId: source.id,
        utterance: decision.speech,
        planId: decision.id,
      });

      // Verify the commitment has the source_id
      assert.equal(commitment.sourceId, source.id, "commitment should have source_id");
      assert.equal(commitment.planId, decision.id, "commitment should have plan_id");

      // Verify timeline includes the commitment with proper linkage
      const timeline = replay.timeline(event.id);
      const timelineKinds = timeline.map((entry) => entry.kind);
      assert.ok(timelineKinds.includes("source"), "timeline should include source");
      assert.ok(timelineKinds.includes("decision"), "timeline should include decision");
      assert.ok(timelineKinds.includes("commitment"), "timeline should include commitment");

      // Verify we can trace from commitment back to source through the database
      const storedCommitment = db
        .prepare("SELECT source_id, plan_id FROM commitment WHERE id = ?")
        .get(commitment.id) as { source_id: string; plan_id: string } | undefined;
      assert.ok(storedCommitment, "commitment should be in database");
      assert.equal(storedCommitment.source_id, source.id, "stored commitment should have correct source_id");
      assert.equal(storedCommitment.plan_id, decision.id, "stored commitment should have correct plan_id");

      // Verify the source can be retrieved via the commitment's source_id
      const linkedSource = db
        .prepare("SELECT external_event_id FROM source WHERE id = ?")
        .get(storedCommitment.source_id) as { external_event_id: string } | undefined;
      assert.ok(linkedSource, "should be able to retrieve source via commitment");
      assert.equal(linkedSource.external_event_id, event.id, "linked source should match original event");
    } finally {
      db.close();
    }
  });

  test("commitment source survives process restart", () => {
    const file = temporaryDatabase();
    let commitmentId: string;
    let sourceId: string;
    let eventId: string;

    // First session: create and persist
    {
      const db = openDatabase({ file });
      const context = new SessionStore(db).bootstrap(dafeiyu, "重启测试");
      const sources = new SourceStore(db);
      const decisions = new DecisionStore(db);
      const commitments = new CommitmentStore(db, context);

      const event = {
        id: "evt-restart-1",
        source: "douyin" as const,
        kind: "comment" as const,
        userId: "viewer-999",
        nickname: "重启测试观众",
        text: "盖房子",
        ts: Date.now(),
      };
      eventId = event.id;

      const source = sources.append(context.sessionId, event);
      sourceId = source.id;

      const decision: Decision = {
        id: "d-restart-1",
        eventId: event.id,
        nickname: event.nickname,
        text: event.text,
        intent: "build",
        decision: "EXECUTE",
        priority: "command",
        reason: "可以执行",
        score: 0.9,
        stage: "planned",
        skill: null,
        speech: "好的，我来盖房子。",
        audienceRef: "viewer:def456",
        trace: null,
        at: Date.now(),
      };
      decisions.append(context, source.id, decision, event.id);

      const ledger = new CommitmentLedger({ journal: commitments });
      const commitment = ledger.reserve({
        audienceRef: decision.audienceRef,
        sourceId: source.id,
        utterance: decision.speech,
        planId: decision.id,
      });
      commitmentId = commitment.id;

      db.close();
    }

    // Second session: verify after restart
    {
      const db = openDatabase({ file, skipMigrations: true });
      try {
        const replay = new ReplayStore(db);

        // Verify timeline still works after restart
        const timeline = replay.timeline(eventId);
        const commitmentEntry = timeline.find((entry) => entry.kind === "commitment");
        assert.ok(commitmentEntry, "commitment should appear in timeline after restart");

        // Verify the commitment still has its source_id
        const stored = db
          .prepare("SELECT source_id FROM commitment WHERE id = ?")
          .get(commitmentId) as { source_id: string } | undefined;
        assert.ok(stored, "commitment should exist after restart");
        assert.equal(stored.source_id, sourceId, "source_id should be preserved after restart");
      } finally {
        db.close();
      }
    }
  });
});
