import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CommitmentLedger, Show, dafeiyu } from "@craftmate/agent";
import { loadMigrations, openDatabase } from "./database.ts";
import { SqliteRecorder } from "./recorder.ts";
import {
  CommitmentStore,
  DecisionStore,
  SessionStore,
  SettingsStore,
  SourceStore,
  WorldEventStore,
} from "./stores.ts";
import { defaultSettings } from "@craftmate/agent/application";

const temporaryDatabase = (): string => join(mkdtempSync(join(tmpdir(), "craftmate-test-")), "show.db");
const migrationsDir = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), "db", "migrations");

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

  test("the database still rejects a duplicate after the memory fast path expires", () => {
    const db = openDatabase({ file: temporaryDatabase() });
    const context = new SessionStore(db).bootstrap(dafeiyu, "盖房");
    const show = new Show({
      persona: dafeiyu,
      recorder: new SqliteRecorder(db, context),
      seenLimit: 1,
    });

    assert.notEqual(show.ingest(comment("first", "去挖点铁矿")), null);
    assert.notEqual(show.ingest(comment("second", "盖个房子")), null);
    assert.equal(show.ingest(comment("first", "去挖点铁矿")), null);
    assert.equal((db.prepare("SELECT count(*) AS n FROM source").get() as { n: number }).n, 2);
    assert.equal((db.prepare("SELECT count(*) AS n FROM decision_log").get() as { n: number }).n, 2);
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
    // A build request is actionable, so it survives as an EXECUTE decision.
    assert.equal(history[0]?.decision, "EXECUTE");
    assert.equal(history[0]?.priority, "command");
    second.close();
  });

  test("world events keep their order across a restart and sequence per session", () => {
    const file = temporaryDatabase();
    const first = openDatabase({ file });
    const context = new SessionStore(first).bootstrap(dafeiyu, "盖房");
    const store = new WorldEventStore(first);
    store.append(context.sessionId, {
      name: "reflex",
      tick: 10,
      data: { kind: "lava", detail: "岩浆就在脚边", health: 8 },
      at: 1_000,
    });
    store.append(context.sessionId, {
      name: "reflex",
      tick: 11,
      data: { kind: "low_health", detail: "血量只剩 3", health: 3 },
      at: 2_000,
    });
    first.close();

    const second = openDatabase({ file });
    const reopened = new WorldEventStore(second);
    reopened.append(context.sessionId, {
      name: "reflex",
      tick: 12,
      data: { kind: "falling", detail: "正在坠落", health: 9 },
      at: 3_000,
    });
    const events = reopened.recent(context.sessionId, 10);
    // `recent` returns chronological order so a console can append without
    // reversing the timeline it just rendered.
    assert.deepEqual(events.map((event) => event.seq), [0, 1, 2]);
    assert.deepEqual(events.map((event) => event.name), ["reflex", "reflex", "reflex"]);
    assert.equal((events[2]?.data as { kind: string }).kind, "falling");
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

  test("settings survive a restart and are scoped to the live session", () => {
    const file = temporaryDatabase();
    const first = openDatabase({ file });
    const context = new SessionStore(first).bootstrap(dafeiyu, "盖房");
    const settings = defaultSettings(dafeiyu);
    new SettingsStore(first).write(context.sessionId, {
      ...settings,
      goal: "挖一组钻石",
      goalProgress: 64,
      autonomy: { enabled: true },
      persona: { ...settings.persona, name: "大肥鱼二号" },
    });
    first.close();

    const second = openDatabase({ file });
    const stored = new SettingsStore(second).read(context.sessionId) as {
      goal: string;
      goalProgress: number;
      autonomy: { enabled: boolean };
      persona: { name: string };
    };
    assert.equal(stored.goal, "挖一组钻石");
    assert.equal(stored.goalProgress, 64);
    assert.equal(stored.autonomy.enabled, true);
    assert.equal(stored.persona.name, "大肥鱼二号");
    second.close();
  });

  test("a spoken commitment survives a restart in the open view", () => {
    const file = temporaryDatabase();
    const first = openDatabase({ file });
    const context = new SessionStore(first).bootstrap(dafeiyu, "盖房");
    const store = new CommitmentStore(first, context);
    const ledger = new CommitmentLedger({
      journal: store,
      now: () => 5_000,
      newId: () => "commitment-1",
    });
    const commitment = ledger.reserve({
      audienceRef: "viewer-ref-1",
      utterance: "等我挖完铁矿就来",
      deadlineAt: 20_000,
    });
    ledger.transition(commitment.id, "spoken", "TTS started");
    first.close();

    const second = openDatabase({ file });
    const restoredStore = new CommitmentStore(second, context);
    const restored = new CommitmentLedger({ journal: restoredStore });
    restored.restore(restoredStore.open());

    assert.equal(restored.open().length, 1);
    assert.equal(restoredStore.openCount(), 1);
    assert.equal(restored.get("commitment-1")?.status, "spoken");
    const events = second
      .prepare("SELECT from_status, to_status FROM commitment_event WHERE commitment_id = ? ORDER BY occurred_at_ms")
      .all("commitment-1") as { from_status: string | null; to_status: string }[];
    assert.equal(events.length, 2);
    assert.equal(events[0]?.from_status, null);
    assert.equal(events[0]?.to_status, "proposed");
    assert.equal(events[1]?.from_status, "proposed");
    assert.equal(events[1]?.to_status, "spoken");
    second.close();
  });

  test("the ledger rejects skipping spoken without writing a transition", () => {
    const db = openDatabase({ file: temporaryDatabase() });
    const context = new SessionStore(db).bootstrap(dafeiyu, "盖房");
    const store = new CommitmentStore(db, context);
    const ledger = new CommitmentLedger({ journal: store, newId: () => "commitment-1" });
    const commitment = ledger.reserve({ audienceRef: "viewer-ref-1", utterance: "去挖钻石" });

    assert.throws(() => ledger.transition(commitment.id, "fulfilled"), /illegal transition/);
    assert.equal(store.list()[0]?.status, "proposed");
    const eventCount = db
      .prepare("SELECT count(*) AS n FROM commitment_event WHERE commitment_id = ?")
      .get("commitment-1") as { n: number };
    assert.equal(eventCount.n, 1);
    db.close();
  });

  test("a retried reserve does not duplicate the commitment or its event", () => {
    const db = openDatabase({ file: temporaryDatabase() });
    const context = new SessionStore(db).bootstrap(dafeiyu, "盖房");
    const store = new CommitmentStore(db, context);
    const commitment = {
      id: "commitment-1",
      audienceRef: "viewer-ref-1",
      sourceId: null,
      utterance: "去挖钻石",
      status: "proposed" as const,
      revision: 1,
      createdAt: 5_000,
      deadlineAt: null,
      planId: null,
      spokenAt: null,
      closedAt: null,
    };

    store.reserve(commitment);
    store.reserve(commitment);
    assert.equal(store.list().length, 1);
    assert.equal(
      (db.prepare("SELECT count(*) AS n FROM commitment_event").get() as { n: number }).n,
      1,
    );
    db.close();
  });

  test("expiring raw text keeps the hash and writes one audit row", () => {
    const db = openDatabase({ file: temporaryDatabase() });
    const context = new SessionStore(db).bootstrap(dafeiyu, "盖房");
    const sources = new SourceStore(db);
    const event = comment("expire-me", "这是一条会被清理的评论");
    const { id } = sources.append(context.sessionId, event);

    assert.equal(sources.expireRawText(Date.now() + 25 * 60 * 60 * 1000), 1);
    assert.equal(sources.expireRawText(Date.now() + 26 * 60 * 60 * 1000), 0);

    const row = db
      .prepare("SELECT raw_text, content_hash FROM source WHERE id = ?")
      .get(id) as { raw_text: string | null; content_hash: string };
    assert.equal(row.raw_text, null);
    assert.notEqual(row.content_hash, "");

    const audits = db
      .prepare("SELECT source_id, action, content_hash FROM source_retention_audit")
      .all() as { source_id: string; action: string; content_hash: string }[];
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.source_id, id);
    assert.equal(audits[0]?.action, "raw_text_expired");
    assert.equal(audits[0]?.content_hash, row.content_hash);
    db.close();
  });

  test("a non-positive retention batch size is rejected before any write", () => {
    const db = openDatabase({ file: temporaryDatabase() });
    const sources = new SourceStore(db);
    assert.throws(() => sources.expireRawText(Date.now(), 0), /positive integer/);
    db.close();
  });

  test("opening an up-to-date database applies no migrations twice", () => {
    const file = temporaryDatabase();
    openDatabase({ file }).close();
    const db = openDatabase({ file });
    const migrations = loadMigrations(migrationsDir);
    assert.equal(
      (db.prepare("SELECT count(*) AS n FROM schema_migration").get() as { n: number }).n,
      migrations.length,
    );
    db.close();
  });

  test("an old database upgrades by applying only the missing migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "craftmate-migrations-"));
    const sourceDir = migrationsDir;
    const all = readdirSync(sourceDir).filter((file) => file.endsWith(".sql")).sort();
    for (const name of all.slice(0, -1)) {
      copyFileSync(join(sourceDir, name), join(dir, name));
    }

    const file = temporaryDatabase();
    openDatabase({ file, migrationsDir: dir }).close();
    const db = openDatabase({ file });
    assert.equal(
      (db.prepare("SELECT count(*) AS n FROM schema_migration").get() as { n: number }).n,
      all.length,
    );
    assert.ok(
      db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'source_retention_audit'")
        .get(),
    );
    db.close();
  });

  test("a changed migration checksum aborts startup instead of continuing", () => {
    const dir = mkdtempSync(join(tmpdir(), "craftmate-migrations-"));
    const name = "0001_initial.sql";
    copyFileSync(join(migrationsDir, name), join(dir, name));
    const file = temporaryDatabase();
    openDatabase({ file, migrationsDir: dir }).close();

    appendFileSync(join(dir, name), "\n-- drift\n");
    assert.throws(() => openDatabase({ file, migrationsDir: dir }), /changed after being applied/);
  });
});
