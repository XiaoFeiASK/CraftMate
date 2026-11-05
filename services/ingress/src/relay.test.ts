import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AudienceEvent, IngressMetricsFrame } from "@craftmate/contracts";
import { EventGate } from "./gate.ts";
import { BUFFER_FULL_REASON, createRelay } from "./relay.ts";

function comment(index: number, ts = 1_000): AudienceEvent {
  return {
    id: `comment-${index}`,
    source: "douyin",
    kind: "comment",
    userId: `viewer-${index}`,
    nickname: "观众",
    text: `第 ${index} 条`,
    ts,
  };
}

function metrics(relay: ReturnType<typeof createRelay>): IngressMetricsFrame {
  const frame = JSON.parse(
    relay.metrics({
      state: "open",
      detail: "监听中",
      lastEventAt: 1_000,
      upstreamConnected: true,
    }),
  ) as { type: "metrics"; payload: IngressMetricsFrame };
  return frame.payload;
}

describe("ingress relay accounting", () => {
  test("a live delivery is sent once and counted as forwarded", () => {
    const relay = createRelay({ gate: new EventGate({ perSecond: 10, capacity: 8 }) });
    const frames = relay.receive(comment(1), true);

    assert.equal(frames.length, 1);
    assert.equal(relay.state.received, 1);
    assert.equal(relay.state.forwarded, 1);
    assert.equal(relay.state.buffered, 0);
    const payload = metrics(relay);
    assert.equal(payload.received, 1);
    assert.equal(payload.forwarded, 1);
    assert.equal(payload.recent[0]?.accepted, true);
  });

  test("every buffered event increments forwarded only when flushed", () => {
    const relay = createRelay({ gate: new EventGate({ perSecond: 10, capacity: 8 }) });
    assert.deepEqual(relay.receive(comment(1), false), []);
    assert.deepEqual(relay.receive(comment(2), false), []);
    assert.equal(relay.state.forwarded, 0);
    assert.equal(relay.state.buffered, 2);
    assert.equal(metrics(relay).queued, 2);

    const sent: unknown[] = [];
    assert.equal(relay.flush((frame) => sent.push(JSON.parse(frame))), 2);
    assert.equal(sent.length, 2);
    assert.equal(relay.state.forwarded, 2);
    assert.equal(relay.state.buffered, 0);
    // The post-flush frame is the one an operator sees after reconnect.
    assert.equal(metrics(relay).forwarded, 2);
    assert.equal(metrics(relay).queued, 0);
  });

  test("a full buffer drops visibly instead of losing an admitted event", () => {
    const relay = createRelay({
      gate: new EventGate({ perSecond: 10, capacity: 8 }),
      capacity: 2,
    });
    relay.receive(comment(1), false);
    relay.receive(comment(2), false);
    const overflow = relay.receive(comment(3), false);

    assert.deepEqual(overflow, []);
    const payload = metrics(relay);
    assert.equal(payload.received, 3);
    assert.equal(payload.forwarded, 0);
    assert.equal(payload.queued, 2);
    assert.equal(payload.dropped, 1);
    assert.equal(payload.dropReasons[BUFFER_FULL_REASON], 1);
    assert.equal(
      payload.recent.some((fact) => fact.id === "comment-3" && fact.accepted === false),
      true,
    );

    const sent: string[] = [];
    relay.flush((frame) => sent.push(frame));
    assert.equal(sent.length, 2);
    assert.equal(metrics(relay).forwarded, 2);
    assert.equal(metrics(relay).queued, 0);
  });

  test("buffer occupancy and reconnects stay observable", () => {
    const relay = createRelay({ gate: new EventGate({ perSecond: 10, capacity: 8 }), capacity: 4 });
    relay.noteReconnect();
    relay.receive(comment(1), false);
    assert.equal(relay.state.reconnects, 1);
    assert.equal(relay.state.buffered, 1);
    assert.equal(relay.stats().queued, 1);
  });

  test("a room switch resets counters, facts and the dedupe window", () => {
    const relay = createRelay({ gate: new EventGate({ perSecond: 10, capacity: 8 }) });
    relay.receive(comment(1), true);
    relay.receive(comment(1), true);
    assert.equal(relay.state.received, 2);
    assert.equal(relay.stats().dropReasons.duplicate, 1);

    relay.reset();
    assert.equal(relay.state.received, 0);
    assert.equal(relay.state.forwarded, 0);
    assert.equal(relay.stats().dropped, 0);
    assert.deepEqual(relay.stats().dropReasons, {});
    assert.deepEqual(metrics(relay).recent, []);

    assert.equal(relay.receive(comment(1), true).length, 1);
    assert.equal(relay.state.received, 1);
    assert.equal(relay.stats().dropReasons.duplicate, undefined);
  });

  test("gate drop reasons are preserved alongside relay overflow", () => {
    const gate = new EventGate({ perSecond: 1, capacity: 8 });
    const relay = createRelay({
      gate: {
        admit: (event) => gate.admit(event, 1_000),
        drain: () => gate.drain(),
        stats: () => gate.stats(),
        dropCounts: () => gate.dropCounts(),
        lastDropReason: (kind) => gate.lastDropReason(kind),
        reset: () => gate.reset(),
      },
      capacity: 1,
    });
    assert.equal(relay.receive(comment(1), false).length, 0);
    assert.equal(relay.receive(comment(2), false).length, 0);
    // Gifts bypass the chat rate limit, so the third event is admitted and
    // then hits the full relay buffer instead of being silently forgotten.
    assert.equal(
      relay.receive(
        {
          id: "gift-1",
          source: "douyin",
          kind: "gift",
          userId: "viewer-gift",
          nickname: "老板",
          gift: { name: "小心心", count: 1, value: 1 },
          ts: 1_000,
        },
        false,
      ).length,
      0,
    );

    const payload = metrics(relay);
    assert.equal(payload.received, 3);
    assert.equal(payload.forwarded, 0);
    assert.equal(payload.queued, 1);
    assert.equal(payload.dropReasons["rate limited"], 1);
    assert.equal(payload.dropReasons[BUFFER_FULL_REASON], 1);
    assert.equal(payload.dropped, 2);
  });
});
