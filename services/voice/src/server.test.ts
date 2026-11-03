import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WebSocket } from "ws";
import type { VoiceEvent, VoiceServerFrame } from "@craftmate/contracts";
import { VoiceEngine } from "./engine.ts";
import { MemoryAudioSink, SilentTtsProvider } from "./providers.ts";
import { createVoiceServer } from "./server.ts";

const TOKEN = "voice-test-token-0123456789abcdef";
const voice = { provider: "fake", voiceId: "dafeiyu", speed: 1 };

function frame(socket: WebSocket): Promise<VoiceServerFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 2_000);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as VoiceServerFrame);
    });
  });
}

function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/voice`);
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("voice server", () => {
  test("requires the shared token and rejects a forged one", async () => {
    const engine = new VoiceEngine({ providers: [new SilentTtsProvider()], sink: new MemoryAudioSink() });
    const server = createVoiceServer({
      engine,
      port: 0,
      token: TOKEN,
      initialStatus: engine.status(),
      voice,
    });
    try {
      const socket = await connect(await server.listening);
      const closed = new Promise<number>((resolve) => socket.once("close", resolve));
      socket.send(JSON.stringify({ type: "hello", token: "forged" }));
      assert.equal(await closed, 4401);
    } finally {
      await server.close();
    }
  });

  test("speaks a command and streams subtitles to the console", async () => {
    const events: VoiceEvent[] = [];
    const engine = new VoiceEngine({
      providers: [new SilentTtsProvider()],
      sink: new MemoryAudioSink(),
      onEvent: (event) => events.push(event),
    });
    const server = createVoiceServer({
      engine,
      port: 0,
      token: TOKEN,
      initialStatus: engine.status(),
      voice,
    });
    const frames: VoiceServerFrame[] = [];

    try {
      const port = await server.listening;
      // Forward engine events through the same publish path main.ts uses.
      const original = events.push.bind(events);
      void original;

      const socket = await connect(port);
      socket.send(JSON.stringify({ type: "hello", token: TOKEN }));
      const ready = await frame(socket);
      assert.equal(ready.type, "ready");

      socket.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as VoiceServerFrame));
      socket.send(JSON.stringify({ type: "command", payload: { type: "speak", text: "你好呀。" } }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.ok(frames.some((entry) => entry.type === "event"));
      const spoken = frames.filter(
        (entry) =>
          entry.type === "event" && entry.payload.type === "speaking",
      );
      assert.equal(spoken.length, 1);
    } finally {
      await server.close();
    }
  });
});
