import {
  goalProgressSchema,
  goalKindForTitle,
  goalPresetForTitle,
  navigationModeSchema,
  seasonGoalSchema,
  SEASON_GOAL_PRESETS,
  skillCallSchema,
  type Intent,
  type BridgeHealth,
  type Decision,
  type GoalKind,
  type GoalMilestone,
  type GoalProgress,
  type GoalStatus,
  type GoalTaskTree,
  type Proposal,
  type RouteBlacklist,
  type SeasonGoal,
  type ShowMode,
  type SkillCall,
  type TargetLock,
  type WorldSnapshot,
} from "@craftmate/contracts";
import {
  classifyFailure,
  deadEndEscapeTask,
  explore,
  mineMouthApproachTask,
  nextTaskForStage,
  normalizedTaskId,
  planSurvival,
  recover,
  taskSignature,
  TaskScheduler,
  TaskTree,
  worldFactsFromSnapshot,
  type AcquisitionNode,
  type FailureCategory,
  type GoalId,
  type SurvivalPlan,
  type Task,
  type TaskNode,
  type TaskTreeSnapshot,
  type TaskFailure,
  type WorldFacts,
} from "../domain/index.ts";
import type { Clock } from "./ports/clock.ts";
import { systemClock } from "./ports/clock.ts";
import type { ModelProvider } from "./ports/model.ts";
import { projectGoalTree } from "./goal-tree-view.ts";

export interface GoalTask {
  readonly intent: Decision["intent"];
  readonly text: string;
  readonly reason: string;
  /** A mandatory state gate that optional model candidates cannot replace. */
  readonly critical?: boolean;
  /** Optional model-authored line; the runtime supplies a plain fallback. */
  readonly speech?: string;
  readonly skill: SkillCall;
  readonly targetLock?: TargetLock | null;
  /** Domain task identity; `strategyKey` may change independently. */
  readonly taskId?: string;
  /** Planned AND/OR prerequisite branch, recorded under the active task. */
  readonly acquisition?: AcquisitionNode | null;
}

export interface GoalPlan {
  readonly stage: { readonly id: string; readonly title: string };
  readonly milestone: { readonly id: string; readonly title: string };
  readonly nextTask: GoalTask | null;
  readonly milestones: readonly GoalMilestone[];
  /** False until the goal engine can prove milestone evidence. */
  readonly verified: boolean;
  readonly complete?: boolean;
  readonly blockedReason?: string | null;
  /** Stable identity used to avoid retrying one failed strategy forever. */
  readonly strategyKey?: string;
  readonly cardId?: string;
  readonly cardTitle?: string;
  readonly cardReason?: string;
  readonly cardStatus?: "available" | "blocked" | "done";
  readonly cardActiveForMs?: number;
  readonly cardMinDwellRemainingMs?: number;
  readonly cardRecoveryId?: string | null;
  readonly cardAlternatives?: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: "available" | "blocked" | "done";
    readonly blockedReason: string | null;
  }[];
  readonly playbookVersion?: string;
  readonly cardSwitchReason?: string | null;
  readonly cardModelChoice?: boolean | null;
  readonly cardFallbackReason?: string | null;
  readonly targetLock?: TargetLock | null;
  /** Full behavior tree state returned by the tree engine. */
  readonly treeSnapshot?: TaskTreeSnapshot | null;
}

export interface GoalPlanningInput {
  readonly goal: SeasonGoal;
  readonly progress: GoalProgress;
  readonly world: WorldSnapshot | null;
  readonly health: BridgeHealth | null;
  /** Accepted proposals are evidence for trade-offs, not commands. */
  readonly proposals: readonly Proposal[];
  readonly lastFailure: string | null;
  readonly consecutiveFailures: number;
  /** Current session's active route refusals. */
  readonly routeBlacklist?: readonly RouteBlacklist[];
  /** Goal-engine failure history, newest last. */
  readonly failures?: readonly TaskFailure[];
  /** Strategy that just failed; recovery may not reissue it. */
  readonly lastFailureStrategy?: string | null;
  /** Restored behavior tree, when the tree engine is active. */
  readonly treeSnapshot?: TaskTreeSnapshot | null;
}

/**
 * Adapter over #42's pure planner. The runtime never invents a stage or a
 * milestone; without the engine it returns an explicit unverified plan.
 */
export interface GoalPlanner {
  /** Identifies which runtime path owns settlement and persistence. */
  readonly engine?: "tree" | "legacy";
  plan(input: GoalPlanningInput): GoalPlan | null;
  /** Optional model-assisted path. Hosts fall back to `plan` when absent. */
  planAsync?(input: GoalPlanningInput): Promise<GoalPlan | null>;
  /** Hot-reloads model credentials without recreating the runtime. */
  updateProvider?(provider: ModelProvider | null): void;
  /** Applies an operator-saved model timeout to the next request. */
  updateDeadline?(deadlineMs: number): void;
  /** Tree engines update their nodes from the body's terminal result. */
  noteSettlement?(event: {
    readonly decisionId: string;
    readonly taskId: string;
    readonly strategyKey: string;
    readonly outcome: GoalSettlement;
  }): void;
  /** Latest tree snapshot after a settlement, without asking for a new task. */
  treeSnapshot?(): TaskTreeSnapshot | null;
  /**
   * A reconnected body is a changed world. Tree engines may clear blocked
   * branches for another attempt instead of stranding the goal forever.
   */
  retryFailed?(reason: string): number;
}

export interface GoalRuntimeRecord {
  readonly goal: SeasonGoal | null;
  readonly enabled: boolean;
  readonly progress: GoalProgress | null;
  readonly currentDecisionId: string | null;
  readonly currentStrategyKey: string | null;
  readonly lastFailure: string | null;
  readonly lastFailureStrategy: string | null;
  readonly consecutiveFailures: number;
  readonly retryAt: number;
  readonly updatedAt: number;
  /** Stage-scoped failed strategies, so a restart does not repeat them. */
  readonly failures?: readonly TaskFailure[];
  /** Active-branch cursor restored after a restart; never replayed blindly. */
  readonly taskTree?: TaskTreeSnapshot | null;
  readonly taskNode?: TaskNode | null;
  readonly targetFamily?: string | null;
  readonly evidenceRefs?: readonly string[];
  readonly failureRecord?: {
    readonly category: FailureCategory;
    readonly detail: string;
    readonly at: number;
  } | null;
}

export interface GoalRuntimeStore {
  load(): GoalRuntimeRecord | null;
  save(record: GoalRuntimeRecord): void;
}

export interface GoalRuntimeContext {
  readonly mode: ShowMode;
  readonly bridge: BridgeHealth | null;
  readonly world: WorldSnapshot | null;
}

export interface GoalDispatch {
  readonly commandId: string;
  readonly taskId: string;
  readonly strategyKey: string;
  readonly decision: Decision;
}

export interface GoalSettlement {
  readonly status: "completed" | "failed" | "timeout" | "cancelled" | "preempted";
  readonly errorCode?: string;
  readonly detail?: string;
  readonly at: number;
  /** Body-confirmed effects. A bare `completed` is not proof by itself. */
  readonly changes?: readonly GoalChange[];
  /** Partial progress and the body's suggested continuation, when it gave one. */
  readonly progress?: {
    readonly done: number;
    readonly total?: number | undefined;
    readonly unit?: string | undefined;
  };
  readonly remaining?: string;
  readonly resumable?: boolean;
  readonly nextHint?: string;
}

export interface GoalChange {
  readonly kind: string;
  readonly detail: string;
  readonly position?: { readonly x: number; readonly y: number; readonly z: number } | undefined;
}

export interface GoalInterruption {
  readonly decisionId: string;
  readonly commandId: string;
  readonly decision: Decision;
}

interface PreparedGoalStep {
  readonly input: GoalPlanningInput;
  readonly goalId: string;
  readonly goalVersion: number;
}

interface GoalRuntimeOptions {
  readonly store: GoalRuntimeStore;
  readonly planner: GoalPlanner;
  readonly clock?: Clock;
  readonly proposals?: () => readonly Proposal[];
  readonly recordDecision?: (decision: Decision) => void;
  readonly onUpdate?: (progress: GoalProgress | null) => void;
  /** A task that never settles is failed at this age. */
  readonly taskTimeoutMs?: number;
  /** Absolute cap; body progress does not extend this deadline. */
  readonly hardTaskTimeoutMs?: number;
  readonly failureBaseMs?: number;
  readonly failureMaxMs?: number;
  /**
   * A tree branch that has failed twice is parked rather than retried every
   * few seconds. It is still a world state, not a verdict: after this
   * cooldown the runtime reopens it, doubling the wait up to `blockedRetryMaxMs`.
   */
  readonly blockedRetryBaseMs?: number;
  readonly blockedRetryMaxMs?: number;
  readonly maxConsecutiveFailures?: number;
  /** Same `code + detail` repeated this many times opens a strategy circuit. */
  readonly circuitFailureThreshold?: number;
  readonly circuitWindowMs?: number;
  readonly circuitCooldownMs?: number;
  /**
   * A settled skill can change the world or inventory, but the planner still
   * sees the heartbeat from before it ran. Hold the next plan briefly so a
   * fresh observation arrives; otherwise a placement can be reissued against
   * the stale nearby-block list and create a duplicate station.
   */
  readonly settlementObservationMs?: number;
  readonly onIncident?: (incident: {
    readonly code: string;
    readonly severity: "info" | "warn" | "error";
    readonly detail: Record<string, unknown>;
  }) => void;
  /** Persistence hook for strategy/world memory; never changes dispatch. */
  readonly onSettlement?: (event: {
    readonly decision: Decision;
    readonly strategyKey: string;
    readonly status: GoalSettlement["status"];
    readonly errorCode: string | null;
    readonly detail: string | null;
    readonly changes: readonly GoalChange[];
    readonly at: number;
  }) => void;
}

const DEFAULT_FAILURE_BASE_MS = 2_500;
/**
 * A minute of silence after a terrain failure reads as a frozen agent: the
 * console shows an active goal and an empty `nextTask`, and the body stands
 * still for the whole wait. Six seconds is still far below the body's task
 * timeout, so it cannot hammer a failing skill, while the next decision
 * observes a changed world (animals move, night ends, a drop becomes
 * reachable) soon enough to look continuous. The idle wanderer owns the body
 * during this window, so the pause is a short observation beat, not a freeze.
 */
const DEFAULT_FAILURE_MAX_MS = 6_000;
const DEFAULT_BLOCKED_RETRY_BASE_MS = 45_000;
const DEFAULT_BLOCKED_RETRY_MAX_MS = 5 * 60_000;
const DEFAULT_TASK_TIMEOUT_MS = 90_000;
/**
 * Progress keeps a long mining or travel command alive, but it must not make
 * the runtime immortal. A body stuck in an escape branch can emit progress
 * frames forever while the world does not change; this cap is the last line
 * between that loop and a four-hour run with no decisions.
 */
const DEFAULT_HARD_TASK_TIMEOUT_MS = 110_000;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_CIRCUIT_THRESHOLD = 3;
const DEFAULT_CIRCUIT_WINDOW_MS = 60_000;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;
/**
 * A reflex owns the body only long enough to take its hand off the mouse and
 * step away. Holding the planner for ten seconds after that was the freeze
 * operators saw as "one command, then the body stands there", especially
 * while a pillager kept shooting. The body blocks unsafe skills itself for
 * as long as the hazard is still present; the planner only needs a brief
 * hand-off window to choose the recovery task.
 */
const REFLEX_HANDOFF_MS = 2_500;

/**
 * Goal mode executor. It produces at most one skill at a time and waits for
 * that decision's terminal outcome before asking the planner again.
 */
export class GoalRuntime {
  private readonly store: GoalRuntimeStore;
  private readonly planner: GoalPlanner;
  private readonly clock: Clock;
  private readonly proposals: (() => readonly Proposal[]) | null;
  private readonly recordDecision: ((decision: Decision) => void) | null;
  private readonly onUpdate: ((progress: GoalProgress | null) => void) | null;
  private readonly taskTimeoutMs: number;
  private readonly hardTaskTimeoutMs: number;
  private readonly failureBaseMs: number;
  private readonly failureMaxMs: number;
  private readonly blockedRetryBaseMs: number;
  private readonly blockedRetryMaxMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitWindowMs: number;
  private readonly circuitCooldownMs: number;
  private readonly settlementObservationMs: number;
  private readonly onIncident: GoalRuntimeOptions["onIncident"];
  private readonly onSettlement: GoalRuntimeOptions["onSettlement"];
  private expiryHandler: ((interruption: GoalInterruption) => void) | null = null;

