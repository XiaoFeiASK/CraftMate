import {
  goalProgressSchema,
  navigationModeSchema,
  seasonGoalSchema,
  skillCallSchema,
  type Intent,
  type BridgeHealth,
  type Decision,
  type GoalMilestone,
  type GoalProgress,
  type GoalStatus,
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
  explore,
  nextTaskForStage,
  normalizedTaskId,
  planSurvival,
  recover,
  taskSignature,
  worldFactsFromSnapshot,
  type GoalId,
  type SurvivalPlan,
  type TaskFailure,
  type WorldFacts,
} from "../domain/index.ts";
import type { Clock } from "./ports/clock.ts";
import { systemClock } from "./ports/clock.ts";
import type { ModelProvider } from "./ports/model.ts";

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
}

/**
 * Adapter over #42's pure planner. The runtime never invents a stage or a
 * milestone; without the engine it returns an explicit unverified plan.
 */
export interface GoalPlanner {
  plan(input: GoalPlanningInput): GoalPlan | null;
  /** Optional model-assisted path. Hosts fall back to `plan` when absent. */
  planAsync?(input: GoalPlanningInput): Promise<GoalPlan | null>;
  /** Hot-reloads model credentials without recreating the runtime. */
  updateProvider?(provider: ModelProvider | null): void;
  /** Applies an operator-saved model timeout to the next request. */
  updateDeadline?(deadlineMs: number): void;
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
  readonly maxConsecutiveFailures?: number;
  /** Same `code + detail` repeated this many times opens a strategy circuit. */
  readonly circuitFailureThreshold?: number;
  readonly circuitWindowMs?: number;
  readonly circuitCooldownMs?: number;
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
  private readonly maxConsecutiveFailures: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitWindowMs: number;
  private readonly circuitCooldownMs: number;
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
  private restoredInFlight: string | null = null;
  private failures: TaskFailure[] = [];
  private failureWindow: { readonly fingerprint: string; readonly at: number }[] = [];
  private circuit: {
    readonly strategyKey: string;
    readonly fingerprint: string;
    readonly detail: string;
    readonly until: number;
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
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES;
    this.circuitFailureThreshold =
      options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_THRESHOLD;
    this.circuitWindowMs = options.circuitWindowMs ?? DEFAULT_CIRCUIT_WINDOW_MS;
    this.circuitCooldownMs = options.circuitCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS;
    this.onIncident = options.onIncident;
    this.onSettlement = options.onSettlement;
  }

