import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { ActionStore, openDatabase } from "../../storage/src/index.ts";
import { MemoryActionPort } from "./memory-action-port.ts";
import { SqliteActionPort } from "./sqlite-action-port.ts";

function requireSession(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO persona (id, persona_key, name, created_at_ms) VALUES ('p1', 'p1', '大肥鱼', 1000);
    INSERT INTO persona_version (id, persona_id, revision, content_json, state, created_at_ms)
      VALUES ('v1', 'p1', 1, '{}', 'active', 1000);
    INSERT INTO show_session (id, session_no, persona_version_id, goal_text, status, started_at_ms, created_at_ms)
      VALUES ('s1', 1, 'v1', '盖房', 'live', 1000, 1000);
    INSERT INTO source (id, session_id, kind, content_hash, received_at_ms)
      VALUES ('src1', 's1', 'world', 'hash', 1000);
    INSERT INTO decision_log
      (id, session_id, source_id, persona_version_id, trace_id, revision, stage, intent,
       decision, priority, score, reason, created_at_ms)
      VALUES ('d1', 's1', 'src1', 'v1', 't1', 1, 'planned', 'move', 'EXECUTE', 'command', 0.9, 'ok', 1000);
  `);
}

describe("action port implementations", () => {
  test("memory action port dedupes idempotency keys", () => {
    const port = new MemoryActionPort();
    const command = {
      v: 1 as const,
      type: "cmd" as const,
      id: "c-1",
      op: "goto" as const,
      args: {},
      priority: "command" as const,
      idempotencyKey: "same",
    };
    const first = port.begin(command);
    const second = port.begin({ ...command, id: "c-2" });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.id, second.id);
  });

  test("sqlite action store persists an action attempt and its terminal state", () => {
    const file = join(mkdtempSync(join(tmpdir(), "craftmate-bridge-")), "bridge.db");
    const db = openDatabase({ file });
    try {
      requireSession(db);

      const store = new ActionStore(db);
      const call = {
        name: "goto" as const,
        args: { x: 1, y: 64, z: 2 },
        idempotencyKey: "bridge-key-1",
      };
      const first = store.begin("s1", "d1", call, "command");
      const second = store.begin("s1", "d1", call, "command");
      assert.equal(first.created, true);
      assert.equal(second.created, false);

      store.settle(first.id, "completed");
      const row = db
        .prepare("SELECT status, finished_at_ms FROM action_attempt WHERE id = ?")
        .get(first.id) as { status: string; finished_at_ms: number | null };
      assert.equal(row.status, "completed");
      assert.equal(typeof row.finished_at_ms, "number");
    } finally {
      db.close();
    }
  });

  test("the bridge sqlite adapter reuses the same idempotency key", () => {
    const file = join(mkdtempSync(join(tmpdir(), "craftmate-bridge-port-")), "bridge.db");
    const db = openDatabase({ file });
    try {
      requireSession(db);
      const port = new SqliteActionPort(db, {
        sessionId: "s1",
        decisionId: "d1",
        priority: "command",
      });
      const command = {
        v: 1 as const,
        type: "cmd" as const,
        id: "cmd-1",
        op: "mine_block" as const,
        args: { block: "minecraft:stone" },
        priority: "command" as const,
        idempotencyKey: "port-key-1",
      };
      const first = port.begin(command);
      const second = port.begin({ ...command, id: "cmd-2" });
      assert.equal(first.created, true);
      assert.equal(second.created, false);
      port.settle(first.id, "cancelled", "E_CANCELLED");
      const row = db
        .prepare("SELECT status, error_code FROM action_attempt WHERE id = ?")
        .get(first.id) as { status: string; error_code: string };
      assert.equal(row.status, "cancelled");
      assert.equal(row.error_code, "E_CANCELLED");
    } finally {
      db.close();
    }
  });
});
