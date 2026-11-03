import type { Memory, MemoryDraft, RecalledMemory } from "@craftmate/contracts";

/**
 * Read/write port for approved memory. Recall only ever returns approved,
 * active rows; the planner must not be able to widen that set.
 */
export interface MemoryPort {
  /** Approved memories that match the audience reference, oldest first. */
  recall(options: {
    readonly subjectRef: string;
    readonly query: string;
    readonly budgetTokens: number;
  }): readonly RecalledMemory[];
  /** Create a pending candidate; it is not recallable until reviewed. */
  propose(draft: MemoryDraft, sessionId: string | null): string;
  list(state?: Memory["state"]): readonly Memory[];
}
