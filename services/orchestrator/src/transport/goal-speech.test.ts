import assert from "node:assert/strict";
import { test } from "node:test";
import type { Decision } from "@craftmate/contracts";
import { GoalSpeechGate } from "./goal-speech.ts";

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "goal-decision",
    eventId: "goal:decision",
    nickname: "目标运行时",
    text: "补充木材",
    intent: "mine",
    decision: "EXECUTE",
    priority: "plan",
    reason: "AI 自主决策",
    score: 1,
    stage: "planned",
    skill: {
      name: "chop_tree",
      args: { count: 1 },
      idempotencyKey: "goal-speech",
    },
    speech: "我再去砍点木头。",
    audienceRef: "",
    trace: null,
    at: 1_000,
    ...overrides,
  };
}

test("a new autonomous intention is spoken once", () => {
  let now = 10_000;
  const gate = new GoalSpeechGate({ now: () => now });
  assert.equal(gate.take(decision()), "我再去砍点木头。");
  now += 1_000;
  assert.equal(gate.take(decision()), null);
});

test("leaving a task idle does not let the same line repeat immediately", () => {
  let now = 10_000;
  const gate = new GoalSpeechGate({
    now: () => now,
    minIntervalMs: 1_000,
    repeatIntervalMs: 30_000,
  });
  assert.equal(gate.take(decision()), "我再去砍点木头。");
  now += 10_000;
  assert.equal(gate.take(decision()), null);
  now += 25_000;
  assert.equal(gate.take(decision()), "我再去砍点木头。");
});

test("urgent danger and a genuinely new plan may preempt the normal cooldown", () => {
  let now = 10_000;
  const gate = new GoalSpeechGate({ now: () => now });
  assert.equal(gate.take(decision()), "我再去砍点木头。");
  now += 5_000;
  assert.equal(
    gate.take(decision({
      text: "低血量撤离 苦力怕",
      intent: "danger",
      speech: "有苦力怕，我先撤。",
    })),
    "有苦力怕，我先撤。",
  );
  now += 13_000;
  assert.equal(
    gate.take(decision({
      text: "寻找绵羊",
      speech: "天快黑了，我去找只羊做床。",
    })),
    "天快黑了，我去找只羊做床。",
  );
});