  private goal: SeasonGoal | null = null;
  private progress: GoalProgress | null = null;
  private enabled = false;
  private inFlight: {
    readonly decision: Decision;
    readonly commandId: string;
    readonly taskId: string;
    readonly strategyKey: string;
    /** Extended by progress frames; detects silence. */
    startedAt: number;
    /** Never extended; detects progress frames that change nothing. */
    readonly dispatchedAt: number;
    /** Last observed progress signature; identical frames do not revive it. */
    lastProgress: string | null;
  } | null = null;
  private lastFailure: string | null = null;
  private lastFailureStrategy: string | null = null;
  private consecutiveFailures = 0;
  private retryAt = 0;
  private nextPlanAt = 0;
  private blockedRetryAt = 0;
  private blockedRetryCount = 0;
  /**
   * A station placement is a one-off world change. The body may report the
   * success before the next world snapshot contains the new block, and
   * re-planning in that window placed a second furnace on top of the first.
   * Suppress an identical station placement briefly; torches and ordinary
   * building blocks are intentionally not covered because a player does place
   * several of them in a row.
   */
  private recentStationPlacement: { readonly block: string; readonly at: number } | null =
    null;
  /**
   * A live body placed 99 torches in 100 seconds at the bottom of a sealed
   * shaft. The body confirmed every world change, but the torch sat behind a
   * wall, so the next snapshot still reported light 3 and the planner issued
   * another one. The domain now skips lighting when a torch is already in its
   * nearby survey; this short runtime guard covers the snapshot window before
   * that survey catches up.
   */
  private recentTorchPlacementAt = Number.NEGATIVE_INFINITY;
  private restoredInFlight: string | null = null;
  private bridgeConnected = false;
  private bridgeGeneration: number | null = null;
  private failures: TaskFailure[] = [];
  private failureWindow: { readonly fingerprint: string; readonly at: number }[] = [];
  private circuit: {
    readonly strategyKey: string;
    readonly fingerprint: string;
    readonly detail: string;
    readonly until: number;
  } | null = null;
  private taskTree: TaskTree | null = null;
  private taskRootId: string | null = null;
  private taskMilestoneId: string | null = null;
  private taskNodeId: string | null = null;
  private taskTargetFamily: string | null = null;
  private taskEvidenceRefs: string[] = [];
  private speechVariation = 0;
  private taskFailureRecord: {
    readonly category: FailureCategory;
    readonly detail: string;
    readonly at: number;
  } | null = null;

  constructor(options: GoalRuntimeOptions) {
    this.store = options.store;
    this.planner = options.planner;
    this.clock = options.clock ?? systemClock;
    this.proposals = options.proposals ?? null;
    this.recordDecision = options.recordDecision ?? null;
    this.onUpdate = options.onUpdate ?? null;
    this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.hardTaskTimeoutMs =
      options.hardTaskTimeoutMs ?? DEFAULT_HARD_TASK_TIMEOUT_MS;
    this.failureBaseMs = options.failureBaseMs ?? DEFAULT_FAILURE_BASE_MS;
    this.failureMaxMs = options.failureMaxMs ?? DEFAULT_FAILURE_MAX_MS;
    this.blockedRetryBaseMs =
      options.blockedRetryBaseMs ?? DEFAULT_BLOCKED_RETRY_BASE_MS;
    this.blockedRetryMaxMs =
      options.blockedRetryMaxMs ?? DEFAULT_BLOCKED_RETRY_MAX_MS;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES;
    this.circuitFailureThreshold =
      options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_THRESHOLD;
    this.circuitWindowMs = options.circuitWindowMs ?? DEFAULT_CIRCUIT_WINDOW_MS;
    this.circuitCooldownMs = options.circuitCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS;
    this.settlementObservationMs = options.settlementObservationMs ?? 0;
    this.onIncident = options.onIncident;
    this.onSettlement = options.onSettlement;
  }

  /** The tree engine owns node state; the legacy path keeps projecting it. */
  private get treeOwned(): boolean {
    return this.planner.engine === "tree";
  }

  /** Restores the durable goal and stage. An old in-flight task is not replayed. */
  restore(): void {
    const record = this.store.load();
    if (!record) return;
    const goal = record.goal === null ? null : seasonGoalSchema.safeParse(record.goal);
    this.goal = goal?.success ? normalizeSeasonGoal(goal.data) : null;
    const migrated =
      this.goal !== null &&
      JSON.stringify(record.goal) !== JSON.stringify(this.goal);
    const progress =
      record.progress === null ? null : goalProgressSchema.safeParse(record.progress);
    this.progress = progress?.success ? progress.data : null;
    this.enabled = record.enabled;
    this.lastFailure = record.lastFailure;
    this.lastFailureStrategy = record.lastFailureStrategy;
    this.consecutiveFailures = record.consecutiveFailures;
    this.retryAt = record.retryAt;
    this.failures = safeFailures(record.failures);
    if (record.taskTree !== undefined && record.taskTree !== null) {
      try {
        this.taskTree = TaskTree.restore(record.taskTree, () => this.clock.now());
        this.taskRootId = record.taskTree.rootId;
      } catch {
        // A truncated or hand-edited tree is diagnosis, not execution state.
        // Drop it and let the planner re-observe from the durable goal.
        this.taskTree = null;
        this.taskRootId = null;
      }
    }
    this.taskNodeId = record.taskNode?.id ?? null;
    this.taskMilestoneId =
      this.taskNodeId === null
        ? null
        : this.taskTree?.get(this.taskNodeId)?.parentId ?? null;
    if (this.taskMilestoneId !== null && this.taskMilestoneId === this.taskRootId) {
      this.taskMilestoneId = null;
    }
    this.taskTargetFamily = record.targetFamily ?? null;
    this.taskEvidenceRefs = [...(record.evidenceRefs ?? [])].slice(-16);
    this.taskFailureRecord = record.failureRecord ?? null;
    if (record.currentDecisionId !== null) {
      this.restoredInFlight = record.currentDecisionId;
      this.lastFailure = "重启前任务终态未知；已丢弃旧计划，重新观察世界";
      this.consecutiveFailures = Math.max(1, record.consecutiveFailures);
      this.retryAt = this.clock.now();
      if (this.progress !== null) {
        this.progress = {
          ...this.progress,
          status: this.progress.status === "completed" ? "unverified" : this.progress.status,
          lastFailure: this.lastFailure,
          updatedAt: this.clock.now(),
        };
      }
      this.persist();
    } else if (migrated) {
      this.persist();
    }
  }

  get currentGoal(): SeasonGoal | null {
    return this.goal === null ? null : { ...this.goal };
  }

