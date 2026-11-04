import { z } from "zod";

const label = (max: number) => z.string().trim().min(1).max(max);
const listItem = (max: number) => z.string().trim().min(1).max(max);
const endpoint = (schemes: readonly string[]) =>
  z.string().trim().url().refine(
    (value) => schemes.includes(new URL(value).protocol),
    `URL must use ${schemes.join(" or ")}`,
  );

export const personaWeightsSchema = z.object({
  obedience: z.number().min(0).max(1),
  risk: z.number().min(0).max(1),
  sass: z.number().min(0).max(1),
  patience: z.number().min(0).max(1),
  gluttony: z.number().min(0).max(1),
});
export type PersonaWeights = z.infer<typeof personaWeightsSchema>;

export const personaProfileSchema = z.object({
  name: label(24),
  identity: label(280),
  tone: label(80),
  values: z.array(listItem(40)).max(8),
  boundaries: z.array(listItem(60)).max(8),
  weights: personaWeightsSchema,
  voice: z.object({
    provider: label(32),
    voiceId: label(48),
    speed: z.number().min(0.5).max(2),
  }),
});
export type PersonaProfile = z.infer<typeof personaProfileSchema>;

/**
 * Everything the operator can change about the show. Display-only fields are
 * intentionally excluded: stats and decisions must stay derived from events.
 */
export const showSettingsSchema = z.object({
  goal: label(120),
  /** Operator-held progress until the Bridge can report world progress. */
  goalProgress: z.number().int().min(0).max(100),
  worldName: label(60),
  gameVersion: label(24),
  accountLabel: label(40),
  integrations: z.object({
    douyinRoomId: z.string().trim().max(64),
    deepseekModel: z.string().trim().max(64),
  }),
  persona: personaProfileSchema,
});
export type ShowSettings = z.infer<typeof showSettingsSchema>;

/**
 * Persisted local service configuration. Secret fields never cross the
 * operator wire; the views below provide a redacted projection.
 */
export const modelRuntimeConfigSchema = z.object({
  provider: label(32),
  baseUrl: endpoint(["http:", "https:"]),
  model: label(96),
  apiKey: z.string().trim().max(4_096),
  timeoutMs: z.number().int().min(250).max(120_000),
});
export type ModelRuntimeConfig = z.infer<typeof modelRuntimeConfigSchema>;

export const voiceRuntimeConfigSchema = z.object({
  provider: z.literal("volcengine-realtime"),
  url: endpoint(["ws:", "wss:"]),
  apiKey: z.string().trim().max(4_096),
  voiceId: label(96),
  instructions: z.string().trim().min(1).max(2_000),
  timeoutMs: z.number().int().min(1_000).max(600_000),
});
export type VoiceRuntimeConfig = z.infer<typeof voiceRuntimeConfigSchema>;

export const douyinRuntimeConfigSchema = z.object({
  roomId: z.string().trim().max(128),
  dyhubUrl: endpoint(["ws:", "wss:"]),
});
export type DouyinRuntimeConfig = z.infer<typeof douyinRuntimeConfigSchema>;

export const runtimeIntegrationConfigSchema = z.object({
  model: modelRuntimeConfigSchema,
  voice: voiceRuntimeConfigSchema,
  douyin: douyinRuntimeConfigSchema,
});
export type RuntimeIntegrationConfig = z.infer<typeof runtimeIntegrationConfigSchema>;

/** Read model sent to the console. It never contains secret values. */
export const integrationSettingsViewSchema = z.object({
  model: z.object({
    provider: z.string(),
    baseUrl: z.string(),
    model: z.string(),
    apiKeyConfigured: z.boolean(),
    timeoutMs: z.number().int(),
  }),
  voice: z.object({
    provider: z.literal("volcengine-realtime"),
    url: z.string(),
    voiceId: z.string(),
    apiKeyConfigured: z.boolean(),
    instructions: z.string(),
    timeoutMs: z.number().int(),
  }),
  douyin: z.object({
    roomId: z.string(),
    dyhubUrl: z.string(),
  }),
});
export type IntegrationSettingsView = z.infer<typeof integrationSettingsViewSchema>;

/**
 * Save request for the editable integration form. An omitted or blank API key
 * keeps the existing secret; `clearApiKey` removes it explicitly.
 */
export const integrationSettingsUpdateSchema = z.object({
  model: z.object({
    provider: label(32),
    baseUrl: endpoint(["http:", "https:"]),
    model: label(96),
    apiKey: z.string().trim().max(4_096).optional(),
    clearApiKey: z.boolean().default(false),
    timeoutMs: z.number().int().min(250).max(120_000),
  }),
  voice: z.object({
    provider: z.literal("volcengine-realtime"),
    url: endpoint(["ws:", "wss:"]),
    voiceId: label(96),
    apiKey: z.string().trim().max(4_096).optional(),
    clearApiKey: z.boolean().default(false),
    instructions: z.string().trim().min(1).max(2_000),
    timeoutMs: z.number().int().min(1_000).max(600_000),
  }),
  douyin: z.object({
    roomId: z.string().trim().max(128),
    dyhubUrl: endpoint(["ws:", "wss:"]),
  }),
});
export type IntegrationSettingsUpdate = z.infer<typeof integrationSettingsUpdateSchema>;
