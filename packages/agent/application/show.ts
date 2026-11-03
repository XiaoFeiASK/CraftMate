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
  type VoiceStatus,
} from "@craftmate/contracts";
import type { BridgeHealth } from "@craftmate/contracts";
import { createHash } from "node:crypto";
import {
  Arbiter,
  CommitmentLedger,
  type Persona,
} from "../domain/index.ts";
import type { AudienceStore } from "./ports/audience-store.ts";
import type { Clock } from "./ports/clock.ts";
import { systemClock } from "./ports/clock.ts";
import type { MemoryPort } from "./ports/memory.ts";
import type { ShowRecorder } from "./ports/recorder.ts";
import { Planner } from "./planner.ts";

const MAX_DECISIONS = 200;
/** Fast-path dedupe only; SQLite remains the authority once a recorder exists. */
const MAX_SEEN_IDS = 2_000;
const MAX_AUDIENCE_ENTRIES = 500;
const MAX_INTENT_SAMPLES = 200;

export class MemoryAudienceStore implements AudienceStore {
  private readonly lastCommand = new Map<string, number>();
  private readonly intentTimes = new Map<string, number[]>();
  private readonly clock: Clock;
  private readonly maxEntries: number;

  constructor(clock: Clock = systemClock, maxEntries = MAX_AUDIENCE_ENTRIES) {
    this.clock = clock;
    this.maxEntries = maxEntries;
  }

  lastCommandAt(userId: string): number | null {
    return this.lastCommand.get(userId) ?? null;
  }

  recentIntentCount(intent: Intent, windowMs: number): number {
    const cutoff = this.clock.now() - windowMs;
    const recent = (this.intentTimes.get(intent) ?? [])
      .filter((at) => at > cutoff)
      .slice(-MAX_INTENT_SAMPLES);
    this.intentTimes.set(intent, recent);
    return recent.length;
  }

  recordCommand(userId: string, intent: Intent, at: number): void {
    // Re-insert so Map iteration order is least-recently-used first.
    this.lastCommand.delete(userId);
    this.lastCommand.set(userId, at);
    while (this.lastCommand.size > this.maxEntries) {
      const oldest = this.lastCommand.keys().next().value;
      if (oldest === undefined) break;
      this.lastCommand.delete(oldest);
    }

    const times = this.intentTimes.get(intent) ?? [];
    times.push(at);
    if (times.length > MAX_INTENT_SAMPLES) times.splice(0, times.length - MAX_INTENT_SAMPLES);
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
  /** Fast-path dedupe capacity; storage remains the authority when it overflows. */
  readonly seenLimit?: number;
  /** Stage C. Absent means the show stays deterministic and never calls a model. */
  readonly planner?: Planner;
  /** Approved-memory recall; absent means "no memory", never "all memory". */
  readonly memory?: MemoryPort;
  /** Recall budget per decision, in approximate tokens. */
  readonly memoryBudgetTokens?: number;
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
  private readonly seenOrder: string[] = [];
  private readonly recorder: ShowRecorder | null;
  private readonly seenLimit: number;
  private received: number;
  private decided: number;
  private executed: number;
  private refused: number;
  private observed: number;
  private mode: ShowMode = "agent";
  private operatorNotice: OperatorNotice | null = null;
  private sourceHealth: SourceHealth | null = null;
  private voiceStatus: VoiceStatus | null = null;
  private bridge: BridgeHealth | null = null;
  private readonly planner: Planner | null;
  private readonly memory: MemoryPort | null;
  private readonly memoryBudgetTokens: number;
  /** Decisions waiting on Stage C. Only the newest one may still speak. */
  private readonly pendingPlans = new Set<string>();

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
    this.seenLimit = options.seenLimit ?? MAX_SEEN_IDS;
    this.planner = options.planner ?? null;
    this.memory = options.memory ?? null;
    this.memoryBudgetTokens = options.memoryBudgetTokens ?? 1_200;
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
    const audienceRef = hashAudienceRef(event.userId);
    if (this.mode !== "agent") {
      this.rememberSeen(event.id);
      this.received += 1;
      return null;
    }

    // Evidence is written before arbitration: a decision with no stored source
    // cannot be traced, so it must not be produced at all.
    if (this.recorder && !this.recorder.recordSource(event)) return null;

    this.rememberSeen(event.id);
    this.received += 1;
    const { decision } = this.arbiter.evaluate(event);
    const withAudience = { ...decision, audienceRef };
    this.recorder?.recordDecision(withAudience);
    this.remember(withAudience);
    this.audience.recordCommand(event.userId, decision.intent, this.clock.now());
    this.count(withAudience);
    return withAudience;
  }