  /** Restores the durable goal and stage. An old in-flight task is not replayed. */
  restore(): void {
    const record = this.store.load();
    if (!record) return;
    const goal = record.goal === null ? null : seasonGoalSchema.safeParse(record.goal);
    this.goal = goal?.success ? goal.data : null;
    const progress =
      record.progress === null ? null : goalProgressSchema.safeParse(record.progress);
    this.progress = progress?.success ? progress.data : null;
    this.enabled = record.enabled;
    this.lastFailure = record.lastFailure;
    this.lastFailureStrategy = record.lastFailureStrategy;
    this.consecutiveFailures = record.consecutiveFailures;
    this.retryAt = record.retryAt;
    this.failures = safeFailures(record.failures);
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
    readonly at?: number;
  }): { readonly goal: SeasonGoal; readonly interruption: GoalInterruption | null } {
    const interruption = this.interrupt("目标已更换，旧任务作废");
    const at = input.at ?? this.clock.now();
    const goal: SeasonGoal = {
      id: this.clock.newId(),
      title: input.title,
      description: input.description,
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
    this.persist();
  }

  /** Operator takeover, emergency stop, or a goal switch. */
  interrupt(reason: string): GoalInterruption | null {
    const current = this.inFlight;
    if (current === null) return null;
    this.inFlight = null;
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
        this.recordFailure(
          stale.taskId,
          stale.strategyKey,
          runningFor > this.hardTaskTimeoutMs
            ? `任务超过 ${Math.round(this.hardTaskTimeoutMs / 1000)} 秒仍未完成，已硬熔断`
            : `任务超过 ${Math.round(this.taskTimeoutMs / 1000)} 秒没有终态`,
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
    if (this.clock.now() < this.retryAt) return null;

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
      },
    };
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
    if (
      plan.complete === true &&
      plan.nextTask === null &&
      goalReachesTarget(this.goal, plan.stage.id)
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
      this.persist();
      return null;
    }
    if (plan.nextTask === null) {
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
    if (!context.bridge?.skills.includes(skill.data.name)) {
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
      speech: goalSpeech(plan.nextTask),
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
    if (outcome.status === "completed") {
      const missingEvidence = completionEvidenceProblem(current.decision, outcome.changes ?? []);
      if (missingEvidence !== null) {
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
      this.consecutiveFailures = 0;
      this.lastFailure = null;
      this.lastFailureStrategy = null;
      this.retryAt = 0;
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
    };
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
          errorCode === "E_ENCLOSED" ||
          errorCode === "E_STUCK"
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

const GOAL_STAGE_ORDER = [
  "wood-and-table",
  "stone-tools",
  "food",
  "shelter",
  "iron",
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
    const history = input.failures ?? [];
    const failure = history.at(-1);
    if (
      plan.task !== null &&
      failure !== undefined &&
      input.lastFailureStrategy !== null &&
      input.lastFailureStrategy !== undefined
    ) {
      const normalizedCurrent = withStableTaskId(plan.task);
      const currentKey = taskSignature(normalizedCurrent);
      const failureKey = normalizedStrategy(input.lastFailureStrategy);
      const failedCount = history.filter(
        (entry) =>
          entry.stage === failure.stage &&
          normalizedTaskId(entry.taskId) === normalizedTaskId(currentKey),
      ).length;
      if (currentKey === failureKey && failedCount >= 2) {
        const failureClass = classifyFailure(failure);
        const movementFailure =
          failureClass === "NO_PATH" ||
          failureClass === "RESOURCE_NOT_FOUND" ||
          failureClass === "STATION_UNREACHABLE" ||
          failureClass === "NO_PROGRESS" ||
          failureClass === "TIMEOUT";
        if (
          normalizedCurrent.kind === "combat" ||
          normalizedCurrent.kind === "navigate" ||
          (normalizedCurrent.kind === "gather" && movementFailure) ||
          (normalizedCurrent.kind === "mine" && movementFailure) ||
          (normalizedCurrent.kind === "craft" && movementFailure)
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
          return projectPlan(
            plan,
            facts,
            withStableTaskId(detour),
            null,
            plan.blocked,
            true,
          );
        }
        // Non-movement failures (a craft menu, a placement) can genuinely
        // recover from a fresh observation, so keep the retry.
        return projectPlan(
          plan,
          facts,
          normalizedCurrent,
          null,
          plan.blocked,
          true,
        );
      }
      if (currentKey === failureKey && failedCount === 1) {
        return projectPlan(plan, facts, normalizedCurrent, null, plan.blocked, true);
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
        return projectPlan(plan, facts, null, recovered.reason, recovered.blocked);
      }
    }
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

function projectPlan(
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
  if (/铁|钻石|iron/u.test(title)) return "iron";
  if (/床|小屋|庇护所|shelter|house/u.test(title)) return "shelter";
  if (/食物|吃|food/u.test(title)) return "food";
  if (/石|镐|stone/u.test(title)) return "stone-tools";
  // A long-horizon survival goal must not stop at the opening stage. The
  // default used to fall through to "wood-and-table", which made the DAG
  // report itself complete as soon as a table was placed; the only available
  // playbook card was then exploration, and the body wandered until the
  // acceptance clock ran out. Surface progression up to iron is the v1 scope.
  if (/长期自主生存|长期生存|持续经营|自主经营/u.test(title)) return "iron";
  return "wood-and-table";
}

function toGoalId(stage: string): GoalId {
  const ids: readonly GoalId[] = [
    "wood-and-table",
    "stone-tools",
    "food",
    "shelter",
    "iron",
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
      incident.kind !== "threat",
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
function goalSpeech(task: GoalTask): string {
  const authored = task.speech?.trim() ?? "";
  if (authored.length > 0) return authored.slice(0, 280);
  const title = task.text.trim().replace(/[。！？!?]+$/u, "");
  if (title.length === 0) return "";
  return `我先${title}。`;
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