  get currentProgress(): GoalProgress | null {
    return this.progress === null ? null : structuredClone(this.progress);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get hasTaskInFlight(): boolean {
    return this.inFlight !== null;
  }

  /** The live command, for state monitors that may preempt long skills. */
  get currentDecision(): Decision | null {
    return this.inFlight?.decision ?? null;
  }

  get restoredDecisionId(): string | null {
    return this.restoredInFlight;
  }

  /**
   * Operator-owned goal replacement. Version increments even when the title is
   * unchanged so any plan evaluated against the old goal is stale.
   */
  setGoal(input: {
    readonly title: string;
    readonly description: string;
    readonly goalKind?: GoalKind;
    readonly at?: number;
  }): { readonly goal: SeasonGoal; readonly interruption: GoalInterruption | null } {
    const interruption = this.interrupt("目标已更换，旧任务作废");
    const at = input.at ?? this.clock.now();
    const goal: SeasonGoal = {
      id: this.clock.newId(),
      title: input.title,
      description: input.description,
      goalKind: input.goalKind ?? goalKindForTitle(input.title),
      status: "unverified",
      version: (this.goal?.version ?? 0) + 1,
      setBy: "operator",
      setAt: at,
    };
    this.goal = goal;
    this.enabled = true;
    this.progress = {
      goalId: goal.id,
      goalVersion: goal.version,
      status: "unverified",
      stage: { id: "observe", title: "等待重新观察世界" },
      milestone: { id: "observe", title: "等待目标引擎给出当前里程碑" },
      nextTask: "",
      milestones: [],
      completed: 0,
      unverified: 0,
      lastFailure: null,
      consecutiveFailures: 0,
      retryAt: null,
      updatedAt: at,
    };
    this.lastFailure = null;
    this.lastFailureStrategy = null;
    this.consecutiveFailures = 0;
    this.failures = [];
    this.retryAt = 0;
    this.blockedRetryAt = 0;
    this.blockedRetryCount = 0;
    this.taskTree = null;
    this.taskRootId = null;
    this.taskMilestoneId = null;
    this.taskNodeId = null;
    this.taskTargetFamily = null;
    this.taskEvidenceRefs = [];
    this.taskFailureRecord = null;
    this.persist();
    return { goal, interruption };
  }

  setEnabled(enabled: boolean, reason = enabled ? "操作员开启目标模式" : "操作员关闭目标模式"): GoalInterruption | null {
    const interruption = enabled ? null : this.interrupt(reason);
    this.enabled = enabled;
    if (this.goal !== null && this.progress !== null) {
      this.progress = {
        ...this.progress,
        status: enabled ? this.resumedStatus() : "paused",
        updatedAt: this.clock.now(),
      };
    }
    this.persist();
    return interruption;
  }

  /** Applies a settings document without interrupting an unrelated edit. */
  syncMode(enabled: boolean): GoalInterruption | null {
    if (enabled === this.enabled) return null;
    return this.setEnabled(enabled);
  }

  pause(reason = "操作员暂停目标模式"): GoalInterruption | null {
    const interruption = this.hold(reason);
    this.enabled = true;
    this.persist();
    return interruption;
  }

  /**
   * Temporary hold caused by takeover/stop. Unlike `pause`, it does not claim
   * the operator disabled goal mode; releasing control resumes the same goal.
   */
  hold(reason: string): GoalInterruption | null {
    const interruption = this.interrupt(reason);
    if (this.goal !== null) {
      this.goal = { ...this.goal, status: "paused" };
    }
    if (this.progress !== null) {
      this.progress = { ...this.progress, status: "paused", updatedAt: this.clock.now() };
    }
    this.persist();
    return interruption;
  }

  resume(): void {
    this.enabled = true;
    if (this.goal !== null) {
      this.goal = {
        ...this.goal,
        status: this.goal.status === "completed" ? "completed" : "active",
      };
    }
    if (this.progress !== null) {
      this.progress = {
        ...this.progress,
        status: this.progress.status === "completed" ? "completed" : this.resumedStatus(),
        updatedAt: this.clock.now(),
      };
    }
    this.retryAt = 0;
    this.blockedRetryAt = 0;
    this.blockedRetryCount = 0;
    const current = this.taskTree?.current ?? null;
    if (current !== null && current.state === "paused") {
      this.taskTree?.activate(current.id);
    }
    this.persist();
  }

  /** Operator takeover, emergency stop, or a goal switch. */
  interrupt(reason: string): GoalInterruption | null {
    const current = this.inFlight;
    if (current === null) return null;
    this.inFlight = null;
    if (
      this.taskTree !== null &&
      this.taskNodeId !== null &&
      this.taskTree.get(this.taskNodeId)?.state === "active"
    ) {
      this.taskTree.pause(this.taskNodeId);
    }
    this.persist();
    return {
      decisionId: current.decision.id,
      commandId: current.commandId,
      decision: current.decision,
    };
  }

  /**
   * The host owns transport cancellation. A timeout must stop the body's old
   * command, not only forget it locally, or the stale skill keeps changing
   * the world while a new plan is queued behind it.
   */
  setExpiryHandler(handler: ((interruption: GoalInterruption) => void) | null): void {
    this.expiryHandler = handler;
  }

  /**
   * A body progress frame proves a long skill is alive only when the counter
   * actually moves. Some skills emit the same "breaking 0/100" frame every
   * tick while stuck behind terrain; treating that as progress made the task
   * immortal until the hard cap. Keep the silence clock running for repeats.
   */
  noteProgress(
    commandId: string,
    at = this.clock.now(),
    progress?: {
      readonly phase?: string | null | undefined;
      readonly done?: number | null | undefined;
      readonly total?: number | null | undefined;
    },
  ): boolean {
    if (this.inFlight === null || this.inFlight.commandId !== commandId) return false;
    const signature =
      progress === undefined
        ? null
        : `${progress.phase ?? ""}:${progress.done ?? ""}/${progress.total ?? ""}`;
    if (signature !== null && signature === this.inFlight.lastProgress) {
      return true;
    }
    this.inFlight.lastProgress = signature;
    this.inFlight.startedAt = at;
    return true;
  }

  /**
   * Returns the single next task, or null while paused, busy, backing off, or
   * waiting for a terminal outcome. The caller issues `commandId` to the body.
   */
  beginStep(context: GoalRuntimeContext): GoalDispatch | null {
    const prepared = this.prepareStep(context);
    if (prepared === null) return null;
    let plan: GoalPlan | null;
    try {
      plan = this.planner.plan(prepared.input);
    } catch (error) {
      this.recordPlanningError(error);
      return null;
    }
    return this.commitStep(prepared, plan, context);
  }

  /**
   * Model-assisted variant. The model only ranks deterministic candidates;
   * all state gates are re-checked after the await so a takeover, goal edit or
   * disconnect during the request cannot dispatch a stale plan.
   */
  async beginStepAsync(context: GoalRuntimeContext): Promise<GoalDispatch | null> {
    const prepared = this.prepareStep(context);
    if (prepared === null) return null;
    let plan: GoalPlan | null;
    try {
      plan = this.planner.planAsync === undefined
        ? this.planner.plan(prepared.input)
        : await this.planner.planAsync(prepared.input);
    } catch (error) {
      this.recordPlanningError(error);
      return null;
    }
    return this.commitStep(prepared, plan, context);
  }

  /** Applies a newly saved model provider to an autonomous planner. */
  updatePlannerProvider(provider: ModelProvider | null): void {
    this.planner.updateProvider?.(provider);
  }

  updatePlannerDeadline(deadlineMs: number): void {
    this.planner.updateDeadline?.(deadlineMs);
  }

  private prepareStep(context: GoalRuntimeContext): PreparedGoalStep | null {
    if (!this.enabled || this.goal === null || this.progress === null) return null;
    if (this.goal.status === "paused" || this.goal.status === "completed") return null;
    this.observeBridge(context);
    if (this.inFlight !== null) {
      const now = this.clock.now();
      const silentFor = now - this.inFlight.startedAt;
      const runningFor = now - this.inFlight.dispatchedAt;
      if (
        silentFor > this.taskTimeoutMs ||
        runningFor > this.hardTaskTimeoutMs
      ) {
        const stale = this.inFlight;
        this.inFlight = null;
        const interruption: GoalInterruption = {
          decisionId: stale.decision.id,
          commandId: stale.commandId,
          decision: stale.decision,
        };
        const detail =
          runningFor > this.hardTaskTimeoutMs
            ? `任务超过 ${Math.round(this.hardTaskTimeoutMs / 1000)} 秒仍未完成，已硬熔断`
            : `任务超过 ${Math.round(this.taskTimeoutMs / 1000)} 秒没有终态`;
        this.noteTreeOutcome(stale.taskId, stale.strategyKey, {
          status: "timeout",
          errorCode: "E_TIMEOUT",
          detail,
          at: now,
          changes: [],
        });
        this.recordFailure(
          stale.taskId,
          stale.strategyKey,
          detail,
          "timeout",
          now,
          stale.decision.text,
          stale.decision.intent,
          "E_TIMEOUT",
        );
        this.expiryHandler?.(interruption);
        return null;
      }
      return null;
    }
    this.maybeRetryBlockedTree();
    if (this.clock.now() < this.retryAt) return null;
    if (this.clock.now() < this.nextPlanAt) return null;

    const paused = pauseReason(context, this.clock.now());
    if (paused !== null) {
      this.progress = {
        ...this.progress,
        status: paused.status,
        lastFailure: paused.reason,
        nextTask: "",
        updatedAt: this.clock.now(),
      };
      this.persist();
      return null;
    }
    /*
     * A transient pause (world snapshot missing during a bridge reconnect, a
     * menu, a reflex hand-off) must not outlive its cause. Operator pauses
     * set `goal.status` too, so only an active goal is auto-resumed here.
     */
    if (this.progress.status === "paused" && this.goal.status === "active") {
      this.progress = {
        ...this.progress,
        status: this.resumedStatus(),
        lastFailure: null,
        updatedAt: this.clock.now(),
      };
      this.persist();
    }

    return {
      goalId: this.goal.id,
      goalVersion: this.goal.version,
      input: {
        goal: this.goal,
        progress: this.progress,
        world: context.world,
        health: context.bridge,
        proposals: this.proposals?.() ?? [],
        lastFailure: this.lastFailure,
        consecutiveFailures: this.consecutiveFailures,
        failures: this.failures,
        lastFailureStrategy: this.lastFailureStrategy,
        ...(this.treeOwned
          ? { treeSnapshot: this.taskTree?.snapshot() ?? null }
          : {}),
      },
    };
  }

  /**
   * A reconnect invalidates the command that was in flight and may also
   * explain the previous two failures (the client was replaced, the body
   * respawned, a tool reappeared). Retry blocked tree branches once per
   * generation; a genuinely impossible branch simply fails again.
   */
  private observeBridge(context: GoalRuntimeContext): void {
    const bridge = context.bridge;
    const connected = bridge !== null && bridge.connected;
    const generation = connected ? bridge.generation : null;
    const reconnected =
      connected &&
      (!this.bridgeConnected ||
        (generation !== null && generation !== this.bridgeGeneration));
    this.bridgeConnected = connected;
    this.bridgeGeneration = generation;
    if (!reconnected) return;
    this.retryBlockedTree("身体重新连接，重新验证受阻任务");
  }

  /**
   * A twice-failed branch is parked, but the world keeps moving: a dropped
   * item can become reachable and a reissued command can find a different
   * cave mouth. Reopen the tree after a bounded cooldown instead of waiting
   * for a bridge reconnect that may never happen.
   */
  private maybeRetryBlockedTree(): void {
    if (this.blockedRetryAt <= 0) return;
    if (this.clock.now() < this.blockedRetryAt) return;
    this.blockedRetryAt = 0;
    this.retryAt = 0;
    this.nextPlanAt = 0;
    if (!this.treeOwned || this.progress?.status !== "blocked") {
      this.blockedRetryCount = 0;
      return;
    }
    this.retryBlockedTree("受阻任务退避结束，重新验证");
  }

  private scheduleBlockedRetry(): void {
    if (
      !this.treeOwned ||
      this.goal === null ||
      this.goal.status === "paused" ||
      this.goal.status === "completed"
    ) {
      return;
    }
    const hasParkedBranch =
      this.taskTree
        ?.snapshot()
        .nodes.some(
          (node) => node.state === "blocked" || node.state === "failed",
        ) ?? false;
    if (!hasParkedBranch) return;
    const delay = Math.min(
      this.blockedRetryBaseMs * 2 ** this.blockedRetryCount,
      this.blockedRetryMaxMs,
    );
    this.blockedRetryCount += 1;
    this.blockedRetryAt = this.clock.now() + delay;
    this.retryAt = Math.max(this.retryAt, this.blockedRetryAt);
    if (this.progress !== null) {
      this.progress = {
        ...this.progress,
        retryAt: this.blockedRetryAt,
      };
    }
  }

  private retryBlockedTree(reason: string): void {
    if (!this.treeOwned) return;
    const local = this.taskTree?.reviveFailures(reason) ?? 0;
    const planned = this.planner.retryFailed?.(reason) ?? 0;
    if (local === 0 && planned === 0) return;
    const snapshot = this.planner.treeSnapshot?.() ?? null;
    if (planned > 0 && snapshot !== null) {
      this.adoptTreeSnapshot(snapshot);
    } else if (this.taskTree !== null) {
      this.adoptTreeSnapshot(this.taskTree.snapshot());
    }
    this.inFlight = null;
    this.consecutiveFailures = 0;
    this.retryAt = 0;
    this.nextPlanAt = 0;
    this.blockedRetryAt = 0;
    this.blockedRetryCount = 0;
    this.circuit = null;
    this.lastFailureStrategy = null;
    this.taskFailureRecord = null;
    this.lastFailure = `${reason}，已重置 ${Math.max(local, planned)} 个受阻任务节点`;
    if (this.progress !== null) {
      this.progress = {
        ...this.progress,
        status: this.resumedStatus(),
        nextTask: "",
        lastFailure: this.lastFailure,
        consecutiveFailures: 0,
        retryAt: null,
        updatedAt: this.clock.now(),
      };
    }
    this.persist();
  }

  private commitStep(
    prepared: PreparedGoalStep,
    plan: GoalPlan | null,
    context: GoalRuntimeContext,
  ): GoalDispatch | null {
    if (
      !this.enabled ||
      this.goal === null ||
      this.progress === null ||
      this.inFlight !== null ||
      this.goal.id !== prepared.goalId ||
      this.goal.version !== prepared.goalVersion ||
      this.goal.status === "paused" ||
      this.goal.status === "completed" ||
      this.clock.now() < this.retryAt
    ) {
      return null;
    }
    if (plan === null) {
      this.progress = {
        ...this.progress,
        status: "blocked",
        nextTask: "",
        lastFailure: "目标引擎没有返回可执行计划",
        updatedAt: this.clock.now(),
      };
      this.persist();
      return null;
    }

    this.applyPlan(plan);
    if (this.treeOwned) {
      this.adoptTreeSnapshot(plan.treeSnapshot ?? null);
      const taskNodeId = plan.nextTask?.taskId ?? null;
      if (taskNodeId !== null) {
        this.taskNodeId = taskNodeId;
        this.taskMilestoneId =
          this.taskTree?.get(taskNodeId)?.parentId ?? null;
      }
      this.taskTargetFamily = plan.stage.id;
    }
    if (
      plan.complete === true &&
      plan.nextTask === null &&
      (this.treeOwned || goalReachesTarget(this.goal, plan.stage.id))
    ) {
      this.goal = { ...this.goal, status: "completed" };
      this.progress = {
        ...this.progress,
        status: "completed",
        nextTask: "",
        updatedAt: this.clock.now(),
      };
      this.persist();
      return null;
    }
    if (plan.blockedReason !== undefined && plan.blockedReason !== null) {
      this.progress = {
        ...this.progress,
        status: "blocked",
        nextTask: "",
        lastFailure: plan.blockedReason,
        updatedAt: this.clock.now(),
      };
      this.scheduleBlockedRetry();
      this.persist();
      return null;
    }
    if (plan.nextTask === null) {
      // An empty plan without a blocked reason used to persist silently, so
      // the goal loop retried every tick while the console said nothing and
      // the body idled. Surface the condition like every other standstill.
      this.progress = {
        ...this.progress,
        status: "blocked",
        nextTask: "",
        lastFailure: "目标引擎返回了没有下一步任务的计划",
        updatedAt: this.clock.now(),
      };
      this.scheduleBlockedRetry();
      this.persist();
      return null;
    }

    const strategyKey = plan.strategyKey ?? `${plan.stage.id}:${stableSkillKey(plan.nextTask.skill)}`;
    const taskId = plan.nextTask.taskId ?? `task:${strategyKey}`;
    const now = this.clock.now();
    if (this.circuit !== null) {
      if (now >= this.circuit.until) {
        this.circuit = null;
      } else if (
        normalizedStrategy(this.circuit.strategyKey) === normalizedStrategy(strategyKey)
      ) {
        const detail = `策略熔断中（同一失败 60 秒内重复）：${this.circuit.detail}`;
        this.lastFailure = detail;
        if (this.progress !== null) {
          this.progress = {
            ...this.progress,
            status: "active",
            nextTask: "",
            lastFailure: detail,
            retryAt: Math.min(this.circuit.until, now + 15_000),
            updatedAt: now,
          };
        }
        this.retryAt = Math.max(this.retryAt, Math.min(this.circuit.until, now + 15_000));
        this.persist();
        return null;
      }
    }
    // One retry is allowed after a body failure: the world may have changed
    // (a dropped item became reachable, the body respawned, a menu closed).
    // A second consecutive failure of the same strategy is the point at which
    // repeating it becomes a loop rather than recovery.
    if (
      this.lastFailureStrategy !== null &&
      normalizedStrategy(this.lastFailureStrategy) === normalizedStrategy(strategyKey) &&
      this.consecutiveFailures >= 2
    ) {
      // A repeated strategy after a real body failure is not proof the goal
      // is impossible: terrain changes, the body may have moved, and the
      // next observation can open a route. Keep the whole run autonomous by
      // allowing the planner's own alternative ordering and the existing
      // exponential backoff to handle it instead of parking the goal.
      this.lastFailure = `同一策略已连续失败 ${this.consecutiveFailures} 次，继续退避后重试：${
        this.lastFailure ?? "原因未知"
      }`;
    }
    const skill = skillCallSchema.safeParse(plan.nextTask.skill);
    if (!skill.success) {
      this.noteUnstartedFailure(
        taskId,
        strategyKey,
        `目标引擎产出非法技能：${skill.error.message}`,
        "E_PRECONDITION",
        now,
      );
      this.recordFailure(
        taskId,
        strategyKey,
        `目标引擎产出非法技能：${skill.error.message}`,
        "failed",
        this.clock.now(),
        plan.nextTask.text,
        plan.nextTask.intent,
      );
      return null;
    }
    if (
      skill.data.name === "place_block" &&
      this.recentStationPlacement !== null &&
      this.recentStationPlacement.block === String(skill.data.args["block"] ?? "") &&
      now - this.recentStationPlacement.at < 2_000
    ) {
      this.nextPlanAt = Math.max(
        this.nextPlanAt,
        this.recentStationPlacement.at + 2_000,
      );
      return null;
    }
    if (
      skill.data.name === "place_block" &&
      String(skill.data.args["block"] ?? "") === "minecraft:torch" &&
      now - this.recentTorchPlacementAt < 6_000
    ) {
      this.nextPlanAt = Math.max(
        this.nextPlanAt,
        this.recentTorchPlacementAt + 6_000,
      );
      return null;
    }
    if (!context.bridge?.skills.includes(skill.data.name)) {
      this.noteUnstartedFailure(
        taskId,
        strategyKey,
        `执行闸门：身体未声明 ${skill.data.name}，任务未下达`,
        "E_PRECONDITION",
        this.clock.now(),
      );
      this.recordFailure(
        taskId,
        strategyKey,
        `执行闸门：身体未声明 ${skill.data.name}，任务未下达`,
        "failed",
        this.clock.now(),
        plan.nextTask.text,
        plan.nextTask.intent,
      );
      return null;
    }
    if (!this.treeOwned) {
      this.noteTaskStarted(plan, taskId, this.clock.now());
    }

    const id = this.clock.newId();
    // A decision is a fresh execution attempt, not a transport retry. Reusing
    // a domain-stable key would hit action_attempt's UNIQUE(idempotency_key)
    // and silently suppress every retry after the first failure.
    const issuedSkill = {
      ...skill.data,
      idempotencyKey: `goal:${this.goal.id}:${this.goal.version}:${id}`,
    };
    const decision: Decision = {
      id,
      // The event id becomes the durable source id. An in-memory counter would
      // restart at one and collide with the previous process's first task.
      eventId: `goal:${this.goal.id}:${this.goal.version}:${id}`,
      nickname: "目标运行时",
      text: plan.nextTask.text,
      intent: plan.nextTask.intent,
      decision: "EXECUTE",
      priority: "plan",
      reason: plan.nextTask.reason,
      score: 1,
      stage: "planned",
      skill: issuedSkill,
      speech: goalSpeech(plan.nextTask, this.speechVariation++),
      audienceRef: "",
      trace: null,
      ...(plan.cardId === undefined || plan.cardTitle === undefined
        ? {}
        : {
            playbook: {
              id: plan.cardId,
              title: plan.cardTitle,
              status: plan.cardStatus ?? "available",
              reason: plan.cardReason ?? "",
              switchReason: plan.cardSwitchReason ?? null,
              modelChoice: plan.cardModelChoice ?? null,
              fallbackReason: plan.cardFallbackReason ?? null,
              failureCode: null,
              recoveryId: null,
              routeMode:
                skill.data.name === "goto"
                  ? (navigationModeSchema.safeParse(skill.data.args.mode).data ?? "walk")
                  : null,
              targetLock: plan.targetLock ?? null,
            },
          }),
      at: now,
    };
    const commandId = this.clock.newId();
    this.inFlight = {
      decision,
      commandId,
      taskId,
      strategyKey,
      startedAt: now,
      dispatchedAt: now,
      lastProgress: null,
    };
    this.blockedRetryAt = 0;
    this.blockedRetryCount = 0;
    this.progress = {
      ...this.progress,
      nextTask: plan.nextTask.text,
      lastFailure: null,
      updatedAt: now,
    };
    this.recordDecision?.(decision);
    this.persist();
    return { commandId, taskId, strategyKey, decision };
  }

  private recordPlanningError(error: unknown): void {
    this.recordFailure(
      null,
      null,
      `目标规划失败：${error instanceof Error ? error.message : String(error)}`,
      "failed",
    );
  }

  /** Applies the body's terminal result. Unknown or duplicate ids are ignored. */
  settle(decisionId: string, outcome: GoalSettlement): boolean {
    const current = this.inFlight;
    if (current === null || current.decision.id !== decisionId) return false;
    this.inFlight = null;
    if (outcome.status !== "cancelled" && outcome.status !== "preempted") {
      this.nextPlanAt = Math.max(
        this.nextPlanAt,
        this.clock.now() + this.settlementObservationMs,
      );
    }
    if (outcome.status === "completed") {
      const missingEvidence = completionEvidenceProblem(current.decision, outcome.changes ?? []);
      if (missingEvidence !== null) {
        this.applyTaskSettlement(current, "failed", {
          ...outcome,
          detail: missingEvidence,
        });
        this.recordFailure(
          current.taskId,
          current.strategyKey,
          missingEvidence,
          "failed",
          outcome.at,
          current.decision.text,
          current.decision.intent,
        );
        this.onSettlement?.({
          decision: current.decision,
          strategyKey: current.strategyKey,
          status: "failed",
          errorCode: outcome.errorCode ?? null,
          detail: missingEvidence,
          changes: outcome.changes ?? [],
          at: outcome.at,
        });
        return true;
      }
      this.applyTaskSettlement(current, "completed", outcome);
      if (
        current.decision.skill?.name === "place_block" &&
        STATION_PLACEMENT.test(
          String(current.decision.skill.args["block"] ?? ""),
        )
      ) {
        this.recentStationPlacement = {
          block: String(current.decision.skill.args["block"] ?? ""),
          at: outcome.at,
        };
      }
      if (
        current.decision.skill?.name === "place_block" &&
        String(current.decision.skill.args["block"] ?? "") === "minecraft:torch"
      ) {
        this.recentTorchPlacementAt = outcome.at;
      }
      this.consecutiveFailures = 0;
      this.lastFailure = null;
      this.lastFailureStrategy = null;
      this.retryAt = 0;
      this.blockedRetryAt = 0;
      this.blockedRetryCount = 0;
      this.circuit = null;
      this.failureWindow = [];
      // A success breaks the "same stage failed twice in a row" sequence.
      // Keep failures from other stages; `recover()` scopes by stage anyway.
      this.failures = this.failures.filter(
        (entry) => this.progress === null || entry.stage !== toGoalId(this.progress.stage.id),
      );
      if (this.progress !== null) {
        this.progress = {
          ...this.progress,
          status: this.progress.status === "completed" ? "completed" : this.resumedStatus(),
          lastFailure: null,
          consecutiveFailures: 0,
          retryAt: null,
          updatedAt: outcome.at,
        };
      }
      this.onSettlement?.({
        decision: current.decision,
        strategyKey: current.strategyKey,
        status: "completed",
        errorCode: null,
        detail: null,
        changes: outcome.changes ?? [],
        at: outcome.at,
      });
      this.persist();
      return true;
    }
    if (outcome.status === "preempted") {
      this.applyTaskSettlement(current, "preempted", outcome);
      /*
       * Death and a deliberate safety handoff are not strategy failures. The
       * body preempts its in-flight skill, the planner waits for a live body,
       * and the next observation picks a card from the respawned position.
       * Counting this as a failure opened the same-strategy circuit after a
       * normal death and made the agent back off instead of continuing.
       */
      const detail = failureDetail(outcome);
      this.retryAt = 0;
      if (this.progress !== null) {
        this.progress = {
          ...this.progress,
          status: this.progress.status === "paused" ? "paused" : "active",
          nextTask: "",
          lastFailure: detail,
          retryAt: null,
          updatedAt: outcome.at,
        };
      }
      this.onSettlement?.({
        decision: current.decision,
        strategyKey: current.strategyKey,
        status: outcome.status,
        errorCode: outcome.errorCode ?? null,
        detail,
        changes: outcome.changes ?? [],
        at: outcome.at,
      });
      this.persist();
      return true;
    }
    if (outcome.status === "cancelled") {
      this.applyTaskSettlement(current, "cancelled", outcome);
    } else {
      this.applyTaskSettlement(current, outcome.status, outcome);
    }
    this.recordFailure(
      current.taskId,
      current.strategyKey,
      failureDetail(outcome),
      outcome.status,
      outcome.at,
      current.decision.text,
      current.decision.intent,
      outcome.errorCode ?? null,
    );
    this.onSettlement?.({
      decision: current.decision,
      strategyKey: current.strategyKey,
      status: outcome.status,
      errorCode: outcome.errorCode ?? null,
      detail: failureDetail(outcome),
      changes: outcome.changes ?? [],
      at: outcome.at,
    });
    return true;
  }

  /** Records a body refusal that never produced a decision row. */
  failDispatch(taskId: string, strategyKey: string, detail: string): void {
    if (this.inFlight === null) return;
    const current = this.inFlight;
    this.inFlight = null;
    this.applyTaskSettlement(current, "failed", {
      status: "failed",
      errorCode: "E_DISPATCH",
      detail,
      at: this.clock.now(),
      changes: [],
    });
    this.recordFailure(taskId, strategyKey, detail, "failed");
    this.onSettlement?.({
      decision: current.decision,
      strategyKey,
      status: "failed",
      errorCode: "E_DISPATCH",
      detail,
      changes: [],
      at: this.clock.now(),
    });
  }

  /**
   * The tree engine returns its complete state with every plan. Keep a local
   * copy for persistence and the console, but never derive the next task from
   * it; only the planner may move the cursor.
   */
  private adoptTreeSnapshot(snapshot: TaskTreeSnapshot | null): void {
    if (!this.treeOwned) return;
    if (snapshot === null) {
      this.taskTree = null;
      this.taskRootId = null;
      this.taskNodeId = null;
      this.taskMilestoneId = null;
      this.taskEvidenceRefs = [];
      this.taskFailureRecord = null;
      return;
    }
    try {
      this.taskTree = TaskTree.restore(snapshot, () => this.clock.now());
      this.taskRootId = snapshot.rootId;
      const cursor = this.taskTree.current;
      this.taskNodeId = cursor?.id ?? null;
      this.taskMilestoneId = cursor?.parentId ?? null;
      this.taskEvidenceRefs = cursor === null ? [] : [...cursor.successEvidence].slice(-16);
      this.taskFailureRecord =
        cursor === null || cursor.failureCategory === null
          ? null
          : {
              category: cursor.failureCategory,
              detail: cursor.failureDetail ?? "任务树记录了一次失败",
              at: cursor.updatedAt,
            };
    } catch (error) {
      this.onIncident?.({
        code: "GOAL_TREE_SNAPSHOT_INVALID",
        severity: "warn",
        detail: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      this.taskTree = null;
      this.taskRootId = null;
      this.taskNodeId = null;
      this.taskMilestoneId = null;
    }
  }

  private applyTaskSettlement(
    current: {
      readonly taskId: string;
      readonly strategyKey: string;
      readonly decision: { readonly id: string };
    },
    status: GoalSettlement["status"],
    outcome: GoalSettlement,
  ): void {
    if (this.treeOwned) {
      this.noteTreeOutcome(
        current.taskId,
        current.strategyKey,
        outcome,
        current.decision.id,
      );
      return;
    }
    this.noteTaskSettled(current.taskId, status, outcome);
  }

  private noteUnstartedFailure(
    taskId: string,
    strategyKey: string,
    detail: string,
    errorCode: string,
    at: number,
  ): void {
    if (!this.treeOwned) return;
    this.noteTreeOutcome(taskId, strategyKey, {
      status: "failed",
      errorCode,
      detail,
      at,
      changes: [],
    });
  }

  private noteTreeOutcome(
    taskId: string,
    strategyKey: string,
    outcome: GoalSettlement,
    decisionId = "",
  ): void {
    if (!this.treeOwned) return;
    try {
      this.planner.noteSettlement?.({
        decisionId,
        taskId,
        strategyKey,
        outcome,
      });
      this.adoptTreeSnapshot(this.planner.treeSnapshot?.() ?? null);
    } catch (error) {
      this.onIncident?.({
        code: "GOAL_TREE_SETTLEMENT_FAILED",
        severity: "warn",
        detail: {
          taskId,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  snapshot(): GoalRuntimeRecord {
    return {
      goal: this.goal,
      enabled: this.enabled,
      progress: this.progress,
      currentDecisionId: this.inFlight?.decision.id ?? null,
      currentStrategyKey: this.inFlight?.strategyKey ?? null,
      lastFailure: this.lastFailure,
      lastFailureStrategy: this.lastFailureStrategy,
      consecutiveFailures: this.consecutiveFailures,
      retryAt: this.retryAt,
      updatedAt: this.clock.now(),
      failures: this.failures,
      taskTree: this.taskTree?.snapshot() ?? null,
      taskNode:
        this.taskNodeId === null || this.taskTree === null
          ? null
          : this.taskTree.get(this.taskNodeId),
      targetFamily: this.taskTargetFamily,
      evidenceRefs: [...this.taskEvidenceRefs],
      failureRecord: this.taskFailureRecord,
    };
  }

  /**
   * Task trees are Agent-side state. The projection is bounded and read-only;
   * it never selects the next branch or replaces a planner decision.
   */
  private projectTaskTree(): GoalTaskTree | null {
    if (this.taskTree === null) return null;
    const projected = projectGoalTree(
      this.taskTree.snapshot(),
      this.clock.now(),
    );
    if (projected === null) return null;
    return {
      ...projected,
      blockedReason:
        projected.blockedReason ?? this.taskFailureRecord?.detail ?? null,
      targetFamily: this.taskTargetFamily ?? projected.targetFamily,
      // The legacy tree records its acquisition branch as pending nodes. The
      // tree engine already returns the whole tree in `nodes`, so it needs no
      // separate bounded branch list.
      branches: this.treeOwned
        ? []
        : [...this.taskTree.snapshot().nodes]
        .filter((node) => node.parentId !== null)
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(-32)
        .map((node) => ({
          id: node.id,
          parentId: node.parentId,
          intent: node.intent.slice(0, 120),
          state: node.state,
          targetFamily: node.targetFamily.slice(0, 120),
        })),
    };
  }

  /**
   * Adds the task the planner is about to dispatch to the active branch. The
   * tree records intent and evidence; it never chooses a target or a skill.
   */
  private noteTaskStarted(
    plan: GoalPlan,
    taskId: string,
    at: number,
  ): void {
    if (plan.nextTask === null) return;
    if (this.taskTree === null || this.taskRootId === null || this.taskTargetFamily !== plan.stage.id) {
      this.taskTree = new TaskTree(() => this.clock.now());
      const root = this.taskTree.createRoot({
        intent: this.goal?.title ?? plan.stage.title,
        targetFamily: plan.stage.id,
        priority: "goal",
        sourceKey: `stage:${plan.stage.id}`,
      });
      this.taskRootId = root.id;
      this.taskMilestoneId = null;
      this.taskTargetFamily = plan.stage.id;
    } else if (this.taskTree.snapshot().nodes.length > 64) {
      // Bounded history: committed evidence is preserved for the current
      // stage, while an old exploration branch cannot grow without limit.
      const stage = plan.stage.id;
      this.taskTree = new TaskTree(() => this.clock.now());
      const root = this.taskTree.createRoot({
        intent: this.goal?.title ?? plan.stage.title,
        targetFamily: stage,
        priority: "goal",
        sourceKey: `stage:${stage}`,
      });
      this.taskRootId = root.id;
      this.taskMilestoneId = null;
      this.taskTargetFamily = stage;
    }
    /*
     * Group dispatched actions under the milestone they serve. Attaching every
     * task directly to the goal root produced a flat list in the live console
     * that showed no relation between "gather wood", "craft a table" and the
     * milestone they advance.
     */
    const milestoneKey =
      `milestone:${plan.stage.id}:${plan.milestone.id || plan.milestone.title}`;
    const existingMilestone = [...this.taskTree.snapshot().nodes].find(
      (node) =>
        node.parentId === this.taskRootId && node.sourceKey === milestoneKey,
    );
    if (existingMilestone !== undefined) {
      this.taskMilestoneId = existingMilestone.id;
    } else {
      const [milestone] = this.taskTree.attach(this.taskRootId, [
        {
          intent: plan.milestone.title,
          targetFamily: plan.stage.id,
          priority: "goal",
          sourceKey: milestoneKey,
          successEvidence: [],
        },
      ]);
      this.taskMilestoneId = milestone?.id ?? null;
    }
    const priority = plan.nextTask.critical === true ? "survival" : "goal";
    const current = this.taskTree.current;
    const scheduler = new TaskScheduler(() => this.clock.now());
    const preempting =
      current !== null &&
      current.state === "active" &&
      scheduler.preemptsByPriority(current.priority, priority);
    const input = {
      parentId: this.taskMilestoneId ?? this.taskRootId,
      intent: plan.nextTask.text,
      targetFamily: plan.stage.id,
      priority,
      sourceKey: taskId,
      successEvidence: [],
    } as const;
    const node = preempting
      ? this.taskTree.preempt(input)
      : this.taskTree.add(input);
    if (!preempting) this.taskTree.activate(node.id);
    this.attachAcquisition(
      node.id,
      plan.nextTask.acquisition ?? null,
    );
    this.taskNodeId = node.id;
    this.taskFailureRecord = null;
    this.progress =
      this.progress === null
        ? this.progress
        : { ...this.progress, taskTree: this.projectTaskTree(), updatedAt: at };
  }

  private noteTaskSettled(
    taskId: string,
    status: GoalSettlement["status"],
    outcome: GoalSettlement,
  ): void {
    if (this.taskTree === null || this.taskNodeId === null) return;
    const nodeId = this.taskNodeId;
    const resuming = this.taskTree.snapshot().pausedCursorId !== null;
    const refs = (outcome.changes ?? [])
      .map((change) => `${change.kind}: ${change.detail}`.slice(0, 240))
      .filter((entry) => entry.length > 0);
    if (status === "completed") {
      const evidence = refs.length > 0 ? refs : [`settled: ${taskId}`.slice(0, 240)];
      this.taskEvidenceRefs = [...this.taskEvidenceRefs, ...evidence].slice(-16);
      try {
        this.taskTree.completeBranch(nodeId, evidence);
      } catch {
        // A node already completed by recovery is not an execution failure.
      }
      this.taskNodeId = null;
      if (resuming) this.taskTree.resumeAfterPreemption();
      return;
    }
    if (status === "cancelled" || status === "preempted") {
      this.taskTree.pause(nodeId);
      // A preempted task remains the active branch so a restart can explain
      // where it stopped; the next plan will activate a fresh node.
      this.taskNodeId = null;
      if (resuming) this.taskTree.resumeAfterPreemption();
      return;
    }
    const category = taskFailureCategory(outcome.errorCode);
    this.taskFailureRecord = {
      category,
      detail: failureDetail(outcome).slice(0, 600),
      at: outcome.at,
    };
    this.taskTree.fail(nodeId, category, this.taskFailureRecord.detail, {
      blacklistMs: 10 * 60_000,
    });
    this.taskNodeId = null;
    if (resuming) this.taskTree.resumeAfterPreemption();
  }

  /**
   * Attaches the graph's AND/OR prerequisite branch as pending nodes. This is
   * deliberate context, not a second scheduler: the body still receives one
   * compiled job, while `branches` is a bounded projection for the console.
   */
  private attachAcquisition(
    parentId: string,
    root: AcquisitionNode | null,
  ): void {
    if (root === null || this.taskTree === null) return;
    let attached = 0;
    const visit = (
      parent: string,
      node: AcquisitionNode,
      depth: number,
    ): void => {
      if (depth > 5 || attached >= 24) return;
      const created = this.taskTree!.attach(parent, [
        {
          intent: acquisitionIntent(node),
          targetFamily:
            node.kind === "item"
              ? `item:${node.target}`
              : node.kind === "station"
                ? `station:${node.target}`
                : `action:${node.target}`,
          quantity: node.quantity,
          priority: "goal",
          sourceKey: `acq:${node.key}:${depth}`,
          successEvidence: [],
        },
      ])[0];
      if (created === undefined) return;
      attached++;
      for (const child of node.children) visit(created.id, child, depth + 1);
    };
    visit(parentId, root, 0);
  }

  private applyPlan(plan: GoalPlan): void {
    if (this.progress === null) return;
    const now = this.clock.now();
    const completed = plan.milestones.filter((item) => item.status === "completed").length;
    const unverified = plan.milestones.filter((item) => item.status === "unverified").length;
    this.progress = {
      ...this.progress,
      status: plan.verified ? "active" : "unverified",
      stage: plan.stage,
      milestone: plan.milestone,
      milestones: [...plan.milestones],
      completed,
      unverified,
      nextTask: plan.nextTask?.text ?? "",
      targetLock: mergeTargetLock(
        this.progress.targetLock ?? null,
        plan.targetLock ?? null,
        now,
      ),
      playbook:
        plan.cardId === undefined || plan.cardTitle === undefined
          ? null
          : {
              cardId: plan.cardId,
              cardTitle: plan.cardTitle,
              cardReason: plan.cardReason ?? "",
              status: plan.cardStatus ?? "available",
              activeForMs: plan.cardActiveForMs ?? 0,
              minDwellRemainingMs: plan.cardMinDwellRemainingMs ?? 0,
              switchReason: plan.cardSwitchReason ?? null,
              modelChoice: plan.cardModelChoice ?? null,
              fallbackReason: plan.cardFallbackReason ?? null,
              failureCode: null,
              recoveryId: plan.cardRecoveryId ?? null,
              alternatives: [...(plan.cardAlternatives ?? [])].slice(0, 8),
            },
      updatedAt: now,
    };
    if (this.goal !== null && this.goal.status !== "completed") {
      this.goal = { ...this.goal, status: plan.verified ? "active" : "unverified" };
    }
  }

  private recordFailure(
    taskId: string | null,
    strategyKey: string | null,
    detail: string,
    status: GoalSettlement["status"],
    at = this.clock.now(),
    taskTitle?: string,
    intent?: Intent,
    errorCode: string | null = null,
  ): void {
    this.consecutiveFailures += 1;
    /*
     * Keep the structured bridge code in the same string the planner sees.
     * `detail` alone ("no natural route within the walk budget") is identical
     * for E_UNREACHABLE and E_ENCLOSED, so the playbook could never tell a
     * sealed hut apart from an ordinary unreachable target. The prefix is
     * also useful in the console and survives a restart with the goal record.
     */
    this.lastFailure =
      errorCode === null || detail.startsWith(errorCode)
        ? detail
        : `${errorCode}: ${detail}`;
    this.lastFailureStrategy = strategyKey;
    this.noteFailureFingerprint(
      errorCode ?? status,
      detail,
      at,
      strategyKey,
      status,
    );
    if (this.progress !== null && taskId !== null) {
      this.failures.push({
        taskId,
        stage: toGoalId(this.progress.stage.id),
        code: status,
        detail,
        attempts: this.consecutiveFailures,
      });
      if (this.failures.length > 20) this.failures.splice(0, this.failures.length - 20);
    }
    // Once the run has burned through the normal retry budget, keep trying
    // but at the longest delay. This preserves the operator's ability to see
    // a persistent obstacle without silently ending the autonomous goal.
    const delay =
      this.consecutiveFailures >= this.maxConsecutiveFailures
        ? this.failureMaxMs
        : Math.min(
            this.failureBaseMs * 2 ** (this.consecutiveFailures - 1),
            this.failureMaxMs,
          );
    this.retryAt = at + delay;
    if (this.progress !== null) {
      this.progress = {
        ...this.progress,
        // The goal stays active. Reaching the failure cap only selects the
        // longest backoff: an open world can change under the body, and a
        // permanent block would end the autonomous run for good.
        status: this.progress.status === "paused" ? "paused" : "active",
        nextTask: "",
        lastFailure: detail,
        consecutiveFailures: this.consecutiveFailures,
        retryAt:
          status === "cancelled" || status === "preempted" ? null : this.retryAt,
        targetLock:
          errorCode === "E_UNREACHABLE" ||
          errorCode === "E_ENCLOSED"
            ? null
            : this.progress.targetLock,
        playbook:
          this.progress.playbook == null
            ? null
            : {
                ...this.progress.playbook,
                failureCode: errorCode ?? status,
              },
        updatedAt: at,
      };
    }
    if (status === "cancelled" || status === "preempted") {
      this.retryAt = at;
    }
    this.persist();
  }

  /**
   * A body can fail the same action for the same reason indefinitely. The
   * exponential delay alone only slows that loop. Track the exact failure
   * fingerprint and open a short circuit so the next planning boundary is
   * forced onto a recovery/alternative card instead of replaying it.
   */
  private noteFailureFingerprint(
    code: string,
    detail: string,
    at: number,
    strategyKey: string | null,
    status: GoalSettlement["status"],
  ): void {
    if (
      strategyKey === null ||
      status === "cancelled" ||
      status === "preempted"
    ) {
      return;
    }
    this.failureWindow = this.failureWindow.filter(
      (entry) => at - entry.at <= this.circuitWindowMs,
    );
    const fingerprint = `${code}\u0000${detail}`;
    this.failureWindow.push({ fingerprint, at });
    const count = this.failureWindow.filter(
      (entry) => entry.fingerprint === fingerprint,
    ).length;
    if (count < this.circuitFailureThreshold) return;
    this.circuit = {
      strategyKey,
      fingerprint,
      detail,
      until: at + this.circuitCooldownMs,
    };
    this.failureWindow = [];
    this.onIncident?.({
      code: "GOAL_STRATEGY_CIRCUIT_OPEN",
      severity: "warn",
      detail: {
        strategyKey,
        failureCode: code,
        failureDetail: detail,
        occurrences: count,
        windowMs: this.circuitWindowMs,
        cooldownMs: this.circuitCooldownMs,
      },
    });
  }

  private resumedStatus(): GoalStatus {
    if (this.progress === null) return "unverified";
    if (this.progress.completed > 0 || this.progress.status === "active") return "active";
    return "unverified";
  }

  private persist(): void {
    if (this.progress !== null) {
      this.progress = {
        ...this.progress,
        taskTree: this.projectTaskTree(),
      };
    }
    this.store.save(this.snapshot());
    this.onUpdate?.(this.currentProgress);
  }
}

/**
 * A task's own verify() needs fresh world facts, which the runtime does not
 * receive at settlement time. The body's confirmed changes are the next best
 * evidence: they must at least exist, and state-changing skills must contain
 * the specific effect the planner asked for. This prevents an empty result
 * from advancing a survival stage.
 */
export function completionEvidenceProblem(
  decision: Decision,
  changes: NonNullable<GoalSettlement["changes"]>,
): string | null {
  /*
   * "Already air" and "already present" are observations, not changes. A
   * body that replays the same cell can otherwise report "completed" forever
   * while the world never moves. Treat them as absent evidence so the
   * settlement fails, backs off, and the planner has to choose a new task.
   */
  const confirmed = changes.filter(
    (change) => !/\(already (?:air|present)\)\s*$/u.test(change.detail),
  );
  // `sleep` reports its evidence as `slept`, but a wake-up can be confirmed
  // after the body result. Do not reject it for lack of a change entry.
  if (confirmed.length === 0 && decision.skill?.name !== "sleep") {
    return `任务返回完成但没有已确认的世界变化：${decision.text}`;
  }
  const kinds = new Set(confirmed.map((change) => change.kind));
  const skill = decision.skill;
  if (skill === null) return "任务完成但没有技能证据";
  switch (skill.name) {
    case "eat":
      return kinds.has("food_consumed")
        ? null
        : `进食完成但没有消耗证据：${decision.text}`;
    case "place_block":
      return kinds.has("block_placed")
        ? null
        : `放置完成但没有方块证据：${decision.text}`;
    case "attack":
      return kinds.has("entity_damaged")
        ? null
        : `攻击完成但没有实体受伤证据：${decision.text}`;
    case "craft":
      return kinds.has("item_crafted")
        ? null
        : `合成完成但没有物品证据：${decision.text}`;
    case "mine_block":
    case "chop_tree":
      return kinds.has("block_broken")
        ? null
        : `挖掘完成但没有方块破坏证据：${decision.text}`;
    case "collect_items":
      return kinds.has("item_collected")
        ? null
        : `收集完成但没有物品证据：${decision.text}`;
    case "sleep":
      // Sleeping has no body `changes` today; the next observed day is the
      // evidence. Do not reject it here, or a real night skip can never
      // settle as completed.
      return confirmed.length === 0 || kinds.has("slept")
        ? null
        : `睡眠完成但没有过夜证据：${decision.text}`;
    default:
      return null;
  }
}

/**
 * Normalises old durable goals. A session created before `goalKind` existed
 * still carries shelter/free-survival display copy; it must not become a new
 * goal type or keep showing a goal the current UI no longer offers.
 */
export function normalizeSeasonGoal(goal: SeasonGoal): SeasonGoal {
  const exact = SEASON_GOAL_PRESETS.find((preset) => preset.title === goal.title);
  if (exact !== undefined) {
    return { ...goal, goalKind: goal.goalKind ?? exact.kind };
  }
  const preset = goalPresetForTitle(goal.title);
  if (preset !== null) {
    return {
      ...goal,
      title: preset.title,
      description: preset.description,
      goalKind: preset.kind,
    };
  }
  return {
    ...goal,
    goalKind: goal.goalKind ?? goalKindForTitle(goal.title),
  };
}

const GOAL_STAGE_ORDER = [
  "wood-and-table",
  "stone-tools",
  "food",
  "shelter",
  "iron",
  "diamond-gear",
  "nether",
  "eyes",
  "stronghold",
  "dragon",
] as const;

function goalReachesTarget(goal: SeasonGoal, stage: string): boolean {
  const target = targetForTitle(goal.title);
  return (
    GOAL_STAGE_ORDER.indexOf(stage as (typeof GOAL_STAGE_ORDER)[number]) >=
    GOAL_STAGE_ORDER.indexOf(target)
  );
}

function stageIndexOf(stage: string): number {
  return GOAL_STAGE_ORDER.indexOf(stage as (typeof GOAL_STAGE_ORDER)[number]);
}

/**
 * Adapter over #42's pure survival planner. It forwards only observed facts;
 * a missing snapshot stays missing, so progress cannot be fabricated.
 */
export class SurvivalGoalPlanner implements GoalPlanner {
  plan(input: GoalPlanningInput): GoalPlan {
    // WorldSnapshot's optional properties admit an explicit `undefined`, while
    // the domain projection uses exact optional properties. The shapes agree
    // for every observed value; only the declaration differs.
    const facts = worldFactsFromSnapshot(
      input.world as Parameters<typeof worldFactsFromSnapshot>[0],
      {
        routeBlacklist: input.routeBlacklist ?? [],
        targetLock: input.progress.targetLock ?? null,
      },
    );
    const goal = toSurvivalGoal(input.goal);
    const availableSkills = input.health?.skills ?? [];
    let plan = planSurvival(facts, goal, { availableSkills });
    if (plan.task !== null) {
      plan = { ...plan, task: withStableTaskId(plan.task) };
    }
    if (process.env["CRAFTMATE_DEBUG_FACTS"] === "1") {
      console.log(
        "[facts]",
        JSON.stringify({
          stage: plan.stage,
          position: facts.position ?? null,
          surfaceY: facts.surfaceY ?? null,
          shaftTopY: facts.shaftTopY ?? null,
          shaftDepth: facts.shaftDepth ?? null,
          canSeeSky: facts.canSeeSky ?? null,
          enclosed: facts.enclosed ?? null,
          lightLevel: facts.lightLevel ?? null,
          shaftWalls: facts.shaftWalls ?? null,
          food: facts.food ?? null,
          health: facts.health ?? null,
          timeOfDay: facts.timeOfDay ?? null,
          task: plan.task?.title ?? null,
          taskSkill: plan.task?.skill.name ?? null,
          inventory: facts.inventory.map(
            (slot) => `${slot.item.replace(/^minecraft:/u, "")}:${slot.count}`,
          ),
          nearby: (facts.nearbyBlocks ?? []).slice(0, 12).map((block) => block.id),
          table: facts.craftingTable ?? null,
          furnace: facts.furnace ?? null,
          chest: facts.chest ?? null,
          chestOpenable: facts.chestOpenable ?? null,
          shelter: facts.shelter ?? null,
          shelterBuilt: facts.shelterBuilt ?? null,
          mineEntrance: facts.mineEntrance ?? null,
          mineStair: facts.mine?.stair ?? null,
          stations: facts.stations ?? [],
          milestone: plan.milestone,
          blocked: plan.blocked,
          entities: (facts.entities ?? []).slice(0, 8).map(
            (entity) => `${entity.type}:${entity.distance}`,
          ),
        }),
      );
    }
    const recovery = applyFailureRecovery(plan, input, facts);
    if (recovery.resolved !== null) return recovery.resolved;
    plan = recovery.plan;
    if (plan.task === null) {
      return projectPlan(
        plan,
        facts,
        null,
        blockedReason(plan),
        plan.blocked,
      );
    }
    return projectPlan(plan, facts, plan.task, null, plan.blocked);
  }
}

/**
 * Failure history must gate every planner path, including the mission spine
 * that recompiles a later stage from facts. Returns an override plan when the
 * same strategy has failed enough times to require a real change; otherwise
 * it may hand back a recovery task that the caller should project normally.
 */
export function applyFailureRecovery(
  plan: SurvivalPlan,
  input: GoalPlanningInput,
  facts: WorldFacts,
): { readonly plan: SurvivalPlan; readonly resolved: GoalPlan | null } {
  const history = input.failures ?? [];
  const failure = history.at(-1);
  if (
    plan.task === null ||
    failure === undefined ||
    input.lastFailureStrategy === null ||
    input.lastFailureStrategy === undefined
  ) {
    return { plan, resolved: null };
  }
  const normalizedCurrent = withStableTaskId(plan.task);
  const currentKey = taskSignature(normalizedCurrent);
  const failureKey = normalizedStrategy(input.lastFailureStrategy);
  /*
   * `explore` changes its destination every time it is replanned, so the exact
   * strategy key never repeats and the same-strategy circuit below cannot fire.
   * A body boxed into a ravine then reissued a plain walk every six seconds
   * forever ("no natural route within the walk budget"), never moving. Once a
   * walk has just failed for lack of a route, the next navigation attempt must
   * escalate to recovery, which may step, bridge or staircase out.
   */
  const failureClass = classifyFailure(failure);
  /*
   * `mine_tunnel` failing with "no safe mining direction" is not a transient
   * movement miss. In a one-cell dry ledge it will fail identically on every
   * retry, and the generic second-failure detour (explore) is itself blocked
   * by the same water. Use the explicit overhead/pillar escape immediately.
   */
  const enclosedFailure =
    failure.code === "E_ENCLOSED" ||
    /enclosed|no safe route and no legal recovery step/iu.test(failure.detail);
  if (
    (normalizedCurrent.skill.name === "mine_tunnel" &&
      /no safe mining direction|no safe mining|no direction/iu.test(
        failure.detail,
      )) ||
    (normalizedCurrent.skill.name === "goto" && enclosedFailure)
  ) {
    const escape = deadEndEscapeTask(
      plan.stage,
      facts,
      () => crypto.randomUUID(),
    );
    if (escape !== null) {
      return {
        plan,
        resolved: projectPlan(
          plan,
          facts,
          withStableTaskId(escape),
          null,
          plan.blocked,
          true,
        ),
      };
    }
    /*
     * On the surface the dead-end escape is deliberately unavailable: there
     * is no overhead rock worth mining and pillaring up only leaves the camp.
     * The live body deposited, stepped down onto the terrace, and then retried
     * the same `mine_tunnel` node every minute. Walk back to the first stair
     * cell so the next plan can descend from a real mine entrance.
     */
    const approach = mineMouthApproachTask(
      plan.stage,
      facts,
      () => crypto.randomUUID(),
    );
    if (approach !== null) {
      return {
        plan,
        resolved: projectPlan(
          plan,
          facts,
          withStableTaskId(approach),
          null,
          plan.blocked,
          true,
        ),
      };
    }
  }
  if (
    (failureClass === "NO_PATH" ||
      failureClass === "STATION_UNREACHABLE" ||
      failureClass === "RESOURCE_NOT_FOUND" ||
      failureClass === "NO_PROGRESS") &&
    normalizedCurrent.skill.name === "goto" &&
    normalizedCurrent.skill.args["mode"] === "walk"
  ) {
    const escalated: Task = {
      ...normalizedCurrent,
      skill: {
        ...normalizedCurrent.skill,
        args: { ...normalizedCurrent.skill.args, mode: "recover" },
      },
    };
    return {
      plan,
      resolved: projectPlan(
        plan,
        facts,
        withStableTaskId(escalated),
        null,
        plan.blocked,
        true,
      ),
    };
  }
  const failedCount = history.filter(
    (entry) =>
      entry.stage === failure.stage &&
      normalizedTaskId(entry.taskId) === normalizedTaskId(currentKey),
  ).length;
  /*
   * A chest with no wood is a definitive content verdict. Do not spend the
   * first retry (or open a 60-second strategy circuit) reopening it while a
   * tree is visible: let domain recovery drop the chest and chop.
   */
  if (
    currentKey === failureKey &&
    normalizedCurrent.skill.name === "withdraw" &&
    /no more matching items remain/iu.test(failure.detail)
  ) {
    const recovered = recover({
      plan,
      facts,
      failure,
      history: history.slice(0, -1),
    });
    if (recovered.task !== null) {
      return {
        plan,
        resolved: projectPlan(
          plan,
          facts,
          withStableTaskId(recovered.task),
          null,
          plan.blocked,
          true,
        ),
      };
    }
  }
  if (currentKey === failureKey && failedCount >= 2) {
    const movementFailure =
      failureClass === "NO_PATH" ||
      failureClass === "RESOURCE_NOT_FOUND" ||
      failureClass === "STATION_UNREACHABLE" ||
      failureClass === "NO_PROGRESS" ||
      failureClass === "TIMEOUT";
    /*
     * A craft that cannot touch its station is not "go look somewhere else".
     * The generic detour below walked eight to sixteen blocks through solid
     * rock, failed with E_ENCLOSED, and returned to the same craft forever
     * while the body stood at y=48 with an unreachable table at y=40. Let the
     * domain recovery drop that station and plan the climb out; that path
     * already knows the mine staircase and the tool rescue.
     */
    if (movementFailure && normalizedCurrent.kind === "craft") {
      const recovered = recover({
        plan,
        facts,
        failure,
        history: history.slice(0, -1),
      });
      if (recovered.task !== null) {
        return {
          plan,
          resolved: projectPlan(
            plan,
            facts,
            withStableTaskId(recovered.task),
            null,
            plan.blocked,
            true,
          ),
        };
      }
      return {
        plan,
        resolved: projectPlan(
          plan,
          facts,
          null,
          recovered.reason,
          recovered.blocked,
        ),
      };
    }
    if (
      normalizedCurrent.kind === "combat" ||
      normalizedCurrent.kind === "navigate" ||
      (normalizedCurrent.kind === "gather" && movementFailure) ||
      (normalizedCurrent.kind === "mine" && movementFailure)
    ) {
      // Replaying the exact same movement third time is not "recovery",
      // it is the loop an operator sees as "one command, then the body
      // stands there". Move to a new area and re-observe instead; the
      // detour is real movement, not an invented success.
      // A food-stage animal that failed twice is usually still the
      // nearest entity in the 40-block hunt window. Moving only 24–36
      // blocks leaves it visible, so the next plan selects the same
      // unreachable chicken and the loop restarts. Step outside that
      // observation window before re-planning; other stages keep the
      // cheaper local detour.
      const foodRetry = plan.stage === "food";
      const detour = explore(
        facts,
        plan.stage,
        "换一片区域重新观察",
        "目标",
        1,
        () => crypto.randomUUID(),
        foodRetry ? 48 : 8,
        foodRetry ? 60 : 16,
        true,
      );
      return {
        plan,
        resolved: projectPlan(
          plan,
          facts,
          withStableTaskId(detour),
          null,
          plan.blocked,
          true,
        ),
      };
    }
    // Non-movement failures (a craft menu, a placement) can genuinely
    // recover from a fresh observation, so keep the retry.
    return {
      plan,
      resolved: projectPlan(
        plan,
        facts,
        normalizedCurrent,
        null,
        plan.blocked,
        true,
      ),
    };
  }
  if (currentKey === failureKey && failedCount === 1) {
    return {
      plan,
      resolved: projectPlan(
        plan,
        facts,
        normalizedCurrent,
        null,
        plan.blocked,
        true,
      ),
    };
  }
  const recovered = recover({
    plan,
    facts,
    failure,
    history: history.slice(0, -1),
  });
  if (recovered.task !== null) {
    plan = { ...plan, task: withStableTaskId(recovered.task), blocked: [] };
  } else if (currentKey === failureKey) {
    return {
      plan,
      resolved: projectPlan(
        plan,
        facts,
        null,
        recovered.reason,
        recovered.blocked,
      ),
    };
  }
  return { plan, resolved: null };
}

export function projectPlan(
  plan: SurvivalPlan,
  facts: WorldFacts,
  task: SurvivalPlan["task"],
  blockedReason: string | null,
  _blocked: SurvivalPlan["blocked"],
  retried = false,
): GoalPlan {
  const completed = plan.stages
    .flatMap((stage) => stage.milestones)
    .filter((milestone) => milestone.status === "complete")
    .map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      status: "completed" as const,
    }));
  const pending = plan.stages
    .flatMap((stage) => stage.milestones)
    .filter((milestone) => milestone.status !== "complete")
    .map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      status: "unverified" as const,
    }));
  return {
    stage: { id: plan.stage, title: plan.stageTitle },
    milestone: {
      id: plan.milestone?.id ?? plan.stage,
      title: plan.milestone?.title ?? "等待目标引擎给出当前里程碑",
    },
    nextTask:
      task === null
        ? null
        : {
            intent: intentForTask(task),
            text: task.title,
            reason: retried
              ? `重新观察后重试一次「${task.title}」；世界状态可能已变化`
              : `目标阶段「${plan.stageTitle}」：${task.title}`,
            ...(task.critical === true ? { critical: true } : {}),
            skill: task.skill,
            taskId: task.id,
            ...(task.targetLock === undefined
              ? {}
              : {
                  targetLock: {
                    ...task.targetLock,
                    cardId: task.targetLock.cardId ?? null,
                    lockedAt: 0,
                    expiresAt: 0,
                  },
                }),
          },
    targetLock:
      task?.targetLock === undefined
        ? null
        : {
            ...task.targetLock,
            cardId: task.targetLock.cardId ?? null,
            lockedAt: 0,
            expiresAt: 0,
          },
    milestones: [...completed, ...pending],
    verified: plan.completedMilestones > 0,
    complete:
      task === null &&
      plan.milestone === null &&
      plan.stages.every(
        (stage) =>
          stage.index > stageIndexOf(plan.goal.target) || stage.status === "complete",
      ),
    blockedReason,
    ...(task === null ? {} : { strategyKey: taskSignature(task) }),
  };
}

/**
 * Domain tasks carry an id used by `recover()` to avoid the exact failed task.
 * The planner regenerates those ids from facts, so normalize them to the
 * strategy signature before recovery; otherwise a fresh random id would make
 * the same failed action look new.
 */
function withStableTaskId(task: NonNullable<SurvivalPlan["task"]>): NonNullable<SurvivalPlan["task"]> {
  return { ...task, id: `task:${taskSignature(task)}` };
}

function nextCandidate(
  plan: SurvivalPlan,
  facts: WorldFacts,
  avoid: string,
): NonNullable<SurvivalPlan["task"]> | null {
  const candidate = nextTaskForStage({
    stage: plan.stage,
    facts,
    newId: () => crypto.randomUUID(),
  });
  if (candidate === null || !("skill" in candidate)) return null;
  const stable = withStableTaskId(candidate);
  return taskSignature(stable) === normalizedStrategy(avoid) ? null : stable;
}

function blockedReason(plan: SurvivalPlan): string | null {
  const first = plan.blocked[0];
  if (first === undefined) return "目标引擎没有返回可执行任务";
  const missing = first.missing.map((item) => item.detail).join("；");
  return missing.length === 0 ? first.title : `${first.title}：${missing}`;
}

function toSurvivalGoal(goal: SeasonGoal): import("../domain/index.ts").SeasonGoal {
  return {
    id: goal.id,
    title: goal.title,
    target: targetForTitle(goal.title),
    version: goal.version,
    lockedByOperator: true,
    setBy: "operator",
    setAt: goal.setAt,
  };
}

/** Presets are display text; unknown goals still explore the full chain. */
function targetForTitle(title: string): GoalId {
  if (/自由生存|持续发育|完整生存链/u.test(title)) return "dragon";
  if (/末影龙|dragon|末地/u.test(title)) return "dragon";
  if (/要塞|stronghold/u.test(title)) return "stronghold";
  if (/末影之眼|之眼|eyes/u.test(title)) return "eyes";
  if (/下界|烈焰|nether/u.test(title)) return "nether";
  if (/钻石|diamond/u.test(title)) return "diamond-gear";
  if (/铁|iron/u.test(title)) return "iron";
  if (/床|小屋|庇护所|shelter|house/u.test(title)) return "shelter";
  if (/食物|吃|food/u.test(title)) return "food";
  if (/石|镐|stone/u.test(title)) return "stone-tools";
  // A long-horizon survival goal must not stop at the opening stage. The
  // default used to fall through to "wood-and-table", which made the DAG
  // report itself complete as soon as a table was placed; the only available
  // playbook card was then exploration, and the body wandered until the
  // acceptance clock ran out. Surface progression up to iron is the v1 scope.
  if (/长期自主生存|长期生存|持续经营|自主经营/u.test(title)) return "diamond-gear";
  return "wood-and-table";
}

function toGoalId(stage: string): GoalId {
  const ids: readonly GoalId[] = [
    "wood-and-table",
    "stone-tools",
    "food",
    "shelter",
    "iron",
    "diamond-gear",
    "nether",
    "eyes",
    "stronghold",
    "dragon",
  ];
  return ids.find((id) => id === stage) ?? "wood-and-table";
}

function intentForTask(task: NonNullable<SurvivalPlan["task"]>): Intent {
  switch (task.kind) {
    case "gather":
    case "mine":
      return "mine";
    case "craft":
      return "craft";
    case "smelt":
      return "craft";
    case "place":
      return "build";
    case "interact":
      return "unknown";
    case "navigate":
      return "move";
    case "combat":
      return "danger";
    default:
      return "unknown";
  }
}

function safeFailures(value: unknown): TaskFailure[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is TaskFailure =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as TaskFailure).taskId === "string" &&
      typeof (entry as TaskFailure).code === "string" &&
      typeof (entry as TaskFailure).detail === "string" &&
      typeof (entry as TaskFailure).attempts === "number",
  );
}

