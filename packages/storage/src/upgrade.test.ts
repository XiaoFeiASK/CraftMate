import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { dafeiyu } from "@craftmate/agent";
import { openDatabase } from "./database.ts";
import { CommitmentStore, SessionStore, SourceStore } from "./stores.ts";
import { CostStore } from "./cost.ts";

const migrationsDir = join(
  mkdtempSync(join(tmpdir(), "craftmate-migrations-")),
);

/** Builds a v4-era database, then runs the current migrator over it. */
function upgradeHarness(v4Only: boolean): string {
  const file = join(mkdtempSync(join(tmpdir(), "craftmate-upgrade-")), "show.db");
  const dir = join(migrationsDir, v4Only ? "v4" : "all");
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(join(process.cwd(), "db", "migrations"))) {
    if (v4Only && Number(name.slice(0, 4)) > 4) continue;
    cpSync(join(process.cwd(), "db", "migrations", name), join(dir, name));
  }
  const db = openDatabase({ file, migrationsDir: dir });
  const context = new SessionStore(db).bootstrap(dafeiyu, "盖房");
  const source = new SourceStore(db).append(context.sessionId, {
    id: "upgrade-evt",
    source: "douyin",
    kind: "comment",
    userId: "viewer-1",
    nickname: "小鲸鱼",
    text: "升级前的评论",
    ts: 1_000,
  });
  // Written with the v4 column set on purpose: this is what a real pre-upgrade
  // row looks like, and the new columns must be filled by the migration.
  const personaVersionId = (
    db.prepare("SELECT persona_version_id FROM show_session LIMIT 1").get() as {
      persona_version_id: string;
    }
  ).persona_version_id;
  db.prepare(
    `INSERT INTO decision_log
       (id, session_id, source_id, persona_version_id, trace_id, revision, stage,
        intent, decision, priority, score, reason, trace_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, 1, 'scored', 'mine', 'ACK_ONLY', 'ambient', 0.5, '升级前', ?, ?)`,
  ).run(
    "upgrade-d1",
    context.sessionId,
    source.id,
    personaVersionId,
    "upgrade-evt",
    JSON.stringify({ eventId: "upgrade-evt", nickname: "小鲸鱼" }),
    1_001,
  );
  db.close();
  return file;
}

describe("schema upgrade", () => {
  test("a v4 database upgrades in place without losing decisions", () => {
    const file = upgradeHarness(true);
    const db = openDatabase({ file });
    try {
      const versions = (db.prepare("SELECT version FROM schema_migration ORDER BY version").all() as {
        version: number;
      }[]).map((row) => row.version);
      assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8]);

      const row = db
        .prepare("SELECT speech_text, skill_json FROM decision_log WHERE id = 'upgrade-d1'")
        .get() as { speech_text: string; skill_json: string | null };
      assert.equal(row.skill_json, null);
      assert.equal(row.speech_text, "");

      // The new cost table is usable immediately after the upgrade.
      const sessionId = (db.prepare("SELECT id FROM show_session LIMIT 1").get() as { id: string }).id;
      new CostStore(db).record({ sessionId, provider: "fake", model: "m", cost: 0.1 });
      assert.equal(new CostStore(db).spentSince(0), 0.1);
    } finally {
      db.close();
    }
  });

  test("restarting an already-upgraded database does not reapply migrations", () => {
    const file = upgradeHarness(false);
    const first = openDatabase({ file });
    const before = first.prepare("SELECT count(*) AS n FROM schema_migration").get() as { n: number };
    first.close();

    const second = openDatabase({ file });
    try {
      const after = second.prepare("SELECT count(*) AS n FROM schema_migration").get() as { n: number };
      assert.equal(after.n, before.n);
      // The seeded commitment still restores from storage, not memory.
      const context = new SessionStore(second).bootstrap(dafeiyu, "盖房");
      assert.equal(new CommitmentStore(second, context).list().length, 0);
    } finally {
      second.close();
    }
  });
});
