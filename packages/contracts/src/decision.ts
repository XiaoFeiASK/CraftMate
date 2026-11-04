import { z } from "zod";
import { skillCallSchema, skillNameSchema, type SkillCall, type SkillName } from "./skills.ts";
import { skillOutcomeSchema, type SkillOutcome } from "./outcome.ts";

export { skillCallSchema, skillNameSchema };
export type { SkillCall, SkillName };
export { skillOutcomeSchema };
export type { SkillOutcome };

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

/**
 * The skill's own ending, attached to the decision that authorised it. Until
 * this is set, "the agent decided to act" is all the console can honestly say;
 * after it is set, success and evidence can be told apart from a bare ack.
 */
export const decisionOutcomeSchema = z.object({
  status: z.enum(["completed", "failed", "timeout", "cancelled", "preempted"]),
  errorCode: z.string().min(1).max(64).optional(),
  detail: z.string().max(600).optional(),
  outcome: skillOutcomeSchema.nullable().default(null),
  at: z.number().int().nonnegative(),
});
export type DecisionOutcome = z.infer<typeof decisionOutcomeSchema>;

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
  /**
   * Filled by the bridge when the body settles the skill. Optional on input
   * so a scored decision produced before any skill exists stays constructible
   * without inventing an outcome.
   */
  outcome: decisionOutcomeSchema.nullable().optional(),
  at: z.number(),
});
export type Decision = z.infer<typeof decisionSchema>;
