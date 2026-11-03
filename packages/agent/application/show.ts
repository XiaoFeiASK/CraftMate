import {
  audienceEventSchema,
  type AudienceEvent,
  type Decision,
  type Intent,
  type OperatorCommand,
  type OperatorNotice,
  type PersonaSummary,
  type ShowMode,
  type ShowSettings,
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
  /** Operator-editable projection; defaults are derived from the persona. */
  readonly settings?: ShowSettings;
  readonly goalText?: string;
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

export function defaultSettings(persona: Persona, goalText = "盖一间带床和箱子的海崖小屋"): ShowSettings {
  return {
    goal: goalText,
    goalProgress: 18,
    worldName: "本地单人世界",
    gameVersion: "1.21.11",
    accountLabel: "专用直播账号",
    integrations: { douyinRoomId: "", deepseekModel: "" },
    persona: {
      name: persona.name,
      identity: persona.identity,
      tone: persona.style.tone,
      values: persona.values.slice(0, 8),
      boundaries: persona.boundaries.slice(0, 8),
      weights: persona.weights,
      voice: persona.voice,
    },
  };
}

/**
 * The live show: ingest audience events, arbitrate, and expose a read model.
 * No transport, storage, or model code lives here.
 */
export class Show {
  private readonly personaId: string;
  private readonly clock: Clock;
  private readonly audience: AudienceStore;
  readonly ledger: CommitmentLedger;
  private arbiter: Arbiter;
  private settings: ShowSettings;
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
    this.personaId = options.persona.id;
    this.clock = options.clock ?? systemClock;
    this.audience = options.audience ?? new MemoryAudienceStore(this.clock);
    this.ledger = options.ledger ?? new CommitmentLedger();
    this.settings = options.settings ?? defaultSettings(options.persona, options.goalText);
    this.arbiter = new Arbiter({
      persona: this.personaFor(this.settings),
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
    const { persona } = this.settings;
    return {
      id: this.personaId,
      name: persona.name,
      identity: persona.identity,
      weights: persona.weights,
    };
  }

  currentSettings(): ShowSettings {
    return structuredClone(this.settings);
  }

  /** The settings are replaced wholesale so a partial edit can never drop a field. */
  updateSettings(next: ShowSettings): ShowSettings {
    this.settings = structuredClone(next);
    this.arbiter = new Arbiter({
      persona: this.personaFor(this.settings),
      history: this.audience,
      clock: this.clock,
    });
    return this.currentSettings();
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

  private personaFor(settings: ShowSettings): Persona {
    const { persona } = settings;
    return {
      id: this.personaId,
      name: persona.name,
      identity: persona.identity,
      values: persona.values,
      style: {
        tone: persona.tone,
        sentenceLength: "short",
        verbalTics: ["唔", "哼", "肥鱼"],
        quirks: ["先嘴硬再关心", "被叫大肥鱼会骄傲地应一声", "遇到苦力怕会怂"],
      },
      boundaries: persona.boundaries,
      weights: persona.weights,
      voice: persona.voice,
    };
  }
}
