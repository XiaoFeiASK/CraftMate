import {
  audienceEventSchema,
  type AudienceEvent,
  type Decision,
  type Intent,
  type OperatorCommand,
  type OperatorNotice,
  type PersonaSummary,
  type ShowMode,
  type ShowSnapshot,
  type ShowStats,
  type SourceHealth,
} from "@craftmate/contracts";
import {
  Arbiter,
  CommitmentLedger,
  type Persona,
} from "../domain/index.ts";
import type { AudienceStore } from "./ports/audience-store.ts";
import type { Clock } from "./ports/clock.ts";
import { systemClock } from "./ports/clock.ts";
import type { ShowRecorder } from "./ports/recorder.ts";

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

  recentIntentCount(intent: Intent, windowMs: number): number {
    const cutoff = this.clock.now() - windowMs;
    const recent = (this.intentTimes.get(intent) ?? []).filter((at) => at > cutoff);
    this.intentTimes.set(intent, recent);
    return recent.length;
  }

  recordCommand(userId: string, intent: Intent, at: number): void {
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
  /** Absent means the show runs entirely in memory (tests, previews). */
  readonly recorder?: ShowRecorder;
  /** Restored on boot so a restart does not blank the console. */
  readonly history?: readonly Decision[];
  /** Totals restored with the history; they cannot be re-derived from 50 rows. */
  readonly totals?: ShowStats;
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
  private readonly recorder: ShowRecorder | null;
  private received: number;
  private decided: number;
  private executed: number;
  private refused: number;
  private observed: number;
  private mode: ShowMode = "agent";
  private operatorNotice: OperatorNotice | null = null;
  private sourceHealth: SourceHealth | null = null;

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
    this.recorder = options.recorder ?? null;
    if (options.history) this.decisions.push(...options.history);
    this.received = options.totals?.received ?? 0;
    this.decided = options.totals?.decided ?? 0;
    this.executed = options.totals?.executed ?? 0;
    this.refused = options.totals?.refused ?? 0;
    this.observed = options.totals?.observed ?? 0;
  }

  /** Returns null for malformed or duplicate events. */
  ingest(raw: unknown): Decision | null {
    const parsed = audienceEventSchema.safeParse(raw);
    if (!parsed.success || this.seen.has(parsed.data.id)) return null;

    const event = parsed.data;
    this.seen.add(event.id);
    this.received += 1;
    if (this.mode !== "agent") return null;

    // Evidence is written before arbitration: a decision with no stored source
    // cannot be traced, so it must not be produced at all.
    if (this.recorder && !this.recorder.recordSource(event)) return null;

    const { decision } = this.arbiter.evaluate(event);
    this.recorder?.recordDecision(decision);
    this.remember(decision);
    this.audience.recordCommand(event.userId, decision.intent, this.clock.now());
    this.count(decision);
    return decision;
  }

  personaSummary(): PersonaSummary {
    return {
      id: this.persona.id,
      name: this.persona.name,
      identity: this.persona.identity,
      weights: this.persona.weights,
    };
  }

  applyOperator(command: OperatorCommand): ShowMode {
    switch (command.kind) {
      case "takeover":
        this.mode = "operator";
        this.operatorNotice = this.notice(command, "操作员已接管，Agent 退到旁白");
        break;
      case "release":
        this.mode = "agent";
        this.operatorNotice = this.notice(command, "已交还 Agent");
        break;
      case "stop":
        this.mode = "stopped";
        this.operatorNotice = this.notice(command, "已急停，等待操作员恢复");
        break;
      case "whisper":
        this.operatorNotice = this.notice(
          command,
          "耳语已记录；模型接入后会进入 Agent 上下文，不会发到直播间",
        );
        break;
      default:
        break;
    }
    return this.mode;
  }

  /**
   * Access-link status, surfaced to the console. Health is explicitly not an
   * audience event: it never creates a decision.
   */
  setSourceHealth(health: SourceHealth): void {
    this.sourceHealth = health;
  }

  recent(): readonly Decision[] {
    return [...this.decisions];
  }

  snapshot(): ShowSnapshot {
    return {
      mode: this.mode,
      stats: {
        received: this.received,
        decided: this.decided,
        executed: this.executed,
        refused: this.refused,
        observed: this.observed,
        openCommitments: this.ledger.open().length,
      },
      decisions: this.recent(),
      operatorNotice: this.operatorNotice,
      sourceHealth: this.sourceHealth,
    };
  }

  private notice(command: OperatorCommand, detail: string): OperatorNotice {
    return {
      kind: command.kind,
      text: command.text,
      detail,
      at: this.clock.now(),
    };
  }

  private remember(decision: Decision): void {
    this.decisions.unshift(decision);
    if (this.decisions.length > MAX_DECISIONS) this.decisions.pop();
  }

  private count(decision: Decision): void {
    this.decided += 1;
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
