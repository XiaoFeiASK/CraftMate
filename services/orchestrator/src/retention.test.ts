import assert from "node:assert/strict";
import { test } from "node:test";
import { createRetentionSweep } from "./retention.ts";

test("the sweep uses the injected clock and can be stopped", () => {
  let now = 12_000;
  const seen: number[] = [];
  const sweep = createRetentionSweep({
    expire: (at) => {
      seen.push(at);
      return 1;
    },
    clock: { now: () => now, newId: () => "id" },
  });

  sweep.start();
  sweep.stop();
  now = 13_000;

  assert.deepEqual(seen, [12_000]);
  assert.equal(sweep.runOnce(), 1);
  assert.deepEqual(seen, [12_000, 13_000]);
});

test("a failing sweep is reported and does not crash the caller", () => {
  const errors: unknown[] = [];
  const sweep = createRetentionSweep({
    expire: () => {
      throw new Error("disk full");
    },
    onError: (error) => errors.push(error),
  });

  assert.equal(sweep.runOnce(), 0);
  assert.equal(errors.length, 1);
});
