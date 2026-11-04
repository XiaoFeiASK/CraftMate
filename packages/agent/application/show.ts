import {
  audienceEventSchema,
  type AudienceEvent,
  type Decision,
  type GoalProgress,
  type Intent,
  type OperatorCommand,
  type OperatorNotice,
  type PersonaSummary,
  type Proposal,
  type ProposalStatus,
  type SeasonGoal,
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
  classifyIntent,
  type Persona,
} from "../domain/index.ts";
import type { AudienceStore } from "./ports/audience-store.ts";
import type { Clock } from "./ports/clock.ts";
import { systemClock } from "./ports/clock.ts";
import type { MemoryPort } from "./ports/memory.ts";
import type { ShowRecorder } from "./ports/recorder.ts";
import { Planner } from "./planner.ts";
import type {
  ProposalEvaluator,
  ProposalExecutionContext,
  ProposalRepository,
} from "./proposals.ts";
import { MemoryProposalRepository, ProposalInbox } from "./proposals.ts";

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
  /** Live semantic observation supplied by the game body, when connected. */
  readonly world?: () => unknown;
  /** Exact skills advertised by the connected body at planning time. */
  readonly availableSkills?: () => readonly string[];
  /** Recall budget per decision, in approximate tokens. */
  readonly memoryBudgetTokens?: number;
  /** Proposal persistence. Absent means the inbox is in-memory only. */
  readonly proposals?: ProposalRepository;
  /** #42's goal-alignment evaluator; absent keeps proposals pending. */
  readonly proposalEvaluator?: ProposalEvaluator;
  /** Restored from storage so a restart resumes the right goal. */
  readonly goalState?: {
    readonly goal: SeasonGoal | null;
    readonly progress: GoalProgress | null;
    readonly enabled?: boolean;
  };
}

/**
 * Something the body lived through that is worth a line of speech. It is a
 * fact from the game, never an instruction, so it can only add context to a
 * plan; it cannot authorise a skill.
 */
export interface WorldIncident {
  readonly kind: string;
  readonly detail: string;
  readonly at: number;
}

