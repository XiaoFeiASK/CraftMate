import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchModelIds } from "./model-catalog.ts";

function catalogResponse(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

test("reads OpenAI-style model envelopes and removes duplicates", async () => {
  const models = await fetchModelIds({
    baseUrl: "https://relay.example/v1/",
    apiKey: "secret",
    fetchImpl: catalogResponse({
      data: [{ id: "deepseek-chat" }, { id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
    }),
  });
  assert.deepEqual(models, ["deepseek-chat", "deepseek-reasoner"]);
});

test("accepts relay-specific `models` envelopes and bare arrays", async () => {
  const wrapped = await fetchModelIds({
    baseUrl: "https://relay.example/v1",
    apiKey: "secret",
    fetchImpl: catalogResponse({ models: ["qwen-plus", { name: "qwen-max" }] }),
  });
  const bare = await fetchModelIds({
    baseUrl: "https://relay.example/v1",
    apiKey: "secret",
    fetchImpl: catalogResponse([{ id: "glm-4.5" }]),
  });
  assert.deepEqual(wrapped, ["qwen-max", "qwen-plus"]);
  assert.deepEqual(bare, ["glm-4.5"]);
});

test("sends the saved key as a bearer token and targets /models", async () => {
  const requested: { url?: string; headers?: Headers } = {};
  await fetchModelIds({
    baseUrl: "https://relay.example/v1",
    apiKey: "secret-key",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      requested.url = String(input);
      requested.headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ data: [] }));
    }) as typeof fetch,
  }).catch(() => {
    // The empty list is an error, but the request shape is what matters here.
  });
  assert.equal(requested.url, "https://relay.example/v1/models");
  assert.equal(requested.headers?.get("authorization"), "Bearer secret-key");
});

test("local endpoints without a key send no Authorization header", async () => {
  const captured: { headers?: Headers } = {};
  await fetchModelIds({
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "",
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      captured.headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ data: [{ id: "qwen2.5:7b" }] }));
    }) as typeof fetch,
  });
  assert.equal(captured.headers?.has("authorization"), false);
});

test("turns an unauthorized provider response into an operator-readable error", async () => {
  await assert.rejects(
    fetchModelIds({
      baseUrl: "https://relay.example/v1",
      apiKey: "bad",
      fetchImpl: catalogResponse({ error: "unauthorized" }, 401),
    }),
    /API Key 无效/,
  );
});
