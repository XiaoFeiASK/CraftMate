import { z } from "zod";
import { audienceEventSchema, sourceHealthSchema } from "./audience.ts";
import { decisionSchema } from "./decision.ts";

export const showModeSchema = z.enum(["agent", "operator", "stopped"]);
export type ShowMode = z.infer<typeof showModeSchema>;

export const operatorKindSchema = z.enum(["whisper", "takeover", "release", "stop"]);
export type OperatorKind = z.infer<typeof operatorKindSchema>;

export const operatorCommandSchema = z.object({
  kind: operatorKindSchema,
  text: z.string(),
});
export type OperatorCommand = z.infer<typeof operatorCommandSchema>;

export const showStatsSchema = z.object({
  received: z.number().int().nonnegative(),
  executed: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  openCommitments: z.number().int().nonnegative(),
});
export type ShowStats = z.infer<typeof showStatsSchema>;

export const operatorNoticeSchema = z.object({
  kind: operatorKindSchema,
  text: z.string(),
  detail: z.string(),
  at: z.number().int().nonnegative(),
});
export type OperatorNotice = z.infer<typeof operatorNoticeSchema>;

export const showSnapshotSchema = z.object({
  mode: showModeSchema,
  stats: showStatsSchema,
  decisions: z.array(decisionSchema).readonly(),
  operatorNotice: operatorNoticeSchema.nullable(),
  sourceHealth: sourceHealthSchema.nullable().default(null),
});
export type ShowSnapshot = z.infer<typeof showSnapshotSchema>;

/**
 * Wire projection of the persona. The console only needs identity and the
 * weights it renders, so the full domain persona never crosses this boundary.
 */
export const personaSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  identity: z.string().min(1),
  weights: z.record(z.number()),
});
export type PersonaSummary = z.infer<typeof personaSummarySchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello") }),
  z.object({ type: z.literal("comment"), payload: audienceEventSchema }),
  z.object({ type: z.literal("operator"), payload: operatorCommandSchema }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    payload: z.object({
      persona: personaSummarySchema,
      snapshot: showSnapshotSchema,
    }),
  }),
  z.object({ type: z.literal("decision"), payload: decisionSchema }),
  z.object({ type: z.literal("stats"), payload: showStatsSchema }),
  z.object({ type: z.literal("snapshot"), payload: showSnapshotSchema }),
  z.object({ type: z.literal("operator"), payload: operatorCommandSchema }),
  z.object({ type: z.literal("source"), payload: sourceHealthSchema }),
  z.object({
    type: z.literal("error"),
    payload: z.object({ code: z.string(), detail: z.string() }),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
