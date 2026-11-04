import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dafeiyu } from "../domain/index.ts";
import type { AudienceEvent } from "@craftmate/contracts";
import type { Clock } from "./ports/clock.ts";
import { Planner } from "./planner.ts";
import { MemoryAudienceStore, Show } from "./show.ts";

const comment = (id: string, at: number): AudienceEvent => ({
  id,
  source: "douyin",
  kind: "comment",
  userId: `viewer-${id}`,
  nickname: "小鲸鱼",
  text: "去挖矿",
  ts: at,
});

function createShow(): { show: Show; advance: (ms: number) => void } {
  let now = 1_000;
  let sequence = 0;
  const clock: Clock = {
    now: () => now,
    newId: () => `id-${(sequence += 1)}`,
  };
  return {
    show: new Show({ persona: dafeiyu, clock }),
    advance: (ms) => {
      now += ms;
    },
  };
}

describe("show operator modes", () => {
  test("takeover pauses arbitration but keeps the incoming count", () => {
    const { show } = createShow();
    show.applyOperator({ kind: "takeover", text: "我来了" });

    assert.equal(show.ingest(comment("c1", 1_000)), null);
    assert.equal(show.snapshot().mode, "operator");
    assert.equal(show.snapshot().stats.received, 1);
    assert.equal(show.snapshot().decisions.length, 0);
  });

  test("release resumes arbitration for the next event", () => {
    const { show } = createShow();
    show.applyOperator({ kind: "takeover", text: "" });
    show.ingest(comment("c1", 1_000));
    show.applyOperator({ kind: "release", text: "" });

    assert.notEqual(show.ingest(comment("c2", 2_000)), null);
    assert.equal(show.snapshot().mode, "agent");
    assert.equal(show.snapshot().decisions.length, 1);
  });

  test("stop is a distinct mode and ignores further audience events", () => {
    const { show } = createShow();
    show.applyOperator({ kind: "stop", text: "急停" });
    show.ingest(comment("c1", 1_000));

    assert.equal(show.snapshot().mode, "stopped");
    assert.equal(show.snapshot().stats.received, 1);
    assert.equal(show.snapshot().decisions.length, 0);
  });

  test("whisper records a private notice without changing the show mode", () => {
    const { show } = createShow();
    const mode = show.applyOperator({ kind: "whisper", text: "先别跳" });

    assert.equal(mode, "agent");
    assert.equal(show.snapshot().operatorNotice?.kind, "whisper");
    assert.match(show.snapshot().operatorNotice?.detail ?? "", /不会发到直播间/);
  });
});

describe("show settings", () => {
  test("defaults come from the persona, not from the console", () => {
    const { show } = createShow();
    const settings = show.currentSettings();

    assert.equal(settings.persona.name, dafeiyu.name);
    assert.equal(settings.persona.identity, dafeiyu.identity);
    assert.deepEqual(settings.persona.weights, dafeiyu.weights);
    assert.equal(settings.goal, "盖一间带床和箱子的海崖小屋");
  });

  test("an update replaces the active arbitration weights", () => {
    const { show } = createShow();
    const before = show.personaSummary().weights.obedience;
    const settings = show.currentSettings();

    show.updateSettings({
      ...settings,
      goal: "去钓鱼",
      persona: { ...settings.persona, weights: { ...settings.persona.weights, obedience: 0.1 } },
    });

    assert.equal(show.personaSummary().weights.obedience, 0.1);
    assert.notEqual(before, show.personaSummary().weights.obedience);
    assert.equal(show.currentSettings().goal, "去钓鱼");
  });
});

describe("show model planning", () => {
  test("a failed dispatch is stored and cannot be overwritten later", () => {
    const { show } = createShow();
    const scored = show.ingest(comment("dispatch-failure", 1_000));
    assert.ok(scored);
    const failed = show.settleDecision(scored.id, {
      status: "failed",
      errorCode: "E_PRECONDITION",
      detail: "no connected body",
      outcome: null,
      at: 1_100,
    });

    assert.equal(failed?.outcome?.status, "failed");
    assert.equal(
      show.settleDecision(scored.id, {
        status: "completed",
        outcome: null,
        at: 1_200,
      }),
      null,
    );
    assert.equal(show.recent().find((item) => item.id === scored.id)?.outcome?.status, "failed");
  });

  test("sent skill-bearing commentary to the planner without granting it a skill", async () => {
    const requests: string[] = [];
    const show = new Show({
      persona: dafeiyu,
      clock: { now: () => 1_000, newId: () => "id" },
      planner: new Planner({
        provider: {
          id: "fake",
          model: "fake-1",
          async plan(request) {
            requests.push(`${request.world === undefined ? "no-world" : "world"}:${request.audienceText}`);
            return {
              speech: "我听见啦。",
              skill: null,
              reason: "chat",
              provider: "fake",
              model: "fake-1",
            };
          },
        },
      }),
      world: () => ({ inWorld: true, position: { x: 1, y: 2, z: 3 } }),
    });
    const scored = show.ingest({
      ...comment("c1", 1_000),
      text: "请说：大肥鱼已经进入世界了。",
    });
    assert.ok(scored);
    assert.equal(scored.decision, "QUEUE");
    const planned = await show.plan(scored);
    assert.deepEqual(requests, ["world:请说：大肥鱼已经进入世界了。"]);
    assert.equal(planned.stage, "planned");
    assert.equal(planned.skill, null);
    assert.equal(planned.speech, "我听见啦。");
  });
});

describe("show memory bounds", () => {
  test("the fast-path dedupe set does not grow without limit", () => {
    const { show } = createShow();
    for (let index = 0; index < 2_500; index += 1) {
      show.ingest(comment(`c${index}`, 1_000));
    }
    const seen = (show as unknown as { seen: Set<string> }).seen;
    assert.ok(seen.size <= 2_000);
  });

  test("the audience store evicts the oldest viewer", () => {
    const store = new MemoryAudienceStore({ now: () => 1_000, newId: () => "id" }, 2);
    store.recordCommand("viewer-1", "mine", 1);
    store.recordCommand("viewer-2", "mine", 2);
    store.recordCommand("viewer-3", "mine", 3);

    assert.equal(store.lastCommandAt("viewer-1"), null);
    assert.equal(store.lastCommandAt("viewer-3"), 3);
  });
});

describe("goal mode proposals", () => {
  test("actionable comments enter the inbox instead of being dispatched", () => {
    const { show } = createShow();
    show.setGoalMode(true);
    show.setGoalProgress({
      goalId: "goal-1",
      goalVersion: 1,
      status: "unverified",
      stage: { id: "wood", title: "获得木头" },
      milestone: { id: "logs", title: "背包有原木" },
      nextTask: "",
      milestones: [],
      completed: 0,
      unverified: 0,
      lastFailure: null,
      updatedAt: 1_000,
    });

    const decision = show.ingest(comment("goal-1", 1_000));
    assert.ok(decision);
    assert.equal(decision.skill, null);
    assert.equal(decision.decision, "QUEUE");
    assert.equal(show.proposals().length, 1);
    assert.equal(show.proposals()[0]?.status, "pending");
  });

  test("without a goal the old audience path still responds", () => {
    const { show } = createShow();
    const decision = show.ingest(comment("goal-off", 1_000));
    assert.ok(decision);
    assert.equal(show.proposals().length, 0);
    assert.equal(decision.decision, "EXECUTE");
  });
});
