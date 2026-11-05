import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { dafeiyu } from "@craftmate/agent";
import type { AgentEvent } from "@craftmate/contracts";
import { openDatabase } from "./database.ts";
import { SessionStore } from "./stores.ts";
import { AgentEventStore } from "./telemetry.ts";

const event = (overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  id: "evt-1",
  at: 1_000,
  stage: "arbitrated",
  status: "ok",
  traceId: "comment-1",
  taskId: null,
  decisionId: "decision-1",
  goalId: null,
  durationMs: null,
  summary: "仲裁：执行 · 目标一致",
  errorCode: null,
  source: "agent",
  ...overrides,
});

describe("agent telemetry storage", () => {
  test("events survive a restart and keep their trace join keys", () => {
    const file = join(mkdtempSync(join(tmpdir(), "craftmate-telemetry-")), "show.db");
    const first = openDatabase({ file });
    const context = new SessionStore(first).bootstrap(dafeiyu, "盖房");
    const store = new AgentEventStore(first, context);
    store.append(event());
    store.append(
      event({
        id: "evt-2",
        at: 2_000,
        stage: "planned",
        decisionId: "decision-1",
        taskId: "task-1",
        durationMs: 240,
        source: "agent",
      }),
    );
    first.close();

    const second = openDatabase({ file });
    const reopened = new AgentEventStore(second, context);
    const recent = reopened.recent(10);
    assert.deepEqual(recent.map((item) => item.id), ["evt-2", "evt-1"]);
    assert.equal(recent[0]?.durationMs, 240);

    const trace = reopened.trace("comment-1");
    assert.deepEqual(trace.map((item) => item.stage), ["arbitrated", "planned"]);
    assert.equal(reopened.count(), 2);
    second.close();
  });

  test("a duplicate id is ignored instead of duplicating a live event", () => {
    const db = openDatabase({ file: join(mkdtempSync(join(tmpdir(), "craftmate-telemetry-")), "show.db") });
    const context = new SessionStore(db).bootstrap(dafeiyu, "盖房");
    const store = new AgentEventStore(db, context);
    store.append(event());
    store.append(event());
    assert.equal(store.recent(10).length, 1);
    db.close();
  });
});

