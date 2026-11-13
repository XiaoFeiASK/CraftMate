import { z } from "zod";

export const worldMemoryKindSchema = z.enum([
  "home",
  "mine",
  "resource",
  "hazard",
  "container",
  "bed",
  "furnace",
  "crafting_table",
  "portal",
]);
export type WorldMemoryKind = z.infer<typeof worldMemoryKindSchema>;

export const worldMemorySourceSchema = z.enum(["body", "agent", "operator"]);
export type WorldMemorySource = z.infer<typeof worldMemorySourceSchema>;

/**
 * One persisted place fact. `confidence` is the value observed at write time;
 * recall applies a separate recency decay so an old landmark is still visible
 * to the operator without being treated as a hard precondition.
 */
export const worldMemorySchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  kind: worldMemoryKindSchema,
  label: z.string().trim().min(1).max(160),
  dimension: z.string().trim().min(1).max(120),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  payload: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(1),
  source: worldMemorySourceSchema,
  observedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable().default(null),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type WorldMemory = z.infer<typeof worldMemorySchema>;

export const worldMemoryDraftSchema = z.object({
  kind: worldMemoryKindSchema,
  label: z.string().trim().min(1).max(160),
  dimension: z.string().trim().min(1).max(120),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  payload: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(1).default(0.8),
  source: worldMemorySourceSchema.default("body"),
  observedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable().default(null),
});
export type WorldMemoryDraft = z.infer<typeof worldMemoryDraftSchema>;

export const worldMemoryQuerySchema = z.object({
  dimension: z.string().trim().max(120).optional(),
  position: z
    .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
    .optional(),
  kinds: z.array(worldMemoryKindSchema).max(9).optional(),
  limit: z.number().int().min(1).max(32).default(8),
});
export type WorldMemoryQuery = z.infer<typeof worldMemoryQuerySchema>;

export const worldMemoryUpdateSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(160).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  z: z.number().finite().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type WorldMemoryUpdate = z.infer<typeof worldMemoryUpdateSchema>;

/**
 * A strategy outcome is deliberately smaller than the audience memory store:
 * it is a scoreboard over deterministic strategy keys, not prose the model
 * may rewrite. Conditions explain when a failure happened.
 */
export const strategyMemorySchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  strategyKey: z.string().trim().min(1).max(400),
  stage: z.string().trim().min(1).max(80),
  cardId: z.string().trim().max(80).nullable().default(null),
  successCount: z.number().int().nonnegative().default(0),
  failureCount: z.number().int().nonnegative().default(0),
  lastFailureCode: z.string().trim().max(64).nullable().default(null),
  lastFailureDetail: z.string().trim().max(600).nullable().default(null),
  lastOutcomeAt: z.number().int().nonnegative().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.6),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type StrategyMemory = z.infer<typeof strategyMemorySchema>;

export const strategyMemoryDraftSchema = z.object({
  strategyKey: z.string().trim().min(1).max(400),
  stage: z.string().trim().min(1).max(80),
  cardId: z.string().trim().max(80).nullable().default(null),
  ok: z.boolean(),
  failureCode: z.string().trim().max(64).nullable().default(null),
  failureDetail: z.string().trim().max(600).nullable().default(null),
  at: z.number().int().nonnegative(),
});
export type StrategyMemoryDraft = z.infer<typeof strategyMemoryDraftSchema>;
