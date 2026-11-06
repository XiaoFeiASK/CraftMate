/**
 * Operator-facing presets for OpenAI-compatible model APIs. Selecting a preset
 * fills the endpoint and a known model, but every field stays editable so
 * relays, local runtimes and self-hosted gateways remain first-class options.
 */
export interface ModelProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly modelHint: string;
}

export const MODEL_PROVIDER_PRESETS = [
  {
    id: "deepseek",
    label: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    modelHint: "deepseek-chat / deepseek-reasoner",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    modelHint: "gpt-4.1-mini / gpt-4.1",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4.1-mini",
    modelHint: "填写 OpenRouter 的完整模型 ID",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    modelHint: "填写模型广场中的完整模型 ID",
  },
  {
    id: "dashscope",
    label: "阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    modelHint: "qwen-plus / qwen-max",
  },
  {
    id: "moonshot",
    label: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2-0905-preview",
    modelHint: "填写 Kimi 控制台中的模型 ID",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4.5",
    modelHint: "glm-4.5 / glm-4.5-air",
  },
  {
    id: "ollama",
    label: "Ollama 本地",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen2.5:7b",
    modelHint: "填写本机已拉取的 Ollama 模型",
  },
] as const satisfies readonly ModelProviderPreset[];

/** Matches both vendor and endpoint so a relay is not mislabeled as official. */
export function modelProviderPresetFor(
  provider: string,
  baseUrl: string,
): ModelProviderPreset | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  return MODEL_PROVIDER_PRESETS.find(
    (preset) => preset.id === provider && normalizeBaseUrl(preset.baseUrl) === normalized,
  );
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}
