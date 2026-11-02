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

export const decisionSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  nickname: z.string(),
  text: z.string(),
  intent: intentSchema,
  decision: decisionKindSchema,
  reason: z.string(),
  score: z.number(),
  stage: z.enum(["rules", "scored", "planned"]),
  at: z.number(),
});
export type Decision = z.infer<typeof decisionSchema>;

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
