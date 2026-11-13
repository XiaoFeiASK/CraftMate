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

  test("playbook provenance survives a restart", () => {
    const file = join(mkdtempSync(join(tmpdir(), "craftmate-telemetry-")), "show.db");
    const first = openDatabase({ file });
    const context = new SessionStore(first).bootstrap(dafeiyu, "盖房");
    new AgentEventStore(first, context).append(
      event({
        id: "evt-playbook",
        stage: "task_settled",
        playbookId: "mine.ore",
        cardStatus: "available",
        switchReason: "看到铁矿",
        failureCode: "E_PATH",
        recoveryId: "mine.surface",
        modelChoice: true,
        fallbackReason: null,
        routeMode: "recover",
        blockedReason: "normal walk was enclosed",
        blacklistId: "blacklist-1",
        targetLock: {
          kind: "explore",
          ref: "explore:iron:iron_ore",
          dimension: "minecraft:overworld",
          x: 12,
          y: 64,
          z: 8,
          cardId: "mine.ore",
          lockedAt: 1_000,
          expiresAt: 31_000,
        },
        source: "goal",
      }),
    );
    first.close();

    const second = openDatabase({ file });
    const restored = new AgentEventStore(second, context).recent(1)[0];
    assert.equal(restored?.playbookId, "mine.ore");
    assert.equal(restored?.cardStatus, "available");
    assert.equal(restored?.switchReason, "看到铁矿");
    assert.equal(restored?.failureCode, "E_PATH");
    assert.equal(restored?.recoveryId, "mine.surface");
    assert.equal(restored?.modelChoice, true);
    assert.equal(restored?.fallbackReason, null);
    assert.equal(restored?.routeMode, "recover");
    assert.equal(restored?.blockedReason, "normal walk was enclosed");
    assert.equal(restored?.blacklistId, "blacklist-1");
    assert.equal(restored?.targetLock?.ref, "explore:iron:iron_ore");
    second.close();
  });
});

