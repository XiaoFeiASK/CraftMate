import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dafeiyu } from "../domain/index.ts";
import type { AudienceEvent } from "@craftmate/contracts";
import type { Clock } from "./ports/clock.ts";
import { Show } from "./show.ts";

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
