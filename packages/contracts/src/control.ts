import { z } from "zod";
import { audienceEventSchema, sourceHealthSchema } from "./audience.ts";
import { decisionSchema } from "./decision.ts";
import {
  integrationSettingsUpdateSchema,
  integrationSettingsViewSchema,
  showSettingsSchema,
} from "./settings.ts";
import { voiceStatusSchema, voiceSubtitleSchema } from "./voice.ts";
import { bridgeHealthSchema, opsRequestSchema, opsSnapshotSchema } from "./ops.ts";
import { timelineEntrySchema } from "./replay.ts";

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
  /** Every decision produced, including IGNORE / ACK_ONLY / QUEUE. */
  decided: z.number().int().nonnegative(),
  executed: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  openCommitments: z.number().int().nonnegative(),
});
export type ShowStats = z.infer<typeof showStatsSchema>;

export const modelConnectionSchema = z.object({
  state: z.enum(["unverified", "ready", "error", "disabled"]),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  detail: z.string().default(""),
});
export type ModelConnection = z.infer<typeof modelConnectionSchema>;

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
  voiceStatus: voiceStatusSchema.nullable().default(null),
  bridge: bridgeHealthSchema.nullable().default(null),
  model: modelConnectionSchema.nullable().default(null),
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
  z.object({ type: z.literal("settings"), payload: showSettingsSchema }),
  z.object({
    type: z.literal("settingsSave"),
    payload: z.object({
      settings: showSettingsSchema,
      integrations: integrationSettingsUpdateSchema,
    }),
  }),
  z.object({
    type: z.literal("speak"),
    payload: z.object({ text: z.string().trim().min(1).max(2_000) }),
  }),
  z.object({ type: z.literal("ops"), payload: opsRequestSchema }),
  z.object({ type: z.literal("replay"), payload: z.object({ traceId: z.string().min(1) }) }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    payload: z.object({
      persona: personaSummarySchema,
      snapshot: showSnapshotSchema,
      settings: showSettingsSchema,
      integrations: integrationSettingsViewSchema,
    }),
  }),
  z.object({ type: z.literal("decision"), payload: decisionSchema }),
  z.object({ type: z.literal("stats"), payload: showStatsSchema }),
  z.object({ type: z.literal("snapshot"), payload: showSnapshotSchema }),
  z.object({ type: z.literal("operator"), payload: operatorCommandSchema }),
  z.object({ type: z.literal("source"), payload: sourceHealthSchema }),
  z.object({ type: z.literal("settings"), payload: showSettingsSchema }),
  z.object({ type: z.literal("integrations"), payload: integrationSettingsViewSchema }),
  z.object({ type: z.literal("voice"), payload: voiceStatusSchema }),
  z.object({ type: z.literal("subtitle"), payload: voiceSubtitleSchema }),
  z.object({ type: z.literal("bridge"), payload: bridgeHealthSchema }),
  z.object({
    type: z.literal("world"),
    payload: z.object({
      name: z.string().min(1).max(64),
      data: z.unknown(),
      at: z.number().int().nonnegative(),
    }),
  }),
  z.object({ type: z.literal("ops"), payload: opsSnapshotSchema }),
  z.object({
    type: z.literal("replay"),
    payload: z.object({ traceId: z.string().min(1), entries: z.array(timelineEntrySchema) }),
  }),
  z.object({
    type: z.literal("error"),
    payload: z.object({ code: z.string(), detail: z.string() }),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** Body event as it appears in the control console. */
export type BodyEvent = Extract<ServerMessage, { type: "world" }>["payload"];