  /**
   * Stage C runs after arbitration so the 1-second template path is never
   * blocked by a model. The returned decision replaces the scored one: the
   * console keeps one row per audience event, not two.
   */
  async plan(decision: Decision): Promise<Decision> {
    if (!this.planner) return decision;
    if (decision.decision !== "EXECUTE" && decision.decision !== "ACK_ONLY" && decision.decision !== "REFUSE") {
      return decision;
    }

    this.pendingPlans.add(decision.id);
    const context = {
      decision,
      goal: this.settings.goal,
      persona: this.personaSummary(),
      ...(this.memory
        ? {
            memories: this.memory
              .recall({
                subjectRef: decision.audienceRef,
                query: decision.text,
                budgetTokens: this.memoryBudgetTokens,
              })
              .map((item) => item.memory.content),
          }
        : {}),
    };
    const planned = await this.planner.plan(context);
    this.pendingPlans.delete(decision.id);

    const next: Decision = {
      ...decision,
      stage: "planned",
      speech: planned.speech,
      skill: planned.skill,
      trace: {
        provider: planned.provider ?? "template",
        model: planned.model ?? "template",
        latencyMs: planned.latencyMs,
        degraded: planned.degraded,
        detail: planned.detail,
      },
    };
    this.recorder?.updateDecision?.(next);
    const index = this.decisions.findIndex((item) => item.id === decision.id);
    // A missing index means the decision already aged out of the 200-row window;
    // writing it back at the top would reorder the stream.
    if (index >= 0) this.decisions[index] = next;
    return next;
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

  /** Voice is reported by its own service; it never mutates show business state. */
  setVoiceStatus(status: VoiceStatus): void {
    this.voiceStatus = status;
  }

  currentVoiceStatus(): VoiceStatus | null {
    return this.voiceStatus;
  }

  /** Bridge health is a projection only; the body owns its own truth. */
  setBridgeHealth(health: BridgeHealth | null): void {
    this.bridge = health;
  }

  currentBridgeHealth(): BridgeHealth | null {
    return this.bridge;
  }

  /**
   * Reserves a commitment for speech the show is about to produce. The caller
   * must persist first (`ledger.reserve`) and only then hand text to Voice:
   * a spoken promise that cannot be read back from storage is a lie.
   */
  reserveCommitment(input: {
    readonly decision: Decision;
    readonly utterance: string;
  }): ReturnType<CommitmentLedger["reserve"]> {
    if (input.decision.audienceRef.length === 0) {
      throw new Error(`decision ${input.decision.id} has no hashed audience reference`);
    }
   // Retrieve the sourceId from the recorder if available, so the commitment
   // can be traced back to its originating audience event.
   const sourceId = this.recorder?.findSourceId?.(input.decision.eventId) ?? null;
    return this.ledger.reserve({
      audienceRef: input.decision.audienceRef,
      utterance: input.utterance,
     sourceId,
      planId: input.decision.id,
    });
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
      voiceStatus: this.voiceStatus,
      bridge: this.bridge,
      model: this.planner?.status ?? {
        state: "disabled",
        provider: null,
        model: null,
        detail: "未配置模型",
      },
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

  /**
   * An id leaves the fast path once it ages out. Dropping it can only cost a
   * database lookup; it cannot admit a duplicate while a recorder is present.
   */
  private rememberSeen(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > this.seenLimit) {
      const oldest = this.seenOrder.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
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

/**
 * Stable, non-reversible audience reference. Storage never sees a raw platform
 * user id, and recall can still find the same viewer across sessions.
 */
function hashAudienceRef(userId: string): string {
  const digest = createHash("sha256").update(userId).digest("hex");
  return `viewer:${digest.slice(0, 32)}`;
}
