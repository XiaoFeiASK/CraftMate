import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanRequest } from "../ports/model.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";

const request = (): PlanRequest => ({
  instructions: "只输出 JSON。",
  audienceText: "去挖石头",
  nickname: "本地验收",
  intent: "mine",
  goal: "盖房",
  persona: {
    id: "dafeiyu",
    name: "大肥鱼",
    identity: "鲸鱼娘",
    weights: { obedience: 0.6 },
  },
  memories: [],
  availableSkills: ["mine_block"],
  signal: new AbortController().signal,
});

const completion = (message: Record<string, unknown>, status = 200): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
    { status, headers: { "content-type": "application/json" } },
  );

test("reasoning models can return the final plan in reasoning_content", async () => {
  const provider = new OpenAICompatibleProvider({
    id: "deepseek",
    baseUrl: "https://example.invalid/v1",
    apiKey: "secret",
    model: "reasoning-model",
    fetchImpl: async () =>
      completion({
        content: "",
        reasoning_content:
          '{"speech":"好，我去挖。","skill":{"name":"mine_block","args":{"block":"minecraft:stone","count":1}},"reason":"已规划"}',
      }),
  });

  const planned = await provider.plan(request());
  assert.equal(planned.speech, "好，我去挖。");
  assert.equal(planned.skill?.name, "mine_block");
  assert.deepEqual(planned.usage, { prompt: 10, completion: 20 });
});

test("reasoning models get enough output budget for reasoning and JSON", async () => {
  let body: Record<string, unknown> = {};
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "secret",
    model: "reasoning-model",
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return completion({
        content: '{"speech":"好。","skill":null,"reason":"ok"}',
        reasoning_content: "",
      });
    },
  });

  await provider.plan(request());
  assert.ok(Number(body.max_tokens) >= 1_200);
});

test("reasoning_content that is prose rather than JSON is rejected", async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "secret",
    model: "reasoning-model",
    fetchImpl: async () =>
      completion({
        content: "",
        reasoning_content: "我需要再思考一下，但还没有给出最终 JSON。",
      }),
  });

  await assert.rejects(provider.plan(request()), /provider returned no content/);
});