/**
 * Explicit placeholder until #42 lands. It emits no task and no milestones, so
 * the console shows `unverified` rather than an invented completion rate.
 */
export class UnverifiedGoalPlanner implements GoalPlanner {
  plan(): GoalPlan {
    return {
      stage: { id: "await-goal-engine", title: "等待目标引擎接线" },
      milestone: { id: "await-goal-engine", title: "尚未验证任何里程碑" },
      nextTask: null,
      milestones: [],
      verified: false,
      blockedReason: null,
    };
  }
}

const STATION_PLACEMENT = /(?:^|:)(crafting_table|furnace|chest|bed)$/u;

/** In-memory store for tests and previews. */
export class MemoryGoalRuntimeStore implements GoalRuntimeStore {
  private record: GoalRuntimeRecord | null = null;

  load(): GoalRuntimeRecord | null {
    return this.record;
  }

  save(record: GoalRuntimeRecord): void {
    this.record = record;
  }
}

function pauseReason(
  context: GoalRuntimeContext,
  now: number,
): { readonly status: GoalStatus; readonly reason: string } | null {
  if (context.mode !== "agent") {
    return { status: "paused", reason: "操作员接管或急停，目标运行时暂停" };
  }
  const bridge = context.bridge;
  if (bridge === null || !bridge.connected) {
    return { status: "paused", reason: "没有连接游戏身体，目标运行时暂停" };
  }
  if (bridge.owner !== "agent" || bridge.permission !== "agent") {
    return { status: "paused", reason: "Agent 没有身体代理权，目标运行时暂停" };
  }
  const world = context.world;
  if (world === null || !world.inWorld) {
    return { status: "paused", reason: "客户端未进入世界，目标运行时暂停" };
  }
  if (world.screenOpen === true) {
    return { status: "paused", reason: "玩家界面打开，目标运行时暂停" };
  }
  if (world.health !== null && world.health !== undefined && world.health <= 0) {
    return { status: "paused", reason: "角色死亡，等待重生后再观察" };
  }
  const danger = (bridge.incidents ?? []).find(
    (incident) =>
      now - incident.at < REFLEX_HANDOFF_MS &&
      incident.kind !== "retreat" &&
      // A threat is handed back to the same planner that can choose attack
      // or retreat. Pausing here blocked immediateSafetyTask for the whole
      // hand-off window, so a body in bow range only walked and was shot.
      incident.kind !== "threat" &&
      // Low health and starvation are conditions, not momentary reflex
      // takeovers. The planner must remain free to eat, fight or retreat;
      // pausing here left a body at three health standing still until a
      // skeleton finished it off.
      incident.kind !== "low_health" &&
      incident.kind !== "starving",
  );
  if (danger !== undefined) {
    return { status: "paused", reason: `安全反射触发：${danger.detail}` };
  }
  return null;
}

