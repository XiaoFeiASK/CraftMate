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
  test("updates the deadline when the operator saves a new model timeout", async () => {
    const planner = new Planner({
      provider: hanging,
      deadlineMs: 10,
    });
    planner.updateDeadline(80);

    const started = Date.now();
    const planned = await planner.plan({ decision: decision(), goal: "盖房", persona });
    assert.ok(Date.now() - started >= 60);
    assert.equal(planned.degraded, true);
    assert.match(planned.detail, /80ms/);
  });

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
    assert.deepEqual(planner.status, {
      state: "ready",
      provider: "fake",
      model: "fake-1",
      detail: "最近一次模型请求成功",
    });
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
    assert.equal(planner.status.state, "error");
  });

  test("passes the live world snapshot to planning without moving it into instructions", async () => {
    let seen: PlanRequest | null = null;
    const planner = new Planner({
      provider: provider(async (request) => {
        seen = request;
        return { speech: "看到了", skill: null, reason: "", provider: "fake", model: "fake-1" };
      }),
    });
    const world = {
      inWorld: true,
      position: { x: 10, y: 64, z: 8 },
      nearbyBlocks: [{ id: "minecraft:stone" }],
    };

    await planner.plan({ decision: decision(), goal: "盖房", persona, world });
    const request = seen as PlanRequest | null;
    assert.ok(request);
    assert.deepEqual(request.world, world);
    assert.equal(request.instructions.includes("minecraft:stone"), false);
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

  test("guides the model to chop_tree for wood and accepts it", async () => {
    let instructions = "";
    const planner = new Planner({
      provider: provider(async (request) => {
        instructions = request.instructions;
        return {
          speech: "好，我去砍木头。",
          skill: { name: "chop_tree", args: { count: 2 }, idempotencyKey: "k" },
          reason: "可执行",
          provider: "fake",
          model: "fake-1",
        };
      }),
    });

    const planned = await planner.plan({
      decision: decision({ text: "去砍两棵树", intent: "mine" }),
      goal: "盖房",
      persona,
      availableSkills: ["goto", "chop_tree"],
    });
    assert.match(instructions, /chop_tree/);
    assert.equal(planned.degraded, false);
    assert.equal(planned.skill?.name, "chop_tree");
    assert.deepEqual(planned.skill?.args, { count: 2 });
  });

  test("rejects a valid contract skill when the connected body does not advertise it", async () => {
    let calls = 0;
    const requests: PlanRequest[] = [];
    const planner = new Planner({
      provider: provider(async (request) => {
        calls += 1;
        requests.push(request);
        return {
          speech: "好。",
          skill: {
            name: "craft" as const,
            args: { item: "minecraft:stone_pickaxe", count: 1 },
            idempotencyKey: "k",
          },
          reason: "body cannot craft",
          provider: "fake",
          model: "fake-1",
        };
      }),
    });

    const planned = await planner.plan({
      decision: decision(),
      goal: "盖房",
      persona,
      availableSkills: ["goto", "mine_block"],
    });

    assert.equal(calls, 2);
    assert.deepEqual(requests[0]?.availableSkills, ["goto", "mine_block"]);
    assert.match(requests[1]?.instructions ?? "", /goto, mine_block/);
    assert.equal(planned.skill, null);
    assert.equal(planned.degraded, true);
  });

  test("an invalid skill name gets one contract correction with a fresh budget", async () => {
    const requests: PlanRequest[] = [];
    const usages: Array<readonly [number, number]> = [];
    const planner = new Planner({
      deadlineMs: 80,
      onUsage: (usage) => usages.push([usage.prompt, usage.completion]),
      provider: provider(async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          return {
            speech: "好，我去挖。",
            skill: {
              name: "mine" as "mine_block",
              args: { block: "minecraft:iron_ore", count: 2 },
              idempotencyKey: "k1",
            },
            reason: "使用意图分类名",
            provider: "fake",
            model: "fake-1",
            usage: { prompt: 10, completion: 4 },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          speech: "好，我去挖。",
          skill: {
            name: "mine_block",
            args: { block: "minecraft:iron_ore", count: 2 },
            idempotencyKey: "k2",
          },
          reason: "按契约纠正",
          provider: "fake",
          model: "fake-1",
          usage: { prompt: 12, completion: 5 },
        };
      }),
    });

    const planned = await planner.plan({ decision: decision(), goal: "盖房", persona });
    assert.equal(requests.length, 2);
    assert.match(requests[1]?.instructions ?? "", /mine_block/);
    assert.equal(planned.degraded, false);
    assert.equal(planned.skill?.name, "mine_block");
    assert.deepEqual(usages, [
      [10, 4],
      [12, 5],
    ]);
  });
});
