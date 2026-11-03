import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PersonaProfile, VoiceEvent } from "@craftmate/contracts";
import { VoiceEngine } from "./engine.ts";
import { MemoryAudioSink, SilentTtsProvider } from "./providers.ts";
import type { TtsAudio, TtsProvider, TtsRequest } from "./provider.ts";

const voice: PersonaProfile["voice"] = { provider: "fake", voiceId: "dafeiyu", speed: 1 };

function clock(): { now(): number; newId(): string } {
  let now = 1_000;
  let id = 0;
  return { now: () => (now += 1), newId: () => `id-${(id += 1)}` };
}

class FailingProvider implements TtsProvider {
  readonly id: string;
  calls = 0;
  private readonly failFor: number;

  constructor(id: string, failFor = Number.POSITIVE_INFINITY) {
    this.id = id;
    this.failFor = failFor;
  }

  async synthesize(_request: TtsRequest): Promise<TtsAudio> {
    this.calls += 1;
    if (this.calls <= this.failFor) throw new Error("provider down");
    return { bytes: new Uint8Array(0), firstByteAt: Date.now(), mediaType: "audio/wav" };
  }
}

function engineWith(
  providers: readonly TtsProvider[],
  sink = new MemoryAudioSink(),
  extra: Partial<ConstructorParameters<typeof VoiceEngine>[0]> = {},
): { engine: VoiceEngine; events: VoiceEvent[]; sink: MemoryAudioSink } {
  const events: VoiceEvent[] = [];
  const engine = new VoiceEngine({
    clock: clock(),
    providers,
    sink,
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return { engine, events, sink };
}

describe("voice queue", () => {
  test("splits text and emits subtitle before audio", async () => {
    const { engine, events, sink } = engineWith([new SilentTtsProvider()]);
    engine.speak({ text: "唔，知道了！我这就去挖矿。", voice });
    await engine.whenIdle();

    const speaking = events.filter((event) => event.type === "speaking");
    assert.equal(speaking.length, 2);
    assert.deepEqual(
      speaking.map((event) => (event.type === "speaking" ? event.utterance.text : "")),
      ["唔，知道了！", "我这就去挖矿。"],
    );
    assert.equal(sink.played.length, 2);
    assert.equal(engine.status().spoken, 2);
  });

  test("higher priority speech preempts a lower priority segment between sentences", async () => {
    const sink = new MemoryAudioSink(20);
    const { engine, events } = engineWith([new SilentTtsProvider()], sink);

    engine.speak({ text: "第一句。第二句。第三句。", priority: "ambient", voice });
    await new Promise((resolve) => setTimeout(resolve, 5));
    engine.speak({ text: "操作员说话。", priority: "operator", voice });
    await engine.whenIdle();

    const speaking = events
      .filter((event) => event.type === "speaking")
      .map((event) => (event.type === "speaking" ? event.utterance.text : ""));
    assert.equal(speaking[0], "第一句。");
    assert.equal(speaking[1], "操作员说话。");
  });

  test("stop aborts the current segment and clears the queue", async () => {
    const sink = new MemoryAudioSink(5_000);
    const { engine, events } = engineWith([new SilentTtsProvider()], sink);
    engine.speak({ text: "很长的一句话。还有下一句。", voice });
    await new Promise((resolve) => setTimeout(resolve, 20));
    engine.stop("急停");
    await engine.whenIdle();

    assert.equal(engine.status().cancelled, 2);
    assert.ok(events.some((event) => event.type === "cancelled" && event.reason === "急停"));
  });

  test("the queue is bounded and drops the least urgent segment", async () => {
    const sink = new MemoryAudioSink(2_000);
    const { engine, events } = engineWith([new SilentTtsProvider()], sink, { capacity: 1 });
    // The first segment is already being played; the next two pending
    // admissions exceed capacity by one and must shed the least urgent.
    engine.speak({ text: "第一句。", priority: "ambient", voice });
    await new Promise((resolve) => setTimeout(resolve, 20));
    engine.speak({ text: "第二句。", priority: "ambient", voice });
    engine.speak({ text: "第三句。", priority: "ambient", voice });

    const dropped = events.find((event) => event.type === "failed" && event.code === "E_QUEUE_FULL");
    assert.ok(dropped);
    engine.stop();
    await engine.whenIdle();
  });
});

describe("voice failure handling", () => {
  test("a failing primary falls back to the secondary", async () => {
    const primary = new FailingProvider("primary");
    const secondary = new SilentTtsProvider("secondary");
    const { engine, events } = engineWith([primary, secondary]);

    engine.speak({ text: "测试一句。", voice });
    await engine.whenIdle();

    const spoken = events.find((event) => event.type === "spoken");
    assert.equal(spoken?.type === "spoken" ? spoken.provider : null, "secondary");
    assert.equal(engine.status().failed, 0);
  });

  test("when every provider fails the subtitle still exists and the queue continues", async () => {
    const { engine, events } = engineWith([
      new FailingProvider("a"),
      new FailingProvider("b"),
    ]);

    engine.speak({ text: "第一句。第二句。", voice });
    await engine.whenIdle();

    const speaking = events.filter((event) => event.type === "speaking");
    const failed = events.filter((event) => event.type === "failed");
    assert.equal(speaking.length, 2);
    assert.equal(failed.length, 2);
    assert.equal(engine.status().state, "degraded");
  });

  test("an open circuit is skipped until the cooldown elapses", async () => {
    const primary = new FailingProvider("primary");
    const secondary = new SilentTtsProvider("secondary");
    const { engine } = engineWith([primary, secondary], new MemoryAudioSink(), {
      circuitThreshold: 1,
      circuitCooldownMs: 60_000,
    });

    engine.speak({ text: "第一句。", voice });
    await engine.whenIdle();
    const callsAfterFirst = primary.calls;
    engine.speak({ text: "第二句。", voice });
    await engine.whenIdle();

    assert.equal(primary.calls, callsAfterFirst);
    assert.equal(engine.status().providers[0]?.state, "open");
  });

  test("a missing commitment reservation refuses playback", async () => {
    const { engine, events, sink } = engineWith([new SilentTtsProvider()], new MemoryAudioSink(), {
      commitmentGate: { isReserved: () => false },
    });

    engine.speak({ text: "我答应你。", commitmentId: "c-1", voice });
    await engine.whenIdle();

    assert.equal(sink.played.length, 0);
    const failed = events.find((event) => event.type === "failed");
    assert.equal(failed?.type === "failed" ? failed.code : null, "E_NOT_RESERVED");
  });

  test("a reserved commitment is allowed through", async () => {
    const sink = new MemoryAudioSink();
    const { engine } = engineWith([new SilentTtsProvider()], sink, {
      commitmentGate: { isReserved: () => true },
    });

    engine.speak({ text: "我答应你。", commitmentId: "c-1", voice });
    await engine.whenIdle();

    assert.equal(sink.played.length, 1);
  });
});