function stableSkillKey(skill: SkillCall): string {
  return `${skill.name}:${JSON.stringify(skill.args)}`;
}

/**
 * Autonomous decisions have no audience ref and therefore cannot use the
 * conversational promise path. A short first-person line is still useful to
 * the voice service and keeps the body from silently issuing skills forever.
 */
/**
 * Goal mode is deterministic and may issue a task every few seconds. Speaking
 * the internal task title verbatim turned the voice channel into a build log,
 * so translate the task into one short player line and rotate the phrasing.
 */
function goalSpeech(task: GoalTask, variation = 0): string {
  const authored = task.speech?.trim() ?? "";
  if (authored.length > 0) return authored.slice(0, 280);
  const title = cleanTaskTitle(task.text);
  const candidates = goalSpeechCandidates(title, task.skill.name);
  if (candidates.length === 0) return "";
  return candidates[Math.abs(variation) % candidates.length] ?? "";
}

function cleanTaskTitle(value: string): string {
  return value
    .replace(
      /[（(][^）)]*(?:[xyz]\s*=|坐标|第\s*\d+\s*阶|支线|复用|候选|分支)[^）)]*[）)]/giu,
      "",
    )
    .replace(/\s*[×x]\s*\d+\s*$/iu, "")
    .replace(/\s{2,}/gu, " ")
    .replace(/[。！？!?]+$/u, "")
    .trim();
}

