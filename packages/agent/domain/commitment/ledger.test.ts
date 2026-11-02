import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CommitmentLedger } from "./ledger.ts";

const createLedger = (): CommitmentLedger =>
  new CommitmentLedger({ now: () => 1_000, newId: () => "commitment-1" });

describe("commitment ledger", () => {
  test("a promise is open from the moment it is reserved", () => {
    const ledger = createLedger();
    const commitment = ledger.reserve({ utterance: "等我挖完就来" });
    assert.equal(commitment.status, "proposed");
    assert.equal(ledger.open().length, 1);
  });

  test("happy path reaches fulfilled", () => {
    const ledger = createLedger();
    const { id } = ledger.reserve({ utterance: "去挖钻石" });
    ledger.transition(id, "spoken");
    ledger.transition(id, "accepted");
    ledger.transition(id, "in_progress");
    const done = ledger.transition(id, "fulfilled");
    assert.equal(done.status, "fulfilled");
    assert.equal(ledger.open().length, 0);
  });

  test("a promise cannot skip being spoken", () => {
    const ledger = createLedger();
    const { id } = ledger.reserve({ utterance: "x" });
    assert.throws(() => ledger.transition(id, "fulfilled"), /illegal transition/);
  });

  test("a preempted promise is closed but still explainable", () => {
    const ledger = createLedger();
    const { id } = ledger.reserve({ utterance: "去挖钻石" });
    ledger.transition(id, "spoken");
    ledger.transition(id, "cancelled");
    const cancelled = ledger.get(id);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.closedAt, 1_000);
  });
});
