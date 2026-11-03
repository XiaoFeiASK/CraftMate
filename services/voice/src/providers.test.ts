import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { DAFEIYU_REALTIME_INSTRUCTIONS, VolcengineRealtimeTtsProvider } from "./providers.ts";

class FakeRealtimeSocket extends EventEmitter {
  readonly sent: string[] = [];
  readyState = 0;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.alloc(0));
  }
}

test("Volcengine realtime provider creates a session and emits committed text", async () => {
  const socket = new FakeRealtimeSocket();
  let requestUrl = "";
  let requestHeaders: Record<string, string> = {};
  const provider = new VolcengineRealtimeTtsProvider({
    apiKey: "realtime-test-key",
    socketFactory: (url, headers) => {
      requestUrl = url;
      requestHeaders = headers;
      return socket;
    },
  });
  const pending = provider.synthesize({
    text: "唔，肥鱼来啦。",
    voice: { provider: "volcengine-realtime", voiceId: "zh_female_vv_uranus_bigtts", speed: 1.05 },
    signal: new AbortController().signal,
  });
  socket.emit("open");
  const create = JSON.parse(socket.sent[0] ?? "{}");
  assert.equal(requestUrl, "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue");
  assert.equal(requestHeaders["X-Api-Key"], "realtime-test-key");
  assert.equal(create.type, "session.create");
  assert.equal(create.session.model, "1.2.6.1");
  assert.equal(create.session.instructions, DAFEIYU_REALTIME_INSTRUCTIONS);
  assert.equal(create.session.audio.output.voice, "zh_female_vv_uranus_bigtts");
  assert.equal(create.session.audio.output.speed, 5);
  assert.equal(create.session.audio.output.format.rate, 24_000);

  socket.emit("message", JSON.stringify({ type: "session.created", session: { id: "dialog-1" } }));
  assert.deepEqual(JSON.parse(socket.sent[1] ?? "{}"), {
    event_id: JSON.parse(socket.sent[1] ?? "{}").event_id,
    type: "speech_text_buffer.commit",
    text: "唔，肥鱼来啦。",
  });
  socket.emit("message", JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.from([1, 2]).toString("base64") }));
  socket.emit("message", JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.from([3, 4]).toString("base64") }));
  socket.emit("message", JSON.stringify({ type: "response.output_audio.done" }));

  const audio = await pending;
  assert.equal(audio.mediaType, "audio/wav");
  assert.equal(Buffer.from(audio.bytes).subarray(0, 4).toString(), "RIFF");
  assert.deepEqual([...Buffer.from(audio.bytes).subarray(44)], [1, 2, 3, 4]);
});

test("Volcengine realtime provider surfaces server errors", async () => {
  const socket = new FakeRealtimeSocket();
  const provider = new VolcengineRealtimeTtsProvider({
    apiKey: "realtime-test-key",
    socketFactory: () => socket,
  });
  const pending = provider.synthesize({
    text: "你好。",
    voice: { provider: "volcengine-realtime", voiceId: "dafeiyu", speed: 1 },
    signal: new AbortController().signal,
  });
  socket.emit("open");
  socket.emit("message", JSON.stringify({ type: "error", error: { code: "invalid_api_key", message: "bad key" } }));
  await assert.rejects(pending, /invalid_api_key.*bad key/);
});

test("Volcengine realtime provider rejects a stream that closes without audio", async () => {
  const socket = new FakeRealtimeSocket();
  const provider = new VolcengineRealtimeTtsProvider({
    apiKey: "realtime-test-key",
    socketFactory: () => socket,
  });
  const pending = provider.synthesize({
    text: "你好。",
    voice: { provider: "volcengine-realtime", voiceId: "dafeiyu", speed: 1 },
    signal: new AbortController().signal,
  });
  socket.emit("open");
  socket.emit("message", JSON.stringify({ type: "session.created", session: { id: "dialog-1" } }));
  socket.emit("close", 1000, "");
  await assert.rejects(pending, /closed before audio completed/);
});
