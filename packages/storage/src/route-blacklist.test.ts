import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dafeiyu } from "@craftmate/agent";
import { openDatabase } from "./database.ts";
import { RouteBlacklistStore } from "./route-blacklist.ts";
import { SessionStore } from "./stores.ts";

function stores() {
  const db = openDatabase({ file: ":memory:" });
  const context = new SessionStore(db).bootstrap(dafeiyu, "长期生存");
  return { db, store: new RouteBlacklistStore(db, context) };
}

const draft = {
  dimension: "minecraft:overworld",
  kind: "point" as const,
  x: 12,
  y: 64,
  z: 8,
  radius: 1.5,
  targetRef: "mine.ore",
  reasonCode: "E_UNREACHABLE",
  reasonDetail: "no safe route",
  source: "agent" as const,
};

describe("route blacklist store", () => {
  test("recording the same target updates one row instead of growing", () => {
    const { db, store } = stores();
    const now = Date.now();
    const first = store.record({ ...draft, expiresAt: now + 60_000 }, now);
    const second = store.record(
      {
        ...draft,
        radius: 3,
        reasonCode: "E_ENCLOSED",
        expiresAt: now + 120_000,
      },
      now + 1_000,
    );
    assert.equal(first.id, second.id);
    assert.equal(store.list().length, 1);
    assert.equal(store.get(first.id)?.radius, 3);
    assert.equal(store.get(first.id)?.reasonCode, "E_ENCLOSED");
    db.close();
  });

  test("expired entries are absent from active reads but survive for audit", () => {
    const { db, store } = stores();
    const now = Date.now();
    store.record({ ...draft, expiresAt: now + 1_000 }, now);
    assert.equal(store.active({}, now + 2_000).length, 0);
    assert.equal(store.list(true).length, 1);
    db.close();
  });

  test("a hazard without expiry stays blocked until the operator removes it", () => {
    const { db, store } = stores();
    const now = Date.now();
    const hazard = store.record(
      {
        ...draft,
        kind: "hazard",
        radius: 8,
        reasonCode: "E_HAZARD",
        expiresAt: null,
      },
      now,
    );
    assert.equal(
      store.active({ position: { x: 12, y: 64, z: 8 } }, now + 86_400_000).length,
      1,
    );
    assert.equal(store.forget(hazard.id), true);
    assert.equal(store.list().length, 0);
    assert.equal(store.forget(hazard.id), false);
    db.close();
  });

  test("query filters use dimension and the covered point", () => {
    const { db, store } = stores();
    const now = Date.now();
    store.record({ ...draft, expiresAt: now + 60_000 }, now);
    assert.equal(
      store.active({
        dimension: "minecraft:overworld",
        position: { x: 12.5, y: 64, z: 8.5 },
        limit: 8,
      }).length,
      1,
    );
    assert.equal(
      store.active({
        dimension: "minecraft:the_nether",
        position: { x: 12.5, y: 64, z: 8.5 },
        limit: 8,
      }).length,
      0,
    );
    assert.equal(
      store.active({
        dimension: "minecraft:overworld",
        position: { x: 20, y: 64, z: 20 },
        limit: 8,
      }).length,
      0,
    );
    db.close();
  });

  test("an active read without a point returns distant target refusals", () => {
    const { db, store } = stores();
    const now = Date.now();
    store.record({ ...draft, expiresAt: now + 60_000 }, now);
    const active = store.active(
      { dimension: "minecraft:overworld", limit: 256 },
      now,
    );
    assert.equal(active.length, 1);
    assert.equal(active[0]?.x, draft.x);
    assert.equal(active[0]?.z, draft.z);
    db.close();
  });
});
