import { z } from "zod";
import { prioritySchema, skillNameSchema } from "./decision.ts";

export { skillNameSchema, type SkillName } from "./decision.ts";

export const skillCommandSchema = z.object({
  v: z.literal(1),
  type: z.literal("cmd"),
  id: z.string(),
  op: skillNameSchema,
  args: z.record(z.unknown()),
  deadlineTick: z.number().int().optional(),
  priority: prioritySchema,
  idempotencyKey: z.string(),
});
export type SkillCommand = z.infer<typeof skillCommandSchema>;

export const worldEventSchema = z.object({
  v: z.literal(1),
  type: z.literal("event"),
  seq: z.number().int(),
  tick: z.number().int(),
  name: z.string(),
  data: z.record(z.unknown()),
});
export type WorldEvent = z.infer<typeof worldEventSchema>;

export const actionStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "preempted",
  "cancelled",
  "failed",
  "timeout",
]);
export type ActionStatus = z.infer<typeof actionStatusSchema>;

export const bridgeErrorCodeSchema = z.enum([
  "E_SCHEMA",
  "E_UNKNOWN_OP",
  "E_PRECONDITION",
  "E_BUSY",
  "E_TIMEOUT",
  "E_CANCELLED",
  "E_WORLD_CHANGED",
  "E_PERMISSION",
  "E_INTERNAL",
]);
export type BridgeErrorCode = z.infer<typeof bridgeErrorCodeSchema>;
