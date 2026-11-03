import { z } from "zod";
import { skillCallSchema, skillNameSchema, type SkillCall, type SkillName } from "./skills.ts";

export { skillCallSchema, skillNameSchema };
export type { SkillCall, SkillName };

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

/**
 * Model provenance for a planned decision. Absent for rules and scored
 * decisions, which never call a provider.
 */
export const decisionTraceSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  latencyMs: z.number().int().nonnegative(),
  /** True when the model failed and the template was used instead. */
  degraded: z.boolean(),
  detail: z.string().default(""),
});
export type DecisionTrace = z.infer<typeof decisionTraceSchema>;

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
  /** What the agent intends to say out loud, before the voice splits it. */
  speech: z.string().max(2_000).default(""),
  /** Stable hashed audience reference; never the raw platform user id. */
  audienceRef: z.string().default(""),
  trace: decisionTraceSchema.nullable().default(null),
  at: z.number(),
});
export type Decision = z.infer<typeof decisionSchema>;
