import { TERMINAL_STATUSES, canTransition, type CommitmentStatus } from "./status.ts";

export interface Commitment {
  readonly id: string;
  readonly utterance: string;
  readonly status: CommitmentStatus;
  readonly createdAt: number;
  readonly deadlineAt: number | null;
  readonly planId: string | null;
  readonly closedAt: number | null;
}

export interface ReserveCommitment {
  readonly utterance: string;
  readonly deadlineAt?: number | null;
  readonly planId?: string | null;
}

export interface LedgerDeps {
  readonly now?: () => number;
  readonly newId?: () => string;
}

/**
 * Records promises before they are spoken. In-memory for M0; the application
 * layer will swap in a SQLite-backed implementation behind the same methods.
 */
export class CommitmentLedger {
  private readonly items = new Map<string, Commitment>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: LedgerDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  reserve(input: ReserveCommitment): Commitment {
    const commitment: Commitment = {
      id: this.newId(),
      utterance: input.utterance,
      status: "proposed",
      createdAt: this.now(),
      deadlineAt: input.deadlineAt ?? null,
      planId: input.planId ?? null,
      closedAt: null,
    };
    this.items.set(commitment.id, commitment);
    return commitment;
  }

  transition(id: string, next: CommitmentStatus): Commitment {
    const current = this.items.get(id);
    if (!current) throw new Error(`unknown commitment ${id}`);
    if (!canTransition(current.status, next)) {
      throw new Error(`illegal transition ${current.status} -> ${next}`);
    }

    const updated: Commitment = {
      ...current,
      status: next,
      closedAt: TERMINAL_STATUSES.has(next) ? this.now() : null,
    };
    this.items.set(id, updated);
    return updated;
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
