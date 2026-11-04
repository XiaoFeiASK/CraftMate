import { z } from "zod";
import { ModelInvalidOutputError, type ModelProvider, type PlanRequest, type PlanResult } from "../ports/model.ts";

export interface OpenAICompatibleOptions {
  readonly id?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** Cost per 1M prompt/completion tokens, for the budget ledger. */
  readonly pricePerMillion?: { readonly input: number; readonly output: number };
}

const responseSchema = z.object({
  speech: z.string().max(2_000),
  reason: z.string().max(500).default(""),
  skill: z
    .object({
      name: z.string().min(1),
      args: z.record(z.unknown()),
      deadlineTicks: z.number().int().positive().optional(),
      idempotencyKey: z.string().min(1).optional(),
    })
    .nullable()
    .default(null),
});

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
        }).optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nonnegative().default(0),
      completion_tokens: z.number().nonnegative().default(0),
    })
    .optional(),
});

/**
 * Single OpenAI-compatible provider (DeepSeek, vLLM, OpenRouter…). Vendor
 * differences stay in config, so adding another vendor never adds a second
 * planning path.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxOutputTokens: number;
  private readonly temperature: number;
  readonly pricePerMillion: { readonly input: number; readonly output: number };

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id ?? "openai-compatible";
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    // Reasoning models charge both hidden reasoning and the final JSON against
    // this limit. A 400-token cap can therefore end with blank `content`.
    this.maxOutputTokens = options.maxOutputTokens ?? 1_200;
    this.temperature = options.temperature ?? 0.7;
    this.pricePerMillion = options.pricePerMillion ?? { input: 0, output: 0 };
  }

  async plan(request: PlanRequest): Promise<PlanResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal: request.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: this.temperature,
        max_tokens: this.maxOutputTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: request.instructions },
          {
            role: "user",
            // The audience line is delimited data, never concatenated into the
            // system prompt: a comment must not be able to rewrite the rules.
            content: JSON.stringify({
              audience: { nickname: request.nickname, text: request.audienceText },
              intent: request.intent,
              world: request.world ?? null,
              availableSkills: request.availableSkills ?? null,
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new ModelInvalidOutputError(`provider returned ${response.status}`);
    }
    const parsedCompletion = completionSchema.safeParse(await response.json());
    if (!parsedCompletion.success) throw new ModelInvalidOutputError("provider envelope is invalid");

    const message = parsedCompletion.data.choices[0]?.message;
    const content = message?.content || extractJsonFromReasoning(message?.reasoning_content);
    if (!content) throw new ModelInvalidOutputError("provider returned no content");

    const json = parseJsonObject(content);
    if (json === null) throw new ModelInvalidOutputError("content is not JSON");
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new ModelInvalidOutputError(parsed.error.message);

    const skill =
      parsed.data.skill === null
        ? null
        : {
            name: parsed.data.skill.name,
            args: parsed.data.skill.args,
            idempotencyKey: parsed.data.skill.idempotencyKey ?? crypto.randomUUID(),
            ...(parsed.data.skill.deadlineTicks === undefined
              ? {}
              : { deadlineTicks: parsed.data.skill.deadlineTicks }),
          };

    const usage = parsedCompletion.data.usage;
    return {
      speech: parsed.data.speech,
      skill: skill as PlanResult["skill"],
      reason: parsed.data.reason,
      provider: this.id,
      model: this.model,
      ...(usage === undefined
        ? {}
        : { usage: { prompt: usage.prompt_tokens, completion: usage.completion_tokens } }),
    };
  }

  /** Cost of the last call in USD; zero when prices were not configured. */
  costOf(usage: { readonly prompt: number; readonly completion: number }): number {
    return (
      (usage.prompt / 1_000_000) * this.pricePerMillion.input +
      (usage.completion / 1_000_000) * this.pricePerMillion.output
    );
  }
}

function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content)?.[1];
    if (!fenced) return null;
    try {
      return JSON.parse(fenced.trim());
    } catch {
      return null;
    }
  }
}

/**
 * Some reasoning models stream the answer in `reasoning_content` when
 * `content` is blank. Accept that field only when the whole trailing value is
 * a JSON object, then still run it through the same schema and skill checks.
 */
function extractJsonFromReasoning(content: string | null | undefined): string | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let candidate: string | null = null;
  for (const match of trimmed.matchAll(fenced)) {
    if (match[1]?.trim().startsWith("{")) candidate = match[1].trim();
  }
  return candidate;
}
