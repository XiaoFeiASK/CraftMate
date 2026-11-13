import { z } from "zod";
import { ownershipSchema, worldSnapshotSchema } from "./bridge.ts";
import { budgetSchema, memorySchema, reviewCandidateSchema, personaVersionSchema } from "./memory.ts";
import { personaProfileSchema } from "./settings.ts";
import { timelineEntrySchema } from "./replay.ts";
import {
  strategyMemorySchema,
  worldMemorySchema,
  worldMemoryUpdateSchema,
} from "./world-memory.ts";
import { routeBlacklistSchema } from "./navigation.ts";

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
  /**
   * Reflex and safety facts the body observed, oldest first. They are facts,
   * not commands: the console shows them so an operator can reconstruct why
   * the agent stopped or fled without reading the game log.
   */
  incidents: z
    .array(
      z.object({
        kind: z.enum([
          "lava",
          "low_health",
          "falling",
          "drowning",
          "on_fire",
          "starving",
          "creeper",
          "threat",
          "retreat",
          "blocked",
        ]),
        detail: z.string(),
        at: z.number().int().nonnegative(),
      }),
    )
    .readonly()
    .default([]),
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
  worldMemories: z.array(worldMemorySchema).optional(),
  strategyMemories: z.array(strategyMemorySchema).optional(),
  routeBlacklists: z.array(routeBlacklistSchema).optional(),
});
export type OpsSnapshot = z.infer<typeof opsSnapshotSchema>;

export const opsRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refresh") }),
  z.object({ kind: z.literal("approveMemory"), candidateId: z.string().min(1) }),
  z.object({ kind: z.literal("rejectMemory"), candidateId: z.string().min(1), reason: z.string().min(1) }),
  z.object({ kind: z.literal("forgetMemory"), memoryId: z.string().min(1) }),
  z.object({ kind: z.literal("draftPersona"), persona: personaProfileSchema }),
  z.object({ kind: z.literal("activatePersona"), versionId: z.string().min(1) }),
  z.object({ kind: z.literal("updateWorldMemory"), memory: worldMemoryUpdateSchema }),
  z.object({ kind: z.literal("forgetWorldMemory"), memoryId: z.string().min(1) }),
  z.object({ kind: z.literal("forgetStrategyMemory"), memoryId: z.string().min(1) }),
  z.object({ kind: z.literal("forgetRouteBlacklist"), blacklistId: z.string().min(1) }),
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
