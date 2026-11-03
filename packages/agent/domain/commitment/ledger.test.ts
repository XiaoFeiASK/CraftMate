import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CommitmentLedger } from "./ledger.ts";

const createLedger = (): CommitmentLedger =>
  new CommitmentLedger({ now: () => 1_000, newId: () => "commitment-1" });

describe("commitment ledger", () => {
  test("a promise is open from the moment it is reserved", () => {
    const ledger = createLedger();
    const commitment = ledger.reserve({ audienceRef: "viewer-1", utterance: "等我挖完就来" });
    assert.equal(commitment.status, "proposed");
    assert.equal(ledger.open().length, 1);
  });

  test("happy path reaches fulfilled", () => {
    const ledger = createLedger();
    const { id } = ledger.reserve({ audienceRef: "viewer-1", utterance: "去挖钻石" });
    ledger.transition(id, "spoken");
    ledger.transition(id, "accepted");
    ledger.transition(id, "in_progress");
    const done = ledger.transition(id, "fulfilled");
    assert.equal(done.status, "fulfilled");
    assert.equal(ledger.open().length, 0);
  });

  test("a promise cannot skip being spoken", () => {
    const ledger = createLedger();
    const { id } = ledger.reserve({ audienceRef: "viewer-1", utterance: "x" });
    assert.throws(() => ledger.transition(id, "fulfilled"), /illegal transition/);
  });

  test("a preempted promise is closed but still explainable", () => {
    const ledger = createLedger();
    const { id } = ledger.reserve({ audienceRef: "viewer-1", utterance: "去挖钻石" });
    ledger.transition(id, "spoken");
    ledger.transition(id, "cancelled");
    const cancelled = ledger.get(id);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.closedAt, 1_000);
  });

  test("storage is written before the in-memory state changes", () => {
    const writes: string[] = [];
    const ledger = new CommitmentLedger({
      now: () => 1_000,
      newId: () => "commitment-1",
      journal: {
        reserve: (commitment) => {
          writes.push(`reserve:${commitment.status}`);
        },
        transit: (change) => {
          writes.push(`transit:${change.from}->${change.to.status}`);
        },
      },
    });

    const { id } = ledger.reserve({ audienceRef: "viewer-ref-1", utterance: "去挖钻石" });
    assert.equal(ledger.get(id)?.status, "proposed");
    ledger.transition(id, "spoken");

    assert.deepEqual(writes, ["reserve:proposed", "transit:proposed->spoken"]);
    assert.equal(ledger.get(id)?.status, "spoken");
  });

  test("a failed journal write leaves the ledger unchanged", () => {
    const ledger = new CommitmentLedger({
      now: () => 1_000,
      newId: () => "commitment-1",
      journal: {
        reserve: () => {},
        transit: () => {
          throw new Error("disk full");
        },
      },
    });
    const { id } = ledger.reserve({ audienceRef: "viewer-ref-1", utterance: "去挖钻石" });

    assert.throws(() => ledger.transition(id, "spoken"), /disk full/);
    assert.equal(ledger.get(id)?.status, "proposed");
    assert.equal(ledger.open().length, 1);
  });
});