function goalSpeechCandidates(title: string, skill: string): readonly string[] {
  const text = `${title} ${skill}`;
  if (/砍树|砍木|原木|木头|chop/iu.test(text)) {
    return [
      "先砍一根原木，手上正好缺材料。",
      "这棵树不错，就它了。",
      "砍点木头备着，待会儿要用。",
      "唔，先弄点木头。",
    ];
  }
  if (/铁矿石|铁矿|矿道|下矿|开掘|挖矿|iron_ore/iu.test(text)) {
    return [
      "再往下挖一点，铁应该快出来了。",
      "这条矿道还能走，我接着挖。",
      "换个面挖挖看，说不定前面就有矿。",
      "唔，还没见着铁……再挖几格。",
      "先把矿道打通，铁矿石应该就在前头。",
      "我往旁边开条路，找矿去。",
    ];
  }
  if (/熔炼|烧炼|smelt/iu.test(text)) {
    return [
      "先烧一炉，等铁锭出来。",
      "炉子不能闲着，我烧点东西。",
      "把矿炼了，马上就能用。",
    ];
  }
  if (/合成|制作|工作台|木棍|木板|镐|工具|craft/iu.test(text)) {
    return [
      "先把要用的东西做出来。",
      "缺个工具，我搓一下。",
      "这个得先合成，不然干不了活。",
      "手上材料够，先做出来再说。",
      "做把镐子，接下来挖矿就快了。",
    ];
  }
  if (/放下|放置|摆|火把|点亮|搭|建|墙|门|床|place_block|pillar/iu.test(text)) {
    return [
      "先把这里收拾一下。",
      "放个工作台，干活方便。",
      "这里太黑了，点个火把。",
      "把东西摆好再继续。",
      "先搭个能落脚的地方。",
    ];
  }
  if (/吃|食物|饿|eat/iu.test(text)) {
    return [
      "肚子有点饿了，先找点吃的。",
      "吃点东西再干活。",
      "先补一口，不然没力气。",
    ];
  }
  if (/睡|床|夜|sleep/iu.test(text)) {
    return [
      "天黑了，先睡一觉。",
      "困了，我去床上躺一下。",
      "把这一夜睡过去。",
    ];
  }
  if (/回|营地|箱子|储物|存放|deposit/iu.test(text)) {
    return [
      "先回营地一趟，把东西放下。",
      "背包快满了，回去整理一下。",
      "把东西收好，免得丢了。",
    ];
  }
  if (/逃|撤退|危险|躲|远离|flee/iu.test(text)) {
    return [
      "有点危险，我先撤。",
      "不对劲，先躲一下。",
      "先保命，别的待会儿再说。",
    ];
  }
  if (/观察|看看|等待|look_at|wait/iu.test(text)) {
    return [
      "先停一下，看看情况。",
      "我瞅一眼再动。",
      "别急，先观察一下。",
    ];
  }
  if (/前往|走到|靠近|移动|出发|goto|follow/iu.test(text)) {
    return [
      "我过去看看。",
      "先往那边走一段。",
      "路不远，我这就过去。",
      "到前面那个位置再说。",
    ];
  }
  if (/挖|采集|石头|泥土|圆石|mine_block|collect_items/iu.test(text)) {
    return [
      "这点方块，几下就挖完了。",
      "先把眼前这块挖掉。",
      "我挖一点材料备着。",
      "顺手收点石头。",
    ];
  }
  if (title.length > 0 && !/[A-Za-z_]|×/u.test(title)) {
    return [`我先${title}。`, `接下来${title}。`, `把${title}办了。`];
  }
  switch (skill) {
    case "mine_block":
      return ["再挖几块。", "把这块挖开看看。"];
    case "goto":
      return ["我过去看看。", "先走一段。"];
    case "chop_tree":
      return ["砍点木头。", "先弄点原木。"];
    case "craft":
      return ["做点东西。", "先把手上的材料合成了。"];
    case "place_block":
      return ["把方块放好。", "先摆一下。"];
    case "collect_items":
      return ["先把东西捡了。", "地上的掉落物别浪费。"];
    case "smelt":
      return ["烧点东西。", "让炉子先忙着。"];
    case "deposit":
      return ["把东西存起来。", "先去整理背包。"];
    case "equip":
      return ["换上装备。", "把家伙事换好。"];
    case "eat":
      return ["吃点东西。", "先补一口。"];
    case "sleep":
      return ["睡一觉。", "先把夜里过去。"];
    default:
      return ["先把手上的事做完。", "继续，别停。"];
  }
}

