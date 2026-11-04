import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Show, dafeiyu } from "@craftmate/agent";
import { CommitmentLedger } from "@craftmate/agent/domain";
import { openDatabase } from "@craftmate/storage";
import { CommitmentStore, SessionStore, SqliteRecorder } from "@craftmate/storage";
import type { Decision } from "@craftmate/contracts";
import { speakDecision } from "./speech.ts";

const decision = (overrides: Partial<Decision> = {}): Decision => ({
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
  skill: null,
  speech: "好，我去挖铁矿。",
  audienceRef: "viewer:abc",
  trace: null,
  at: Date.now(),
  ...overrides,
});

function harness(): {
  show: Show;
  commitments: CommitmentStore;
  close: () => void;
} {
  const file = join(mkdtempSync(join(tmpdir(), "craftmate-speech-")), "show.db");
  const db = openDatabase({ file });
  const context = new SessionStore(db).bootstrap(dafeiyu, "盖房");
  const commitments = new CommitmentStore(db, context);
  return {
    show: new Show({
      persona: dafeiyu,
      ledger: new CommitmentLedger({ journal: commitments }),
      recorder: new SqliteRecorder(db, context),
    }),
    commitments,
    close: () => db.close(),
  };
}

describe("decision to speech", () => {
  test("the commitment is durable before the voice is asked to speak", () => {
    const { show, commitments, close } = harness();
    try {
      let seenAtCall: string | null = null;
      const outcome = speakDecision(show, decision(), {
        speak: ({ commitmentId }) => {
          seenAtCall = commitmentId;
        },
      });

      assert.notEqual(outcome, null);
      assert.equal(seenAtCall, outcome?.commitmentId);
      const stored = commitments.open();
      assert.equal(stored.length, 1);
      // The commitment is "proposed" after being handed to Voice. Voice events
      // will drive it to "spoken" when actually playing.
      assert.equal(stored[0]?.status, "proposed");
      assert.equal(stored[0]?.utterance, "好，我去挖铁矿。");
    } finally {
      close();
    }
  });

  test("without voice nothing is reserved and nothing is spoken", () => {
    const { show, commitments, close } = harness();
    try {
      assert.equal(speakDecision(show, decision(), null), null);
      assert.equal(commitments.open().length, 0);
    } finally {
      close();
    }
  });

  test("a queued model response can speak without becoming executable", () => {
    const { show, commitments, close } = harness();
    try {
      const outcome = speakDecision(
        show,
        decision({ decision: "QUEUE", priority: "plan", speech: "大家等一下哦。" }),
        { speak: () => undefined },
      );
      assert.notEqual(outcome, null);
      assert.equal(commitments.open()[0]?.utterance, "大家等一下哦。");
    } finally {
      close();
    }
  });

  test("an operator takeover silences the agent but keeps the decision", () => {
    const { show, commitments, close } = harness();
    try {
      show.applyOperator({ kind: "takeover", text: "" });
      assert.equal(speakDecision(show, decision(), { speak: () => assert.fail("must not speak") }), null);
      assert.equal(commitments.open().length, 0);
    } finally {
      close();
    }
  });

  test("the ledger rows survive a fresh Show built on the same database", () => {
    const file = join(mkdtempSync(join(tmpdir(), "craftmate-speech-")), "show.db");
    const first = openDatabase({ file });
    const context = new SessionStore(first).bootstrap(dafeiyu, "盖房");
    const store = new CommitmentStore(first, context);
    const ledger = new CommitmentLedger({ journal: store });
    const show = new Show({ persona: dafeiyu, ledger });
    const outcome = speakDecision(show, decision(), { speak: () => undefined });
    assert.notEqual(outcome, null);
    first.close();

    const second = openDatabase({ file, skipMigrations: true });
    try {
      const restored = new CommitmentStore(second, context);
      // After restart, the commitment is still "proposed" because Voice hasn't
      // reported back yet. Only Voice events move it to "spoken".
      assert.equal(restored.open()[0]?.status, "proposed");
      const rebuilt = new CommitmentLedger({ journal: restored });
      rebuilt.restore(restored.open());
      assert.equal(rebuilt.open().length, 1);
    } finally {
      second.close();
    }
  });
});
