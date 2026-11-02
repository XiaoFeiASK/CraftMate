import { z } from "zod";

/**
 * The slice of dyhub's `DanmakuEvent` we consume. Deliberately loose: the
 * upstream project adds fields over time and an unknown extra key must not
 * drop a real comment.
 */
export const danmakuUserSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  nickname: z.string().optional(),
});

export const danmakuEventSchema = z.object({
  id: z.string().min(1),
  roomId: z.string().optional(),
  type: z.string(),
  ts: z.number().optional(),
  receivedAt: z.number().optional(),
  user: danmakuUserSchema.optional(),
  data: z.record(z.unknown()).optional(),
  rawMethod: z.string().optional(),
});
export type DanmakuEvent = z.infer<typeof danmakuEventSchema>;

/** Control frames dyhub sends before and during a subscription. */
export const dyhubStatusSchema = z.object({
  type: z.enum(["__hello", "__connecting", "__connected", "__error"]),
  roomId: z.string().optional(),
  error: z.string().optional(),
});
