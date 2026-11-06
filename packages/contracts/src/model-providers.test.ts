import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MODEL_PROVIDER_PRESETS, modelProviderPresetFor } from "./model-providers.ts";

describe("model provider presets", () => {
  test("exposes distinct, complete OpenAI-compatible presets", () => {
    const ids = new Set<string>();
    const endpoints = new Set<string>();
    for (const preset of MODEL_PROVIDER_PRESETS) {
      assert.ok(preset.id.length > 0);
      assert.ok(preset.label.length > 0);
      assert.ok(preset.defaultModel.length > 0);
      assert.match(preset.baseUrl, /^https?:\/\//u);
      assert.ok(!ids.has(preset.id), `duplicate provider id: ${preset.id}`);
      assert.ok(!endpoints.has(preset.baseUrl), `duplicate endpoint: ${preset.baseUrl}`);
      ids.add(preset.id);
      endpoints.add(preset.baseUrl);
    }
    assert.ok(ids.has("deepseek"));
    assert.ok(ids.has("openai"));
    assert.ok(ids.has("openrouter"));
    assert.ok(ids.has("ollama"));
  });

  test("matches a preset only when both vendor and endpoint agree", () => {
    assert.equal(
      modelProviderPresetFor("deepseek", "https://api.deepseek.com/v1/")?.id,
      "deepseek",
    );
    assert.equal(
      modelProviderPresetFor("deepseek", "https://www.yyapi.cloud/v1"),
      undefined,
    );
  });
});
