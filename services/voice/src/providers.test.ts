import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpTtsProvider, VolcengineTtsProvider } from "./providers.ts";

test("HTTP TTS sends the configured bearer key and returns provider audio bytes", async () => {
  let requestBody: unknown;
  const provider = new HttpTtsProvider({
    id: "test-tts",
    url: "https://tts.example.test/synthesize",
    headers: { authorization: "Bearer test-only-key" },
    body: (request) => ({ text: request.text, voice_id: "configured-voice", speed: request.voice.speed }),
    fetchImpl: async (input, init) => {
      assert.equal(input, "https://tts.example.test/synthesize");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only-key");
      requestBody = JSON.parse(String(init?.body));
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      });
    },
  });

  const audio = await provider.synthesize({
    text: "你好呀。",
    voice: { provider: "test", voiceId: "dafeiyu", speed: 1.05 },
    signal: new AbortController().signal,
  });

  assert.deepEqual(requestBody, { text: "你好呀。", voice_id: "configured-voice", speed: 1.05 });
  assert.deepEqual([...audio.bytes], [1, 2, 3]);
  assert.equal(audio.mediaType, "audio/mpeg");
});

test("Volcengine V3 SSE provider decodes audio events", async () => {
  let requestBody: unknown;
  const provider = new VolcengineTtsProvider({
    apiKey: "volc-test-key",
    resourceId: "seed-tts-2.0",
    speaker: "zh_female_cancan_mars_bigtts",
    fetchImpl: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("X-Api-Key"), "volc-test-key");
      assert.equal(new Headers(init?.headers).get("X-Api-Resource-Id"), "seed-tts-2.0");
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        [
          'event: 352\ndata: {"code":0,"message":"","data":"AQI="}\n\n',
          'event: 152\ndata: {"code":20000000,"message":"ok","data":null}\n\n',
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  const audio = await provider.synthesize({
    text: "你好。",
    voice: { provider: "volcengine", voiceId: "", speed: 1.05 },
    signal: new AbortController().signal,
  });

  assert.deepEqual(requestBody, {
    user: { uid: "craftmate" },
    req_params: {
      text: "你好。",
      speaker: "zh_female_cancan_mars_bigtts",
      audio_params: { format: "mp3", sample_rate: 24_000, speech_rate: 5 },
    },
  });
  assert.deepEqual([...audio.bytes], [1, 2]);
  assert.equal(audio.mediaType, "audio/mpeg");
});
