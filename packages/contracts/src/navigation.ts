import { z } from "zod";

export const navigationModeSchema = z.enum(["walk", "dig", "recover"]);
export type NavigationMode = z.infer<typeof navigationModeSchema>;

/**
 * A short-lived goal target. Entity locks stop a moving animal from causing
 * two nearby targets to alternate; explore locks keep one sweep leg stable.
 */
export const targetLockSchema = z.object({
  kind: z.enum(["entity", "explore"]),
  ref: z.string().trim().min(1).max(200),
  dimension: z.string().trim().min(1).max(120),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  cardId: z.string().trim().max(80).nullable().default(null),
  lockedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
export type TargetLock = z.infer<typeof targetLockSchema>;

export const routeBlacklistKindSchema = z.enum([
  "entity",
  "point",
  "region",
  "hazard",
]);
export type RouteBlacklistKind = z.infer<typeof routeBlacklistKindSchema>;

export const routeBlacklistSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1).nullable().default(null),
  dimension: z.string().trim().min(1).max(120),
  kind: routeBlacklistKindSchema,
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  radius: z.number().min(0).max(128),
  targetRef: z.string().trim().max(200).nullable().default(null),
  reasonCode: z.string().trim().min(1).max(64),
  reasonDetail: z.string().trim().max(600).nullable().default(null),
  source: z.enum(["body", "agent", "operator"]).default("agent"),
  expiresAt: z.number().int().nonnegative().nullable().default(null),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type RouteBlacklist = z.infer<typeof routeBlacklistSchema>;

export const routeBlacklistDraftSchema = z.object({
  dimension: z.string().trim().min(1).max(120),
  kind: routeBlacklistKindSchema,
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  radius: z.number().min(0).max(128),
  targetRef: z.string().trim().max(200).nullable().default(null),
  reasonCode: z.string().trim().min(1).max(64),
  reasonDetail: z.string().trim().max(600).nullable().default(null),
  source: z.enum(["body", "agent", "operator"]).default("agent"),
  expiresAt: z.number().int().nonnegative().nullable().default(null),
});
export type RouteBlacklistDraft = z.infer<typeof routeBlacklistDraftSchema>;

export const routeBlacklistQuerySchema = z.object({
  dimension: z.string().trim().max(120).optional(),
  position: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      z: z.number().finite(),
    })
    .optional(),
  includeExpired: z.boolean().default(false),
  limit: z.number().int().min(1).max(256).default(64),
});
export type RouteBlacklistQuery = z.infer<typeof routeBlacklistQuerySchema>;
export type RouteBlacklistQueryInput = z.input<typeof routeBlacklistQuerySchema>;

export function routeBlacklistCovers(
  entry: RouteBlacklist,
  point: { readonly x: number; readonly y: number; readonly z: number },
  now = Date.now(),
): boolean {
  if (entry.expiresAt !== null && entry.expiresAt <= now) return false;
  const dx = entry.x - point.x;
  const dz = entry.z - point.z;
  const dy = Math.abs(entry.y - point.y);
  return Math.hypot(dx, dz) <= entry.radius && (entry.kind === "region" || dy <= 4);
}
