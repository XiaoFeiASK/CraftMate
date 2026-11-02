import type { Intent } from "@craftmate/protocol";

/**
 * Remembers recent audience activity for cooldown and quorum.
 * A SQLite implementation will replace the in-memory one without touching
 * the arbitration rules.
 */
export interface AudienceStore {
  lastCommandAt(userId: string): number | null;
  recentIntentCount(intent: Intent, windowMs: number): number;
  recordCommand(userId: string, intent: Intent, at: number): void;
}