export function defaultSettings(persona: Persona, goalText = "盖一间带床和箱子的海崖小屋"): ShowSettings {
  return {
    goal: goalText,
    goalDescription: "",
    goalMode: false,
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
  private readonly world: (() => unknown) | null;
  private readonly availableSkills: (() => readonly string[]) | null;
  private readonly memoryBudgetTokens: number;
  private readonly incidents: WorldIncident[] = [];
  private readonly proposalInbox: ProposalInbox;
  private goal: GoalProgress | null;
  private seasonGoal: SeasonGoal | null;
  private goalMode: boolean;

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
    this.world = options.world ?? null;
    this.availableSkills = options.availableSkills ?? null;
    this.memoryBudgetTokens = options.memoryBudgetTokens ?? 1_200;
    this.proposalInbox = new ProposalInbox({
      repository: options.proposals ?? new MemoryProposalRepository(),
      ...(options.proposalEvaluator ? { evaluator: options.proposalEvaluator } : {}),
      clock: this.clock,
    });
    this.goal = options.goalState?.progress ?? null;
    this.seasonGoal = options.goalState?.goal ?? null;
    this.goalMode = options.goalState?.enabled ?? options.goalState?.goal != null;
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
    // Audience text enters the inbox first. Natural conversation still reaches
    // arbitration, but an actionable proposal is not dispatched from here; the
    // GoalRuntime issues at most one task after the operator's gates.
    if (this.goalMode && event.kind === "comment" && this.shouldQueueProposal(event)) {
      const ingested = this.proposalInbox.ingest(event, this.proposalContext(), audienceRef);
      if (ingested !== null) {
        if (ingested.created) {
          this.recorder?.recordProposal?.(ingested.proposal);
        } else {
          this.recorder?.updateProposal?.(ingested.proposal);
        }
        return this.proposalDecision(event, ingested.proposal, audienceRef);
      }
    }
    const { decision } = this.arbiter.evaluate(event);
    const withAudience = { ...decision, audienceRef };
    this.recorder?.recordDecision(withAudience);
    this.remember(withAudience);
    this.audience.recordCommand(event.userId, decision.intent, this.clock.now());
    this.count(withAudience);
    return withAudience;
  }

  /** Proposals are the only audience path that can later affect goal choice. */
  private shouldQueueProposal(event: AudienceEvent): boolean {
    if (this.mode !== "agent") return false;
    const text = event.text?.trim() ?? "";
    if (text.length === 0) return false;
    const intent = classifyIntent(event).intent;
    return intent !== "chat" && intent !== "unknown" && intent !== "spam";
  }

  private proposalDecision(
    event: AudienceEvent,
    proposal: Proposal,
    audienceRef: string,
  ): Decision {
    const decision: Decision = {
      id: this.clock.newId(),
      eventId: event.id,
      nickname: event.nickname,
      text: proposal.text,
      intent: proposal.intent,
      decision:
        proposal.status === "rejected"
          ? "REFUSE"
          : proposal.status === "pending"
            ? "QUEUE"
            : "ACK_ONLY",
      priority: "vote",
      reason: proposal.reason,
      score: 0,
      stage: "rules",
      skill: null,
      speech: "",
      audienceRef,
      trace: null,
      at: this.clock.now(),
    };
    this.recorder?.recordDecision(decision);
    this.remember(decision);
    this.audience.recordCommand(event.userId, decision.intent, this.clock.now());
    this.count(decision);
    return decision;
  }

  proposalContext(): ProposalExecutionContext {
    return {
      mode: this.mode,
      bridge: this.bridge,
      world: this.bridge?.world ?? null,
      goal: this.goal,
    };
  }

  /** Restored goal evidence; the runtime replaces it on the next observation. */
  currentGoal(): GoalProgress | null {
    return this.goal === null ? null : structuredClone(this.goal);
  }

  currentSeasonGoal(): SeasonGoal | null {
    return this.seasonGoal === null ? null : { ...this.seasonGoal };
  }

  /**
   * Stage C runs after arbitration so the 1-second template path is never
   * blocked by a model. The returned decision replaces the scored one: the
   * console keeps one row per audience event, not two.
   */
  async plan(decision: Decision): Promise<Decision> {
    if (!this.planner) return decision;
    // QUEUE is a model-worthy candidate: it may speak or explain the queued
    // intent, while Planner.validate still forbids it from carrying a skill.
    // OBSERVE and IGNORE stay deterministic so ordinary chat cannot invoke the
    // provider or acquire a side effect.
    if (
      decision.decision !== "EXECUTE" &&
      decision.decision !== "ACK_ONLY" &&
      decision.decision !== "REFUSE" &&
      decision.decision !== "QUEUE"
    ) {
      return decision;
    }

    const context = {
      decision,
      goal: this.settings.goal,
      persona: this.personaSummary(),
      ...(this.incidents.length > 0 ? { incidents: this.incidents.slice(-4) } : {}),
      ...(this.world ? { world: this.world() } : {}),
      ...(this.availableSkills
        ? { availableSkills: this.availableSkills() }
        : {}),
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

  /**
   * Reflexes arrive between comments. Keeping only the recent few means the
   * next reply can react to "I just got knocked into lava" without replaying
   * an hour of scrapes, and the show never grows with the session.
   */
  recordIncident(incident: WorldIncident): void {
    this.incidents.push(incident);
    if (this.incidents.length > 8) this.incidents.splice(0, this.incidents.length - 8);
  }

  currentIncidents(): readonly WorldIncident[] {
    return [...this.incidents];
  }

  /**
   * The bridge settles the skill after the decision was already shown. Writing
   * the terminal status back onto that decision is what lets the console say
   * "it broke two logs" instead of only "it decided to chop".
   */
  settleDecision(decisionId: string, outcome: NonNullable<Decision["outcome"]>): Decision | null {
    const index = this.decisions.findIndex((item) => item.id === decisionId);
    if (index < 0) return null;
    const current = this.decisions[index]!;
    if (current.outcome != null) return null;
    const next: Decision = { ...current, outcome };
    this.decisions[index] = next;
    this.recorder?.updateDecision?.(next);
    return next;
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

  /** Swaps the live model connection without replacing the show or its history. */
  updatePlannerProvider(provider: Parameters<Planner["updateProvider"]>[0]): void {
    this.planner?.updateProvider(provider);
  }

  /** Applies a newly saved provider timeout without recreating the show. */
  updatePlannerDeadline(deadlineMs: number): void {
    this.planner?.updateDeadline(deadlineMs);
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
      goal: this.goal,
      proposals: this.proposalInbox.query(null, 40),
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

  proposals(status: ProposalStatus | null = null, limit = 50): readonly Proposal[] {
    return this.proposalInbox.query(status, limit);
  }

  decideProposal(
    proposalId: string,
    status: Exclude<ProposalStatus, "pending">,
    reason: string,
  ): Proposal | null {
    const decided = this.proposalInbox.decide(
      proposalId,
      status,
      reason,
      this.proposalContext(),
    );
    if (decided !== null) this.recorder?.updateProposal?.(decided);
    return decided;
  }

  /** The runtime is authoritative; the show only projects its evidence. */
  setGoalProgress(progress: GoalProgress | null): void {
    this.goal = progress === null ? null : structuredClone(progress);
  }

  /**
   * Adds a GoalRuntime-authored decision to the live stream. Persistence is
   * done by the host because it needs a system source row, not an audience id.
   */
  recordRuntimeDecision(decision: Decision): boolean {
    if (this.mode !== "agent") return false;
    this.remember(decision);
    this.count(decision);
    return true;
  }

  setSeasonGoal(goal: SeasonGoal | null): void {
    this.seasonGoal = goal === null ? null : { ...goal };
  }

  setGoalMode(enabled: boolean): void {
    this.goalMode = enabled;
  }

  isGoalMode(): boolean {
    return this.goalMode;
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
