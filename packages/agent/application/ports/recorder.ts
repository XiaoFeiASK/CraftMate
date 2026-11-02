import type { AudienceEvent, Decision } from "@craftmate/contracts";

/**
 * Write side of a show. Implemented by the storage package; the domain never
 * imports SQLite so it stays testable with a plain object.
 */
export interface ShowRecorder {
  /** False means the event was already recorded and must not be decided again. */
  recordSource(event: AudienceEvent): boolean;
  recordDecision(decision: Decision): void;
}
