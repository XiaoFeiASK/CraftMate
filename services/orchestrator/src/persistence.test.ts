import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPersistentShow } from "./persistence.ts";

const temporaryDatabase = (): string =>
  join(mkdtempSync(join(tmpdir(), "craftmate-persistence-")), "show.db");

test("an open commitment survives an orchestrator restart", () => {
  const dbPath = temporaryDatabase();
  const first = createPersistentShow({ dbPath });
  const commitment = first.show.ledger.reserve({
    audienceRef: "viewer-ref-1",
    utterance: "等我挖完铁矿就来",
  });
  first.show.ledger.transition(commitment.id, "spoken", "TTS started");
  assert.equal(first.show.snapshot().stats.openCommitments, 1);
  first.close();

  const second = createPersistentShow({ dbPath });
  try {
    assert.equal(second.show.snapshot().stats.openCommitments, 1);
    assert.equal(second.show.ledger.open()[0]?.status, "spoken");
  } finally {
    second.close();
  }
});

test("the bootstrap retention sweep purges raw text but keeps the decision", () => {
  const dbPath = temporaryDatabase();
  const first = createPersistentShow({ dbPath });
  const event = {
    id: "comment-1",
    source: "douyin" as const,
    kind: "comment" as const,
    userId: "viewer-1",
    nickname: "小鲸鱼",
    text: "去挖点铁矿",
    ts: Date.now(),
  };
  assert.notEqual(first.show.ingest(event), null);
  assert.equal(first.expireRawText(Date.now() + 25 * 60 * 60 * 1000), 1);
  first.close();

  const second = createPersistentShow({ dbPath });
  try {
    const row = second.show.recent()[0];
    assert.equal(row?.text, "");
    assert.notEqual(row?.intent, undefined);
  } finally {
    second.close();
  }
});
