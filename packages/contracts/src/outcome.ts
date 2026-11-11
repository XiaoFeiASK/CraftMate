import { z } from "zod";

/**
 * What a skill actually achieved, as opposed to what the body was told to do.
 * Kept in its own module so a decision and a bridge result can both describe
 * an outcome without importing each other at runtime.
 *
 * - `changes` are confirmed world or inventory facts.
 * - `unconfirmed` are submissions whose effect could not be proven; retrying
 *   them may duplicate a side effect, so they are reported instead of hidden.
 * - `attempts` records the failed strategies an agent should not repeat.
 */
export const skillOutcomeSchema = z.object({
  summary: z.string().min(1).max(600).optional(),
  changes: z
    .array(
      z.object({
        kind: z.string().min(1).max(40),
        detail: z.string().min(1).max(240),
        position: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
      }),
    )
    .max(64)
    .optional(),
  unconfirmed: z.array(z.string().min(1).max(240)).max(16).optional(),
  attempts: z.array(z.string().min(1).max(240)).max(16).optional(),
  problem: z.string().min(1).max(600).optional(),
  /**
   * Partial progress for a segmented long task. A body that stops at its
   * budget reports what it finished, what remains, and whether the same
   * command can be resumed without duplicating side effects.
   */
  progress: z
    .object({
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative().optional(),
      unit: z.string().trim().min(1).max(24).optional(),
    })
    .optional(),
  remaining: z.string().trim().min(1).max(240).optional(),
  resumable: z.boolean().optional(),
  nextHint: z.string().trim().min(1).max(240).optional(),
});
export type SkillOutcome = z.infer<typeof skillOutcomeSchema>;
