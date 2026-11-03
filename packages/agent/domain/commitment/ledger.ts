import { TERMINAL_STATUSES, canTransition, type CommitmentStatus } from "./status.ts";

export interface Commitment {
  readonly id: string;
  readonly audienceRef: string;
  readonly sourceId: string | null;
  readonly utterance: string;
  readonly status: CommitmentStatus;
  readonly revision: number;
  readonly createdAt: number;
  readonly deadlineAt: number | null;
  readonly planId: string | null;
  readonly spokenAt: number | null;
  readonly closedAt: number | null;
}

export interface ReserveCommitment {
  /** Opaque, already-hashed audience reference; never a raw platform user id. */
  readonly audienceRef: string;
  readonly sourceId?: string | null;
  readonly utterance: string;
  readonly deadlineAt?: number | null;
  readonly planId?: string | null;
}

export interface CommitmentTransition {
  readonly from: CommitmentStatus | null;
  readonly to: Commitment;
  readonly reason: string;
  /** Wall-clock time of the transition itself, not of the status it enters. */
  readonly at: number;
}

/**
 * Persistence boundary for the ledger. The write happens inside `transit`
 * before the in-memory state moves, so a promise can never be spoken (or
 * reported as open) unless it is already explainable from storage.
 */
export interface CommitmentJournal {
  /** Must persist both the initial row and its `null -> proposed` event. */
  reserve(commitment: Commitment): void;
  /** Must persist the new status and append exactly one status event. */
  transit(change: CommitmentTransition): void;
}

export interface LedgerDeps {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly journal?: CommitmentJournal;
}

/**
 * Records promises before they are spoken. In-memory for M0; the application
 * layer will swap in a SQLite-backed implementation behind the same methods.
 */
export class CommitmentLedger {
  private readonly items = new Map<string, Commitment>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly journal: CommitmentJournal | null;

  constructor(deps: LedgerDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.journal = deps.journal ?? null;
  }

  reserve(input: ReserveCommitment): Commitment {
    const commitment: Commitment = {
      id: this.newId(),
      audienceRef: input.audienceRef,
      sourceId: input.sourceId ?? null,
      utterance: input.utterance,
      status: "proposed",
      revision: 1,
      createdAt: this.now(),
      deadlineAt: input.deadlineAt ?? null,
      planId: input.planId ?? null,
      spokenAt: null,
      closedAt: null,
    };
    this.journal?.reserve(commitment);
    this.items.set(commitment.id, commitment);
    return commitment;
  }

  transition(id: string, next: CommitmentStatus, reason = "state transition"): Commitment {
    const current = this.items.get(id);
    if (!current) throw new Error(`unknown commitment ${id}`);
    if (!canTransition(current.status, next)) {
      throw new Error(`illegal transition ${current.status} -> ${next}`);
    }

    const updated: Commitment = {
      ...current,
      status: next,
      revision: current.revision + 1,
      spokenAt: next === "spoken" ? this.now() : current.spokenAt,
      closedAt: TERMINAL_STATUSES.has(next) ? this.now() : null,
    };
    this.journal?.transit({ from: current.status, to: updated, reason, at: this.now() });
    this.items.set(id, updated);
    return updated;
  }

  /**
   * Rehydrates the in-memory projection from storage. Duplicate ids or rows
   * outside the state machine's vocabulary are storage corruption, not a
   * recoverable condition, so they fail loudly.
   */
  restore(commitments: readonly Commitment[]): void {
    for (const commitment of commitments) {
      if (this.items.has(commitment.id)) {
        throw new Error(`duplicate commitment ${commitment.id} during restore`);
      }
      if (commitment.revision < 1) {
        throw new Error(`commitment ${commitment.id} has invalid revision ${commitment.revision}`);
      }
      this.items.set(commitment.id, commitment);
    }
  }

  get(id: string): Commitment | undefined {
    return this.items.get(id);
  }

  list(): readonly Commitment[] {
    return [...this.items.values()];
  }

  open(): readonly Commitment[] {
    return this.list().filter((item) => !TERMINAL_STATUSES.has(item.status));
  }
}
