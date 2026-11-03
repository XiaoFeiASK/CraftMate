import { z } from "zod";

export const memoryFamilySchema = z.enum([
  "viewer",
  "world",
  "experience",
  "procedure",
  "relationship",
]);
export type MemoryFamily = z.infer<typeof memoryFamilySchema>;

export const disclosureLevelSchema = z.enum(["full", "paraphrase", "hint", "silence"]);
export type DisclosureLevel = z.infer<typeof disclosureLevelSchema>;

export const memoryStateSchema = z.enum(["active", "forgotten", "merged", "retired"]);
export type MemoryState = z.infer<typeof memoryStateSchema>;

/**
 * One remembered fact. Evidence is a list of stored source ids, so a claim in
 * the stream can always be traced back to the comment that produced it.
 */
export const memorySchema = z.object({
  id: z.string().min(1),
  lineageId: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  subjectRef: z.string().min(1),
  family: memoryFamilySchema,
  content: z.string().trim().min(1).max(2_000),
  disclosure: disclosureLevelSchema,
  confidence: z.number().min(0).max(1),
  state: memoryStateSchema,
  revision: z.number().int().positive(),
  evidenceSourceIds: z.array(z.string()).readonly(),
  createdAt: z.number().int().nonnegative(),
});
export type Memory = z.infer<typeof memorySchema>;

/** Proposal for a new memory; it only becomes recallable after review. */
export const memoryDraftSchema = z.object({
  subjectRef: z.string().min(1),
  family: memoryFamilySchema,
  content: z.string().trim().min(1).max(2_000),
  disclosure: disclosureLevelSchema.default("paraphrase"),
  confidence: z.number().min(0).max(1).default(0.6),
  evidenceSourceIds: z.array(z.string()).default([]),
});
export type MemoryDraft = z.infer<typeof memoryDraftSchema>;

export const reviewKindSchema = z.enum(["experience", "skill", "persona"]);
export type ReviewKind = z.infer<typeof reviewKindSchema>;

export const reviewStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const reviewCandidateSchema = z.object({
  id: z.string().min(1),
  kind: reviewKindSchema,
  status: reviewStatusSchema,
  payload: z.record(z.unknown()),
  reviewer: z.string().nullable(),
  decisionReason: z.string().nullable(),
  expectedVersion: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative().nullable(),
});
export type ReviewCandidate = z.infer<typeof reviewCandidateSchema>;

/** A recalled memory plus the reason it was allowed into the prompt. */
export const recalledMemorySchema = z.object({
  memory: memorySchema,
  tokens: z.number().int().nonnegative(),
});
export type RecalledMemory = z.infer<typeof recalledMemorySchema>;

export const personaVersionStateSchema = z.enum(["active", "retired"]);

export const personaVersionSchema = z.object({
  id: z.string().min(1),
  personaId: z.string().min(1),
  revision: z.number().int().positive(),
  state: personaVersionStateSchema,
  createdAt: z.number().int().nonnegative(),
});
export type PersonaVersion = z.infer<typeof personaVersionSchema>;

/** Cost guard rails. Budgets are per rolling hour and per provider key. */
export const budgetSchema = z.object({
  hourlyLimit: z.number().nonnegative().default(0),
  keyLimit: z.number().nonnegative().default(0),
  spent: z.number().nonnegative().default(0),
  degraded: z.boolean().default(false),
  detail: z.string().default(""),
});
export type Budget = z.infer<typeof budgetSchema>;
