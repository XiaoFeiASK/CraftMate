import { z } from "zod";

export const decisionKindSchema = z.enum([
  "IGNORE",
  "OBSERVE",
  "ACK_ONLY",
  "QUEUE",
  "EXECUTE",
  "REFUSE",
]);
export type DecisionKind = z.infer<typeof decisionKindSchema>;

export const intentSchema = z.enum([
  "move",
  "mine",
  "build",
  "craft",
  "eat",
  "follow",
  "chat",
  "danger",
  "spam",
  "unknown",
]);
export type Intent = z.infer<typeof intentSchema>;

export const prioritySchema = z.enum([
  "reflex",
  "operator",
  "safety",
  "promise",
  "plan",
  "vote",
  "command",
  "ambient",
]);
export type Priority = z.infer<typeof prioritySchema>;

export const skillNameSchema = z.enum([
  "goto",
  "follow",
  "flee",
  "look_at",
  "mine_block",
  "chop_tree",
  "collect_items",
  "craft",
  "equip",
  "eat",
  "deposit",
  "place_block",
  "build_schematic",
  "attack",
  "use_block",
  "sleep",
  "say",
  "emote",
  "wait",
]);
export type SkillName = z.infer<typeof skillNameSchema>;

/**
 * A concrete skill invocation. Only `EXECUTE` decisions carry one; the fields
 * map one-to-one onto `bridge.ts` `cmd`, so the orchestrator never invents a
 * second shape in between.
 */
export const skillCallSchema = z.object({
  name: skillNameSchema,
  args: z.record(z.unknown()),
  deadlineTicks: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1),
});
export type SkillCall = z.infer<typeof skillCallSchema>;

export const decisionSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  nickname: z.string(),
  text: z.string(),
  intent: intentSchema,
  decision: decisionKindSchema,
  priority: prioritySchema,
  reason: z.string(),
  score: z.number(),
  stage: z.enum(["rules", "scored", "planned"]),
  skill: skillCallSchema.nullable().default(null),
  at: z.number(),
});
export type Decision = z.infer<typeof decisionSchema>;
