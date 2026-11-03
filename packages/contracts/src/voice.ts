import { z } from "zod";
import { prioritySchema } from "./decision.ts";

/** Short spoken units keep first-word latency and preemption predictable. */
export const MAX_UTTERANCE_CHARS = 35;

export const voiceStateSchema = z.enum([
  "idle",
  "speaking",
  "degraded",
  "disabled",
]);
export type VoiceState = z.infer<typeof voiceStateSchema>;

export const voiceProviderHealthSchema = z.object({
  id: z.string().min(1),
  state: z.enum(["ok", "degraded", "open"]),
  detail: z.string(),
  failures: z.number().int().nonnegative(),
  lastErrorAt: z.number().int().nonnegative().nullable(),
});
export type VoiceProviderHealth = z.infer<typeof voiceProviderHealthSchema>;

export const voiceStatusSchema = z.object({
  state: voiceStateSchema,
  detail: z.string(),
  queued: z.number().int().nonnegative(),
  spoken: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  providers: z.array(voiceProviderHealthSchema),
  lastSpokenAt: z.number().int().nonnegative().nullable(),
});
export type VoiceStatus = z.infer<typeof voiceStatusSchema>;

/**
 * Subtitle and audio share one utterance. `text` is the exact text sent to
 * TTS, so the console never has to reverse-engineer what was said.
 */
export const voiceUtteranceSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(MAX_UTTERANCE_CHARS),
  priority: prioritySchema,
  decisionId: z.string().min(1).nullable(),
  commitmentId: z.string().min(1).nullable(),
  at: z.number().int().nonnegative(),
});
export type VoiceUtterance = z.infer<typeof voiceUtteranceSchema>;

export const voiceEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("queued"),
    utterance: voiceUtteranceSchema,
    position: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("speaking"),
    utterance: voiceUtteranceSchema,
    startedAt: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("spoken"),
    utterance: voiceUtteranceSchema,
    finishedAt: z.number().int().nonnegative(),
    latencyMs: z.number().nonnegative().nullable(),
    provider: z.string().min(1).nullable(),
  }),
  z.object({
    type: z.literal("cancelled"),
    utterance: voiceUtteranceSchema,
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("failed"),
    utterance: voiceUtteranceSchema,
    code: z.string().min(1),
    detail: z.string(),
  }),
  z.object({ type: z.literal("status"), status: voiceStatusSchema }),
]);
export type VoiceEvent = z.infer<typeof voiceEventSchema>;

/**
 * Console projection of one utterance. Audio and subtitle are driven by the
 * same `VoiceEvent`, so the operator never sees a line that was not spoken
 * (or at least attempted).
 */
export const voiceSubtitleSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  state: z.enum(["speaking", "spoken", "failed", "cancelled"]),
  decisionId: z.string().min(1).nullable(),
  at: z.number().int().nonnegative(),
});
export type VoiceSubtitle = z.infer<typeof voiceSubtitleSchema>;

export const voiceCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("speak"),
    text: z.string().trim().min(1).max(2_000),
    priority: prioritySchema.default("plan"),
    decisionId: z.string().min(1).nullable().default(null),
    commitmentId: z.string().min(1).nullable().default(null),
  }),
  z.object({ type: z.literal("stop"), reason: z.string().min(1).default("operator stop") }),
  z.object({
    type: z.literal("limit"),
    maxBufferMs: z.number().int().nonnegative().optional(),
  }),
]);
export type VoiceCommand = z.infer<typeof voiceCommandSchema>;

export const voiceClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), token: z.string().min(1) }),
  z.object({
    type: z.literal("command"),
    payload: voiceCommandSchema,
  }),
]);
export type VoiceClientFrame = z.infer<typeof voiceClientFrameSchema>;

export const voiceServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    payload: z.object({
      status: voiceStatusSchema,
      heartbeatMs: z.number().int().positive(),
    }),
  }),
  z.object({ type: z.literal("event"), payload: voiceEventSchema }),
  z.object({ type: z.literal("status"), payload: voiceStatusSchema }),
  z.object({
    type: z.literal("error"),
    payload: z.object({ code: z.string(), detail: z.string() }),
  }),
]);
export type VoiceServerFrame = z.infer<typeof voiceServerFrameSchema>;

export const VOICE_CLOSE_UNAUTHORIZED = 4401;
export const VOICE_CLOSE_REMOTE = 4403;
