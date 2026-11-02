import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { reconnectDelay } from "./connection.ts";

describe("reconnect delay", () => {
  test("backs off exponentially and stops at the cap", () => {
    assert.equal(reconnectDelay(0), 1_000);
    assert.equal(reconnectDelay(1), 2_000);
    assert.equal(reconnectDelay(4), 15_000);
    assert.equal(reconnectDelay(40), 15_000);
  });
});
