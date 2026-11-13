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
 * Operator-tunable playbook thresholds. These are comfort/risk boundaries,
 * not milestone evidence: changing them changes which card is offered, never
 * whether a game fact is considered complete.
 */
export const goalStrategySchema = z.object({
  eatBelow: z.number().int().min(1).max(20).default(16),
  foodReserve: z.number().int().min(0).max(16).default(3),
  retreatHealth: z.number().int().min(1).max(20).default(8),
  engageHealth: z.number().int().min(1).max(20).default(14),
  miningFood: z.number().int().min(0).max(16).default(3),
  miningEmptySlots: z.number().int().min(0).max(36).default(4),
  miningBlocks: z.number().int().min(0).max(128).default(16),
  nightReturnAt: z.number().int().min(0).max(23_999).default(11_000),
  sleepAt: z.number().int().min(0).max(23_999).default(12_000),
  exploreRadius: z.number().int().min(16).max(512).default(128),
  cardMinDwellMs: z.number().int().min(0).max(600_000).default(60_000),
});
export type GoalStrategy = z.infer<typeof goalStrategySchema>;

export const DEFAULT_GOAL_STRATEGY: GoalStrategy = Object.freeze({
  eatBelow: 16,
  foodReserve: 3,
  retreatHealth: 8,
  engageHealth: 14,
  miningFood: 3,
  miningEmptySlots: 4,
  miningBlocks: 16,
  nightReturnAt: 11_000,
  sleepAt: 12_000,
  exploreRadius: 128,
  cardMinDwellMs: 60_000,
});

/**
 * Operator-selectable end goals. The description is display-only: changing it
 * is a product copy change, never a way for the audience to retarget the run.
 */
export const SEASON_GOAL_PRESETS = [
  {
    title: "击败末影龙",
    description: "从空手开始，完成木头、石具、铁具、下界与末地的一条完整生存链。",
  },
  {
    title: "盖一间海崖小屋",
    description: "收集材料并在海边建成一间带床、箱子和工作台的小屋。",
  },
  {
    title: "集齐全套钻石装备",
    description: "找到钻石、制作全套装备，并在可验证的世界事实里确认穿戴完成。",
  },
  {
    title: "自由生存并建设家园",
    description: "从砍树和工作台起步，优先保证食物与庇护，再持续向铁器、下界和终局发育。",
  },
] as const;
export type SeasonGoalPreset = (typeof SEASON_GOAL_PRESETS)[number];

/**
 * Everything the operator can change about the show. Display-only fields are
 * intentionally excluded: stats and decisions must stay derived from events.
 */
export const showSettingsSchema = z.object({
  goal: label(120),
  /** Read-only explanation of the selected end goal. */
  goalDescription: z.string().trim().max(400).default(""),
  /**
   * Goal mode is operator-controlled. Turning it on without a goal is legal:
   * the runtime stays idle until an end goal exists.
   */
  goalMode: z.boolean().default(false),
  /** Playbook thresholds; persisted with the rest of the show settings. */
  goalStrategy: goalStrategySchema.default(DEFAULT_GOAL_STRATEGY),
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
