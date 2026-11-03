import { z } from "zod";
import { actionStatusSchema, bridgeErrorCodeSchema } from "./bridge.ts";
import { skillNameSchema } from "./skills.ts";
import { prioritySchema } from "./decision.ts";

/**
 * One row of the replay timeline. Everything the operator needs to answer
 * "why did the character do that" hangs off a single `traceId`, which is the
 * platform event id stored with the source row.
 */
export const timelineEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("source"),
    at: z.number().int().nonnegative(),
    sourceId: z.string().min(1),
    traceId: z.string(),
    eventKind: z.enum(["comment", "gift", "like", "enter", "viewer_count", "operator", "world", "system"]),
    actor: z.string().nullable(),
    /** Null once the 24h retention sweep has blanked the raw text. */
    text: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("decision"),
    at: z.number().int().nonnegative(),
    decisionId: z.string().min(1),
    traceId: z.string(),
    decision: z.enum(["IGNORE", "OBSERVE", "ACK_ONLY", "QUEUE", "EXECUTE", "REFUSE"]),
    intent: z.string(),
    priority: prioritySchema,
    stage: z.enum(["rules", "scored", "planned"]),
    reason: z.string(),
    skill: skillNameSchema.nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("commitment"),
    at: z.number().int().nonnegative(),
    commitmentId: z.string().min(1),
    status: z.enum([
      "proposed",
      "spoken",
      "accepted",
      "in_progress",
      "fulfilled",
      "expired",
      "broken",
      "cancelled",
    ]),
    utterance: z.string(),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal("action"),
    at: z.number().int().nonnegative(),
    actionId: z.string().min(1),
    decisionId: z.string().min(1),
    skill: z.string().min(1),
    status: actionStatusSchema,
    errorCode: bridgeErrorCodeSchema.nullable(),
  }),
]);
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const sessionSummarySchema = z.object({
  id: z.string().min(1),
  sessionNo: z.number().int().positive(),
  goal: z.string(),
  status: z.enum(["planned", "live", "ended", "aborted"]),
  startedAt: z.number().int().nonnegative().nullable(),
  endedAt: z.number().int().nonnegative().nullable(),
  decisions: z.number().int().nonnegative(),
  openCommitments: z.number().int().nonnegative(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
