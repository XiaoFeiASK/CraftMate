import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { routeBlacklistCovers, type RouteBlacklist } from "./navigation.ts";

function entry(overrides: Partial<RouteBlacklist> = {}): RouteBlacklist {
  return {
    id: "entry-1",
    sessionId: "session-1",
    dimension: "minecraft:overworld",
    kind: "point",
    x: 10,
    y: 70,
    z: 0,
    radius: 2,
    targetRef: null,
    reasonCode: "E_UNREACHABLE",
    reasonDetail: null,
    source: "agent",
    expiresAt: 10_000,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("route blacklist geometry", () => {
  test("a point covers its radius and a four-block vertical band", () => {
    assert.equal(routeBlacklistCovers(entry(), { x: 11, y: 74, z: 0 }, 1_000), true);
    assert.equal(routeBlacklistCovers(entry(), { x: 11, y: 75, z: 0 }, 1_000), false);
    assert.equal(routeBlacklistCovers(entry(), { x: 13, y: 70, z: 0 }, 1_000), false);
  });

  test("regions are horizontal areas and expired rows are inactive", () => {
    assert.equal(
      routeBlacklistCovers(entry({ kind: "region", radius: 12 }), { x: 15, y: 90, z: 0 }, 1_000),
      true,
    );
    assert.equal(
      routeBlacklistCovers(entry({ expiresAt: 500 }), { x: 10, y: 70, z: 0 }, 1_000),
      false,
    );
    assert.equal(
      routeBlacklistCovers(entry({ expiresAt: null }), { x: 10, y: 70, z: 0 }, 1_000),
      true,
    );
  });
});
