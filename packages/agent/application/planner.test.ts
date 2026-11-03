import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Decision, PersonaSummary } from "@craftmate/contracts";
import { Planner } from "./planner.ts";
import type { ModelProvider, PlanRequest, PlanResult } from "./ports/model.ts";

const persona: PersonaSummary = {
  id: "dafeiyu",
  name: "大肥鱼",
  identity: "鲸鱼娘",
  weights: { obedience: 0.6, risk: 0.45, sass: 0.5, patience: 0.5, gluttony: 0.75 },
};

const decision = (overrides: Partial<Decision> = {}): Decision => ({
  id: "d-1",
  eventId: "e-1",
  nickname: "小鲸鱼",
  text: "去挖点铁矿",
  intent: "mine",
  decision: "EXECUTE",
  priority: "command",
  reason: "可行",
  score: 0.8,
  stage: "scored",
  skill: null,
  speech: "",
  audienceRef: "viewer:abc",
  trace: null,
  at: 1_000,
  ...overrides,
});

const provider = (plan: (request: PlanRequest) => Promise<PlanResult>): ModelProvider => ({
  id: "fake",
  model: "fake-1",
  plan,
});

const hanging = provider(
  (request) =>
    new Promise<PlanResult>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
);

describe("stage C planner", () => {
  test("keeps audience text out of the system instructions", async () => {
    const seen: { value: PlanRequest | null } = { value: null };
    const planner = new Planner({
      provider: provider(async (request) => {
        seen.value = request;
        return { speech: "好，我去。", skill: null, reason: "ok", provider: "fake", model: "fake-1" };
      }),
    });

    await planner.plan({ decision: decision(), goal: "盖房", persona });
    const request = seen.value;
    assert.ok(request);
    assert.equal(request.instructions.includes("去挖点铁矿"), false);
    assert.equal(request.audienceText, "去挖点铁矿");
  });

  test("a slow provider degrades to a template inside the deadline", async () => {
    const incidents: string[] = [];
    const planner = new Planner({
      provider: hanging,
      deadlineMs: 60,
      onIncident: (incident) => incidents.push(incident.code),
    });

    const started = Date.now();
    const planned = await planner.plan({ decision: decision(), goal: "盖房", persona });
    assert.ok(Date.now() - started < 500);
    assert.equal(planned.degraded, true);
    assert.equal(planned.skill, null);
    assert.equal(planned.speech.length > 0, true);
    assert.deepEqual(incidents, ["MODEL_TIMEOUT"]);
  });

  test("invalid skill args are rejected instead of reaching the bridge", async () => {
    const incidents: string[] = [];
    const planner = new Planner({
      provider: provider(async () => ({
        speech: "好。",
        skill: { name: "mine_block", args: { block: "" }, idempotencyKey: "k" },
        reason: "bad",
        provider: "fake",
        model: "fake-1",
      })),
      onIncident: (incident) => incidents.push(incident.code),
    });

    const planned = await planner.plan({ decision: decision(), goal: "盖房", persona });
    assert.equal(planned.skill, null);
    assert.equal(planned.degraded, true);
    assert.deepEqual(incidents, ["MODEL_INVALID"]);
  });

  test("only EXECUTE decisions may carry a skill", async () => {
    const planner = new Planner({
      provider: provider(async () => ({
        speech: "收到。",
        skill: { name: "goto", args: { target: { x: 0, y: 64, z: 0 } }, idempotencyKey: "k" },
        reason: "sneaky",
        provider: "fake",
        model: "fake-1",
      })),
    });

    const planned = await planner.plan({
      decision: decision({ decision: "ACK_ONLY" }),
      goal: "盖房",
      persona,
    });
    assert.equal(planned.skill, null);
    assert.equal(planned.degraded, true);
  });

  test("a valid plan keeps the skill and its provenance", async () => {
    const planner = new Planner({
      provider: provider(async () => ({
        speech: "好，我去挖。",
        skill: { name: "mine_block", args: { block: "minecraft:iron_ore", count: 2 }, idempotencyKey: "k" },
        reason: "可执行",
        provider: "fake",
        model: "fake-1",
      })),
    });

    const planned = await planner.plan({ decision: decision(), goal: "盖房", persona });
    assert.equal(planned.degraded, false);
    assert.equal(planned.skill?.name, "mine_block");
    assert.equal(planned.provider, "fake");
  });
});
