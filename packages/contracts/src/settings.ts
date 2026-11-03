import { z } from "zod";

const label = (max: number) => z.string().trim().min(1).max(max);
const listItem = (max: number) => z.string().trim().min(1).max(max);

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
