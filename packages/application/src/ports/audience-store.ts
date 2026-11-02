import type { AudienceHistory } from "@craftmate/domain";
import type { Intent } from "@craftmate/protocol";

/**
 * Remembers recent audience activity for cooldown and quorum.
 * A SQLite implementation will replace the in-memory one without touching
 * the arbitration rules.
 */
export interface AudienceStore extends AudienceHistory {
  recordCommand(userId: string, intent: Intent, at: number): void;
}
