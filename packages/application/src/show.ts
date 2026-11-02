import { audienceEventSchema, type AudienceEvent, type Decision } from "@craftmate/protocol";
import {
  Arbiter,
  CommitmentLedger,
  type Persona,
} from "@craftmate/domain";
import type { AudienceStore } from "./ports/audience-store.ts";
import type { Clock } from "./ports/clock.ts";
import { systemClock } from "./ports/clock.ts";
import type { OperatorCommand, ShowMode } from "./operator.ts";

export interface ShowStats {
  readonly received: number;
  readonly executed: number;
  readonly refused: number;
  readonly observed: number;
  readonly openCommitments: number;
}

export interface ShowSnapshot {
  readonly mode: ShowMode;
  readonly stats: ShowStats;
  readonly decisions: readonly Decision[];
}

const MAX_DECISIONS = 200;

export class MemoryAudienceStore implements AudienceStore {
  private readonly lastCommand = new Map<string, number>();
  private readonly intentTimes = new Map<string, number[]>();
  private readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  lastCommandAt(userId: string): number | null {
    return this.lastCommand.get(userId) ?? null;
  }

  recentIntentCount(intent: string, windowMs: number): number {
    const cutoff = this.clock.now() - windowMs;
    const recent = (this.intentTimes.get(intent) ?? []).filter((at) => at > cutoff);
    this.intentTimes.set(intent, recent);
    return recent.length;
  }

  recordCommand(userId: string, intent: string, at: number): void {
    this.lastCommand.set(userId, at);
    const times = this.intentTimes.get(intent) ?? [];
    times.push(at);
    this.intentTimes.set(intent, times);
  }
}

interface ShowOptions {
  readonly persona: Persona;
  readonly clock?: Clock;
  readonly audience?: AudienceStore;
  readonly ledger?: CommitmentLedger;
}

/**
 * The live show: ingest audience events, arbitrate, and expose a read model.
 * No transport, storage, or model code lives here.
 */
export class Show {
  private readonly persona: Persona;
  private readonly clock: Clock;
  private readonly audience: AudienceStore;
  readonly ledger: CommitmentLedger;
  private readonly arbiter: Arbiter;
  private readonly decisions: Decision[] = [];
  private readonly seen = new Set<string>();
  private received = 0;
  private executed = 0;
  private refused = 0;
  private observed = 0;
  private mode: ShowMode = "agent";

  constructor(options: ShowOptions) {
    this.persona = options.persona;
    this.clock = options.clock ?? systemClock;
    this.audience = options.audience ?? new MemoryAudienceStore(this.clock);
    this.ledger = options.ledger ?? new CommitmentLedger();
    this.arbiter = new Arbiter({
      persona: this.persona,
      history: this.audience,
      clock: this.clock,
    });
  }

  /** Returns null for malformed or duplicate events. */
  ingest(raw: unknown): Decision | null {
    const parsed = audienceEventSchema.safeParse(raw);
    if (!parsed.success || this.seen.has(parsed.data.id)) return null;

    const event = parsed.data;
    this.seen.add(event.id);
    this.received += 1;
    if (this.mode !== "agent") return null;

    const { decision } = this.arbiter.evaluate(event);
    this.remember(decision);
    this.audience.recordCommand(event.userId, decision.intent, this.clock.now());
    this.count(decision);
    return decision;
  }

  readonly personaCard = (): Persona => this.persona;

  applyOperator(command: OperatorCommand): ShowMode {
    switch (command.kind) {
      case "takeover":
        this.mode = "operator";
        break;
      case "release":
        this.mode = "agent";
        break;
      case "stop":
        this.mode = "stopped";
        break;
      default:
        break;
    }
    return this.mode;
  }

  recent(): readonly Decision[] {
    return [...this.decisions];
  }

  snapshot(): ShowSnapshot {
    return {
      mode: this.mode,
      stats: {
        received: this.received,
        executed: this.executed,
        refused: this.refused,
        observed: this.observed,
        openCommitments: this.ledger.open().length,
      },
      decisions: this.recent(),
    };
  }

  private remember(decision: Decision): void {
    this.decisions.unshift(decision);
    if (this.decisions.length > MAX_DECISIONS) this.decisions.pop();
  }

  private count(decision: Decision): void {
    switch (decision.decision) {
      case "EXECUTE":
        this.executed += 1;
        break;
      case "REFUSE":
        this.refused += 1;
        break;
      case "OBSERVE":
        this.observed += 1;
        break;
      default:
        break;
    }
  }
}

export type { AudienceEvent };
