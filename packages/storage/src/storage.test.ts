import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Show, dafeiyu } from "@craftmate/agent";
import { openDatabase } from "./database.ts";
import { SqliteRecorder } from "./recorder.ts";
import { DecisionStore, SessionStore } from "./stores.ts";

const temporaryDatabase = (): string => join(mkdtempSync(join(tmpdir(), "craftmate-test-")), "show.db");

const comment = (id: string, text: string) => ({
  id,
  source: "douyin" as const,
  kind: "comment" as const,
  userId: "viewer-1",
  nickname: "小鲸鱼",
  text,
  ts: Date.now(),
});

describe("storage", () => {
  test("a repeated platform event id is recorded once", () => {
    const db = openDatabase({ file: temporaryDatabase() });
    const context = new SessionStore(db).bootstrap(dafeiyu, "盖房");
    const show = new Show({
      persona: dafeiyu,
      recorder: new SqliteRecorder(db, context),
    });

    assert.notEqual(show.ingest(comment("same-id", "去挖点铁矿")), null);
    assert.equal(show.ingest(comment("same-id", "去挖点铁矿")), null);
    assert.equal((db.prepare("SELECT count(*) AS n FROM source").get() as { n: number }).n, 1);
    db.close();
  });

  test("a restart keeps decisions and their original text", () => {
    const file = temporaryDatabase();
    const first = openDatabase({ file });
    const context = new SessionStore(first).bootstrap(dafeiyu, "盖房");
    new Show({ persona: dafeiyu, recorder: new SqliteRecorder(first, context) }).ingest(
      comment("kept", "盖个房子给我看看"),
    );
    first.close();

    const second = openDatabase({ file });
    const history = new DecisionStore(second).recent(context.sessionId, 10);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.text, "盖个房子给我看看");
    assert.equal(history[0]?.priority, "ambient");
    second.close();
  });

  test("bootstrapping twice does not create a second live session", () => {
    const db = openDatabase({ file: temporaryDatabase() });
    const store = new SessionStore(db);
    const first = store.bootstrap(dafeiyu, "盖房");
    const second = store.bootstrap(dafeiyu, "盖房");
    assert.equal(first.sessionId, second.sessionId);
    assert.equal((db.prepare("SELECT count(*) AS n FROM show_session").get() as { n: number }).n, 1);
    db.close();
  });
});
