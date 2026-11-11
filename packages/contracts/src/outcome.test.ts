import assert from "node:assert/strict";
import { test } from "node:test";
import { skillOutcomeSchema } from "./outcome.ts";

test("a segmented task can report partial progress and a safe continuation", () => {
  const parsed = skillOutcomeSchema.parse({
    summary: "挖到一半，背包满了",
    progress: { done: 12, total: 32, unit: "block" },
    remaining: "还差 20 个铁矿石",
    resumable: true,
    nextHint: "先清空背包，再从原来的矿道继续",
  });

  assert.equal(parsed.progress?.done, 12);
  assert.equal(parsed.progress?.total, 32);
  assert.equal(parsed.remaining, "还差 20 个铁矿石");
  assert.equal(parsed.resumable, true);
});

test("negative progress is rejected instead of becoming a fake percentage", () => {
  assert.equal(
    skillOutcomeSchema.safeParse({ progress: { done: -1 } }).success,
    false,
  );
});