function acquisitionIntent(node: AcquisitionNode): string {
  const name = node.target
    .replace(/^item:/u, "")
    .replace(/^action:/u, "")
    .replace(/^station:/u, "")
    .replace(/^minecraft:/u, "");
  if (node.kind === "station") return `准备 ${name}`;
  if (node.kind === "item") return `获取 ${name} ×${node.quantity}`;
  const action = node.target.replace(/^action:/u, "");
  if (action.startsWith("craft:")) return `合成 ${name.replace(/^craft:/u, "")}`;
  if (action.startsWith("smelt:")) return `熔炼 ${name.replace(/^smelt:/u, "")}`;
  if (action.startsWith("mine:")) return `采集 ${name.replace(/^mine:/u, "")}`;
  if (action.startsWith("silk_touch:")) return `精准采集 ${name.replace(/^silk_touch:/u, "")}`;
  if (action.startsWith("loot:")) return `搜寻 ${name.replace(/^loot:/u, "")}`;
  return `获取 ${name} ×${node.quantity}`;
}

/**
 * The planner's strategy key is the task signature, while failures persist a
 * stage-prefixed key. Strip the stage prefix before comparing so recovery
 * recognises the same action rather than treating every retry as a new one.
 */
function normalizedStrategy(key: string): string {
  return normalizedTaskId(key);
}

