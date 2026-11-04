import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRuntimeConfigStore, publicRuntimeConfig } from "./index.ts";

test("runtime config persists secrets with owner-only permissions and never returns them in the view", () => {
  const path = join(mkdtempSync(join(tmpdir(), "craftmate-config-")), "integrations.json");
  const store = createRuntimeConfigStore({ path, env: {} });
  const saved = store.save({
    model: {
      provider: "deepseek",
      baseUrl: "https://www.yyapi.cloud/v1",
      model: "deepseek-v4.1-flash",
      apiKey: "model-secret",
      clearApiKey: false,
      timeoutMs: 10_000,
    },
    voice: {
      provider: "volcengine-realtime",
      url: "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue",
      voiceId: "zh_female_vv_uranus_bigtts",
      apiKey: "voice-secret",
      clearApiKey: false,
      instructions: "忠实朗读。",
      timeoutMs: 300_000,
    },
    douyin: { roomId: "12345", dyhubUrl: "ws://127.0.0.1:8757" },
  });

  assert.equal(saved.model.apiKey, "model-secret");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const view = publicRuntimeConfig(store.read());
  assert.equal(view.model.apiKeyConfigured, true);
  assert.equal(view.voice.apiKeyConfigured, true);
  assert.equal(JSON.stringify(view).includes("model-secret"), false);
  assert.equal(JSON.stringify(view).includes("voice-secret"), false);
});

test("a blank key keeps the saved key and clearing is explicit", () => {
  const path = join(mkdtempSync(join(tmpdir(), "craftmate-config-")), "integrations.json");
  const store = createRuntimeConfigStore({ path, env: {} });
  const base = {
    model: {
      provider: "deepseek",
      baseUrl: "https://www.yyapi.cloud/v1",
      model: "deepseek-v4.1-flash",
      apiKey: "first-model",
      clearApiKey: false,
      timeoutMs: 10_000,
    },
    voice: {
      provider: "volcengine-realtime" as const,
      url: "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue",
      voiceId: "zh_female_vv_uranus_bigtts",
      apiKey: "first-voice",
      clearApiKey: false,
      instructions: "忠实朗读。",
      timeoutMs: 300_000,
    },
    douyin: { roomId: "", dyhubUrl: "ws://127.0.0.1:8757" },
  };
  store.save(base);
  const kept = store.save({ ...base, model: { ...base.model, apiKey: "" } });
  assert.equal(kept.model.apiKey, "first-model");
  const cleared = store.save({
    ...base,
    model: { ...base.model, apiKey: "", clearApiKey: true },
    voice: { ...base.voice, apiKey: "", clearApiKey: true },
  });
  assert.equal(cleared.model.apiKey, "");
  assert.equal(cleared.voice.apiKey, "");
});
