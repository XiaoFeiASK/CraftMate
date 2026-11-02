import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migrations = join(root, "db", "migrations");

/**
 * Defaults to an in-memory database. Pass a `.db` path to validate a real
 * file database, which is the only mode where WAL and locking are real.
 * Pass a directory to get a throwaway file database inside it, removed on exit.
 */
const argument = process.argv[2];
let target = ":memory:";
let disposable = false;
if (argument) {
  if (existsSync(argument) && statSync(argument).isDirectory()) {
    target = join(argument, `schema-check-${process.pid}-${Date.now()}.db`);
    disposable = true;
  } else {
    target = argument;
  }
}
const db = new DatabaseSync(target);

function fail(message) {
  console.error(`schema check failed: ${message}`);
  process.exit(1);
}

function expectThrow(sql, params, label) {
  try {
    db.prepare(sql).run(...params);
  } catch {
    return;
  }
  fail(`${label} should have been rejected`);
}

db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

if (target !== ":memory:") {
  // WAL is the runtime mode; a rollback-journal file database would hide
  // locking and reader/writer behaviour that the orchestrator depends on.
  db.exec("PRAGMA journal_mode = WAL");
  const mode = db.prepare("PRAGMA journal_mode").get().journal_mode;
  if (mode !== "wal") fail(`expected WAL journal mode on ${target}, got ${mode}`);
  if (db.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1) {
    fail("foreign_keys did not stay enabled on the file database");
  }
}

const existing = db
  .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
  .get().n;
if (existing > 0) {
  // Applying 0001 again would fail halfway with a raw SQLite error. Until the
  // real migration runner lands in M1.1, a check must start from an empty target.
  fail(`${target} is not empty; point the check at a fresh path`);
}

for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
  try {
    db.exec(readFileSync(join(migrations, file), "utf8"));
  } catch (error) {
    fail(`${file}: ${error.message}`);
  }
}

const tables = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((row) => row.name),
);
for (const required of [
  "schema_migration",
  "persona_version",
  "show_session",
  "source",
  "decision_log",
  "action_attempt",
  "world_event",
  "commitment",
  "commitment_event",
  "memory",
  "memory_evidence",
  "memory_fts",
  "review_candidate",
  "incident",
  "decision_current",
  "commitment_open",
  "memory_active",
]) {
  if (!tables.has(required)) fail(`missing ${required}`);
}

db.prepare(
  "INSERT INTO persona (id, persona_key, name, created_at_ms) VALUES (?, ?, ?, ?)",
).run("persona-1", "dafeiyu", "大肥鱼", 1_000);
db.prepare(
  "INSERT INTO persona_version (id, persona_id, revision, content_json, state, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
).run("persona-1-v1", "persona-1", 1, '{"name":"大肥鱼"}', "active", 1_000);
db.prepare(
  "INSERT INTO show_session (id, session_no, persona_version_id, goal_text, status, started_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
).run("session-1", 1, "persona-1-v1", "盖海崖小屋", "live", 2_000, 2_000);
db.prepare(
  "INSERT INTO source (id, external_event_id, session_id, kind, actor_ref, raw_text, content_hash, received_at_ms, raw_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
).run(
  "source-1",
  "douyin-comment-1",
  "session-1",
  "comment",
  "viewer-1",
  "去挖点铁矿",
  "hash-1",
  3_000,
  86_403_000,
);
expectThrow(
  "INSERT INTO source (id, external_event_id, session_id, kind, actor_ref, raw_text, content_hash, received_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ["source-dup", "douyin-comment-1", "session-1", "comment", "viewer-1", "重复事件", "hash-duplicate", 3_100],
  "duplicate platform event",
);
// Redelivery of the same platform id in another session is a different source row.
db.prepare(
  "INSERT INTO show_session (id, session_no, persona_version_id, goal_text, status, started_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
).run("session-2", 2, "persona-1-v1", "修屋顶", "live", 3_050, 3_050);
db.prepare(
  "INSERT INTO source (id, external_event_id, session_id, kind, actor_ref, raw_text, content_hash, received_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
).run("source-other-session", "douyin-comment-1", "session-2", "comment", "viewer-1", "同一条事件", "hash-x", 3_100);
db.prepare(
  "INSERT INTO source (id, session_id, kind, actor_ref, raw_text, content_hash, received_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
).run("source-operator-1", "session-1", "operator", "operator-1", "先别挖了", "hash-2", 3_200);
db.prepare(
  "INSERT INTO source (id, session_id, kind, actor_ref, raw_text, content_hash, received_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
).run("source-operator-2", "session-1", "operator", "operator-1", "继续", "hash-3", 3_300);
expectThrow(
  "INSERT INTO source (id, session_id, kind, actor_ref, raw_text, content_hash, received_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ["source-bad-kind", "session-1", "telepathy", null, "x", "hash-4", 3_400],
  "unknown source kind",
);

expectThrow(
  "INSERT INTO commitment (id, session_id, persona_version_id, audience_ref, utterance, status, revision, created_at_ms, closed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ["commitment-early-close", "session-1", "persona-1-v1", "viewer-1", "x", "fulfilled", 1, 9_000, 8_000],
  "commitment closed before creation",
);
expectThrow(
  "INSERT INTO show_session (id, session_no, persona_version_id, goal_text, status, started_at_ms, ended_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ["session-bad", 3, "persona-1-v1", "x", "ended", 5_000, 4_000, 5_000],
  "session ended before it started",
);

