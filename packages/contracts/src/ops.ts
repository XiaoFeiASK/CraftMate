import { z } from "zod";
import { ownershipSchema, worldSnapshotSchema } from "./bridge.ts";
import { budgetSchema, memorySchema, reviewCandidateSchema, personaVersionSchema } from "./memory.ts";
import { personaProfileSchema } from "./settings.ts";
import { timelineEntrySchema } from "./replay.ts";

export const bridgeHealthSchema = z.object({
  connected: z.boolean(),
  client: z.string().nullable(),
  owner: ownershipSchema,
  world: worldSnapshotSchema.nullable().default(null),
  permission: z.enum(["agent", "operator", "stopped"]),
  generation: z.number().int().positive(),
  skills: z.array(z.string()).readonly(),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  tick: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  watchdogMs: z.number().int().nonnegative(),
});
export type BridgeHealth = z.infer<typeof bridgeHealthSchema>;

/** Everything the operator pages read in one shot, so one request refills all. */
export const opsSnapshotSchema = z.object({
  memories: z.array(memorySchema),
  candidates: z.array(reviewCandidateSchema),
  personaVersions: z.array(
    personaVersionSchema.extend({ content: z.record(z.unknown()) }),
  ),
  budget: budgetSchema,
});
export type OpsSnapshot = z.infer<typeof opsSnapshotSchema>;

export const opsRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refresh") }),
  z.object({ kind: z.literal("approveMemory"), candidateId: z.string().min(1) }),
  z.object({ kind: z.literal("rejectMemory"), candidateId: z.string().min(1), reason: z.string().min(1) }),
  z.object({ kind: z.literal("forgetMemory"), memoryId: z.string().min(1) }),
  z.object({ kind: z.literal("draftPersona"), persona: personaProfileSchema }),
  z.object({ kind: z.literal("activatePersona"), versionId: z.string().min(1) }),
]);
export type OpsRequest = z.infer<typeof opsRequestSchema>;

export const replayRequestSchema = z.object({
  traceId: z.string().min(1),
});
export type ReplayRequest = z.infer<typeof replayRequestSchema>;

export const replayResponseSchema = z.object({
  traceId: z.string().min(1),
  entries: z.array(timelineEntrySchema),
});
export type ReplayResponse = z.infer<typeof replayResponseSchema>;

export const sessionListSchema = z.array(
  z.object({
    id: z.string().min(1),
    sessionNo: z.number().int().positive(),
    goal: z.string(),
    status: z.enum(["planned", "live", "ended", "aborted"]),
    startedAt: z.number().int().nonnegative().nullable(),
    endedAt: z.number().int().nonnegative().nullable(),
    decisions: z.number().int().nonnegative(),
    openCommitments: z.number().int().nonnegative(),
  }),
);
export type SessionList = z.infer<typeof sessionListSchema>;