function statusText(status: GoalSettlement["status"]): string {
  switch (status) {
    case "timeout":
      return "任务超时";
    case "cancelled":
      return "任务被取消";
    case "preempted":
      return "任务被安全反射顶替";
    case "completed":
      return "任务完成";
    default:
      return "任务失败";
  }
}

/**
 * A partial result is more useful to the next plan than a bare timeout label.
 * Keep the body's remaining work and next hint in the durable failure detail
 * so recovery can continue instead of re-issuing the same whole task.
 */
function failureDetail(outcome: GoalSettlement): string {
  const parts = [
    outcome.detail ?? outcome.errorCode ?? statusText(outcome.status),
    outcome.progress === undefined ? "" : progressText(outcome.progress),
    outcome.remaining === undefined ? "" : `还差：${outcome.remaining}`,
    outcome.resumable === true ? "可续跑" : "",
    outcome.nextHint === undefined ? "" : `下一步：${outcome.nextHint}`,
  ].filter((part) => part.length > 0);
  return parts.join("；");
}

function taskFailureCategory(code: string | undefined | null): FailureCategory {
  switch (code) {
    case "E_UNREACHABLE":
    case "E_ENCLOSED":
      return "unreachable";
    case "E_NOT_OBSERVED":
      return "not_observed";
    case "E_WORLD_CHANGED":
      return "world_changed";
    case "E_PLAN_EVIDENCE":
      return "evidence_conflict";
    case "E_TIMEOUT":
      return "timeout";
    case "E_OPERATOR":
      return "operator";
    case "E_PRECONDITION":
      return "precondition";
    case "E_DANGER":
    case "E_LAVA":
    case "E_FALL":
      return "danger";
    default:
      return "internal";
  }
}

/**
 * Target locks live in goal progress so an orchestrator restart cannot turn a
 * moving animal into a new target every planning boundary. A lock follows a
 * target that moved up to eight blocks; farther movement opens a new choice.
 */
export function mergeTargetLock(
  existing: TargetLock | null,
  next: TargetLock | null,
  now: number,
): TargetLock | null {
  if (next === null) return null;
  if (
    existing !== null &&
    existing.expiresAt > now &&
    existing.kind === next.kind &&
    existing.dimension === next.dimension &&
    existing.ref === next.ref &&
    Math.hypot(
      existing.x - next.x,
      existing.y - next.y,
      existing.z - next.z,
    ) <= 8
  ) {
    return {
      ...next,
      cardId: next.cardId ?? existing.cardId,
      lockedAt: existing.lockedAt,
      expiresAt: existing.expiresAt,
    };
  }
  return {
    ...next,
    lockedAt: now,
    expiresAt: now + (next.kind === "entity" ? 15_000 : 30_000),
  };
}

function progressText(progress: NonNullable<GoalSettlement["progress"]>): string {
  const amount =
    progress.total === undefined
      ? `${progress.done}`
      : `${progress.done}/${progress.total}`;
  return `进度：${amount}${progress.unit === undefined ? "" : ` ${progress.unit}`}`;
}