for (const [id, revision, reason] of [
  ["decision-1", 1, "初次识别"],
  ["decision-2", 2, "补充上下文后重判"],
]) {
  db.prepare(
    `INSERT INTO decision_log
      (id, session_id, source_id, persona_version_id, trace_id, revision, stage, intent,
       decision, priority, score, reason, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "session-1",
    "source-1",
    "persona-1-v1",
    "trace-1",
    revision,
    "scored",
    "mine",
    "ACK_ONLY",
    "command",
    0.61,
    reason,
    4_000 + revision,
  );
}

const currentDecision = db.prepare("SELECT id FROM decision_current").get();
if (currentDecision?.id !== "decision-2") fail("decision_current did not pick the latest revision");

db.prepare(
  `INSERT INTO commitment
    (id, session_id, source_id, persona_version_id, audience_ref, utterance, status,
     revision, deadline_at_ms, created_at_ms, spoken_at_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run("commitment-1", "session-1", "source-1", "persona-1-v1", "viewer-1", "等我挖完就来", "spoken", 2, 20_000, 5_000, 6_000);
db.prepare(
  "INSERT INTO commitment_event (id, commitment_id, from_status, to_status, reason, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
).run("commitment-event-1", "commitment-1", null, "proposed", "reserve before speak", 5_000);
db.prepare(
  "INSERT INTO commitment_event (id, commitment_id, from_status, to_status, reason, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
).run("commitment-event-2", "commitment-1", "proposed", "spoken", "TTS started", 6_000);

expectThrow(
  "UPDATE commitment SET status = 'fulfilled' WHERE id = ?",
  ["commitment-1"],
  "terminal commitment without closed_at_ms",
);
expectThrow(
  "INSERT INTO commitment (id, session_id, source_id, persona_version_id, audience_ref, utterance, status, revision, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ["commitment-bad", "session-1", "source-missing", "persona-1-v1", "viewer-1", "x", "proposed", 1, 7_000],
  "foreign-key violation",
);

db.prepare(
  "INSERT INTO memory (id, lineage_id, session_id, persona_version_id, subject_ref, family, content, disclosure, confidence, state, revision, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
).run("memory-1", "lineage-1", "session-1", "persona-1-v1", "viewer-1", "viewer", "喜欢挖铁矿", "full", 0.8, "active", 1, 8_000);
db.prepare(
  "INSERT INTO memory_evidence (memory_id, source_id) VALUES (?, ?)",
).run("memory-1", "source-1");
const ftsHit = db.prepare("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?").get("挖铁矿");
if (ftsHit?.memory_id !== "memory-1") fail("FTS trigram search did not find the memory");

db.prepare(
  "INSERT INTO memory (id, lineage_id, session_id, persona_version_id, subject_ref, family, content, disclosure, confidence, state, revision, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
).run("memory-2", "lineage-2", "session-1", "persona-1-v1", "viewer-2", "viewer", "说好挖铁矿但没去", "hint", 0.4, "forgotten", 1, 8_500);
// FTS holds every revision; recall must narrow to memory_active.
const ftsMatches = db.prepare("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY memory_id").all("挖铁矿");
if (ftsMatches.length !== 2) fail("FTS should index all memory revisions");
const activeMatches = db
  .prepare(
    `SELECT m.id FROM memory_fts f
     JOIN memory_active m ON m.id = f.memory_id
     WHERE memory_fts MATCH ?
     ORDER BY m.id`,
  )
  .all("挖铁矿");
if (activeMatches.length !== 1 || activeMatches[0].id !== "memory-1") {
  fail("memory_active join should exclude forgotten memories");
}

db.prepare(
  "INSERT INTO action_attempt (id, session_id, decision_id, skill, priority, status, idempotency_key, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
).run("action-1", "session-1", "decision-2", "mine_block", "command", "queued", "source-1-v2", 9_000);
expectThrow(
  "UPDATE action_attempt SET status = 'completed' WHERE id = ?",
  ["action-1"],
  "terminal action without finished_at_ms",
);
db.prepare(
  "INSERT INTO world_event (id, session_id, seq, tick, name, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
).run("world-1", "session-1", 0, 120, "block_broken", 10_000);
db.prepare(
  "INSERT INTO review_candidate (id, session_id, kind, payload_json, status, expected_version, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
).run("review-1", "session-1", "skill", '{"skill":"mine_block"}', "pending", 0, 11_000);
db.prepare(
  "INSERT INTO incident (id, session_id, severity, code, created_at_ms) VALUES (?, ?, ?, ?, ?)",
).run("incident-1", "session-1", "warn", "E_TIMEOUT", 12_000);

expectThrow(
  "INSERT INTO memory (id, lineage_id, subject_ref, family, content, disclosure, confidence, state, revision, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ["memory-bad", "lineage-bad", "viewer-1", "viewer", "x", "full", 0.5, "unknown", 1, 13_000],
  "invalid memory state",
);

const objectCount = db
  .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table', 'view')")
  .get().n;
const indexCount = db
  .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
  .get().n;

// Migrations are applied in filename order, so the naming rule is load-bearing.
const migrationFiles = readdirSync(migrations).filter((name) => name.endsWith(".sql"));
const strayFiles = readdirSync(migrations).filter((name) => !name.endsWith(".sql"));
if (strayFiles.length > 0) fail(`non-migration files in db/migrations: ${strayFiles.join(", ")}`);
for (const [index, name] of migrationFiles.entries()) {
  if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) fail(`bad migration name: ${name}`);
  if (Number(name.slice(0, 4)) !== index + 1) fail(`migration sequence gap at: ${name}`);
}

const mode = db.prepare("PRAGMA journal_mode").get().journal_mode;
console.log(
  `schema ok: ${objectCount} objects, ${indexCount} indexes, journal=${mode}, ` +
    "constraints, views, and FTS verified",
);
db.close();

if (disposable) {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${target}${suffix}`, { force: true });
  }
}
