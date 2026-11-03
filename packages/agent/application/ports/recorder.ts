import type { AudienceEvent, Decision } from "@craftmate/contracts";

/**
 * Write side of a show. Implemented by the storage package; the domain never
 * imports SQLite so it stays testable with a plain object.
 */
export interface ShowRecorder {
  /** False means the event was already recorded and must not be decided again. */
  recordSource(event: AudienceEvent): boolean;
  recordDecision(decision: Decision): void;
  /**
   * Stage C rewrites the same decision row in place. Optional so an in-memory
   * recorder does not have to implement a second write path.
   */
  updateDecision?(decision: Decision): void;
  /**
   * Retrieves the stored source_id for a given external event id. Used when
   * reserving commitments so they can be traced back to their originating event.
   */
  findSourceId?(eventId: string): string | undefined;
}
