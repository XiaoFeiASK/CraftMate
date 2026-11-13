import { randomUUID } from "node:crypto";
import {
  agentEventSchema,
  telemetrySnapshotSchema,
  type AgentEvent,
  type AgentEventStage,
  type AgentEventStatus,
  type AgentJudgement,
  type IngressMetrics,
  type IngressMetricsFrame,
  type SkillCommand,
  type TelemetrySnapshot,
} from "@craftmate/contracts";
import type { AgentEventStore } from "@craftmate/storage";

/**
 * Everything that can reach the event store passes through this allow-list.
 * Summaries are composed by the backend from structured facts; audience text
 * and model prose never enter this function.
 */
export interface AgentEventInput {
  readonly stage: AgentEventStage;
  readonly status?: AgentEventStatus;
  readonly at?: number;
  readonly traceId?: string | null;
  readonly taskId?: string | null;
  readonly decisionId?: string | null;
  readonly goalId?: string | null;
  readonly durationMs?: number | null;
  readonly summary?: string;
  readonly errorCode?: string | null;
  readonly playbookId?: string | null;
  readonly cardStatus?: AgentEvent["cardStatus"];
  readonly switchReason?: string | null;
  readonly failureCode?: string | null;
  readonly recoveryId?: string | null;
  readonly modelChoice?: boolean | null;
  readonly fallbackReason?: string | null;
  readonly routeMode?: AgentEvent["routeMode"];
  readonly blockedReason?: string | null;
  readonly blacklistId?: string | null;
  readonly targetLock?: AgentEvent["targetLock"];
  readonly source?: AgentEvent["source"];
}

const MAX_BUFFER = 160;
const MAX_SUMMARY = 600;

/**
 * The bridge body is untrusted input. Its free-text `detail` and `phase` are
 * kept in the durable decision/action evidence, but never copied into an
 * operator telemetry summary. Known phases get fixed labels; unknown phases
 * fall back to one generic label so arbitrary text cannot reach the console.
 */
const TASK_STATUS_LABELS = {
  completed: "已完成",
  failed: "失败",
  timeout: "超时",
  cancelled: "已取消",
  preempted: "被顶替",
} as const;

export type TaskTerminalStatus = keyof typeof TASK_STATUS_LABELS;

const PROGRESS_PHASE_LABELS: Readonly<Record<string, string>> = {
  waiting: "等待",
  turning: "转向",
  walking: "移动",
  replanning: "重新规划路线",
  finding: "寻找目标",
  target: "选定目标",
  mining: "挖掘",
  breaking: "破坏方块",
  collecting: "收集物品",
  opening: "打开容器",
  finding_recipe: "查找配方",
  submitting_recipe: "提交配方",
  crafting: "合成",
  taking_result: "取出产物",
  placing_ingredients: "摆放材料",
  transferring: "转移物品",
  charging: "蓄力",
  sleeping: "睡觉",
  confirming: "确认结果",
  eating: "进食",
  placed: "已放置",
  starting: "准备执行",
};

const INGRESS_DROP_REASON_LABELS: Readonly<Record<string, string>> = {
  duplicate: "重复事件",
  "rate limited": "超过速率限制",
  "queue full": "队列已满",
  "queue evicted": "队列腾位淘汰",
  "relay buffer full": "转发缓冲已满",
};

/** A bounded summary composed only from a fixed status label. */
export function taskSettledSummary(status: TaskTerminalStatus): string {
  return status === "completed"
    ? "任务已完成"
    : `任务未完成：${TASK_STATUS_LABELS[status]}`;
}

/**
 * Progress counts are structured numbers; the phase is body-controlled and
 * must be mapped through the allowlist before it is broadcast or persisted.
 */
export function taskProgressSummary(
  phase: string,
  done: number,
  total: number | null | undefined,
): string {
  const label = PROGRESS_PHASE_LABELS[phase] ?? "执行中";
  return total === null || total === undefined
    ? `${label}：${done}`
    : `${label}：${done}/${total}`;
}

/**
 * The control plane's telemetry projection. It owns the bounded in-memory
 * window, the durable append, and the safe judgement summary. The UI never
 * derives an event or a health value on its own.
 */
export class AgentTelemetry {
  private readonly store: AgentEventStore | null;
  private readonly now: () => number;
  private readonly buffer: AgentEvent[] = [];
  private judgement: AgentJudgement | null = null;
  private ingress: IngressMetrics = unknownIngress();

  constructor(options: {
    readonly store?: AgentEventStore;
    /** Newest-first history loaded from SQLite during process startup. */
    readonly history?: readonly AgentEvent[];
    readonly now?: () => number;
  } = {}) {
    this.store = options.store ?? null;
    this.now = options.now ?? Date.now;
    if (options.history !== undefined) {
      this.buffer.push(...options.history.slice(0, MAX_BUFFER));
    }
  }

  /** Persists and returns one event. Unknown stages are rejected by the schema. */
  record(input: AgentEventInput): AgentEvent {
    const event = agentEventSchema.parse({
      id: `evt-${randomUUID()}`,
      at: input.at ?? this.now(),
      stage: input.stage,
      status: input.status ?? "ok",
      traceId: input.traceId ?? null,
      taskId: input.taskId ?? null,
      decisionId: input.decisionId ?? null,
      goalId: input.goalId ?? null,
      durationMs: input.durationMs ?? null,
      summary: cleanSummary(input.summary ?? ""),
      errorCode: input.errorCode ?? null,
      ...(input.playbookId === undefined ? {} : { playbookId: input.playbookId }),
      ...(input.cardStatus === undefined ? {} : { cardStatus: input.cardStatus }),
      ...(input.switchReason === undefined ? {} : { switchReason: input.switchReason }),
      ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
      ...(input.recoveryId === undefined ? {} : { recoveryId: input.recoveryId }),
      ...(input.modelChoice === undefined ? {} : { modelChoice: input.modelChoice }),
      ...(input.fallbackReason === undefined ? {} : { fallbackReason: input.fallbackReason }),
      ...(input.routeMode === undefined ? {} : { routeMode: input.routeMode }),
      ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
      ...(input.blacklistId === undefined ? {} : { blacklistId: input.blacklistId }),
      ...(input.targetLock === undefined ? {} : { targetLock: input.targetLock }),
      source: input.source ?? "agent",
    });
    this.store?.append(event);
    this.buffer.unshift(event);
    if (this.buffer.length > MAX_BUFFER) this.buffer.length = MAX_BUFFER;
    return event;
  }

  /**
   * The judgement is already-safe copy from the planner/runtime. This method
   * only bounds its length; it does not paraphrase, so the console cannot
   * mistake a generated sentence for a fact the agent never stated.
   */
  setJudgement(judgement: AgentJudgement | null): void {
    this.judgement = judgement === null ? null : {
      ...judgement,
      summary: cleanSummary(judgement.summary),
      reason: cleanSummary(judgement.reason),
    };
  }

  currentJudgement(): AgentJudgement | null {
    return this.judgement === null ? null : { ...this.judgement };
  }

  setIngress(metrics: IngressMetrics): void {
    this.ingress = {
      ...metrics,
      dropReasons: { ...metrics.dropReasons },
      updatedAt: metrics.updatedAt,
    };
  }

  currentIngress(): IngressMetrics {
    return { ...this.ingress, dropReasons: { ...this.ingress.dropReasons } };
  }

  snapshot(): TelemetrySnapshot {
    return telemetrySnapshotSchema.parse({
      events: [...this.buffer],
      judgement: this.judgement,
      ingress: this.ingress,
      generatedAt: this.now(),
    });
  }
}

/** Missing backend data must never be rendered as a successful zero. */
export function unknownIngress(detail = "Ingress 指标尚未上报"): IngressMetrics {
  return {
    state: "unknown",
    detail,
    roomId: null,
    lastEventAt: null,
    received: null,
    forwarded: null,
    queued: null,
    dropped: null,
    dropReasons: {},
    upstreamConnected: null,
    reconnects: null,
    updatedAt: null,
  };
}

export function notConfiguredIngress(): IngressMetrics {
  return {
    ...unknownIngress("抖音房间未配置"),
    state: "not_configured",
  };
}

/** A fact key includes its outcome because a retry can differ from its first result. */
export function ingressFactKey(
  fact: IngressMetricsFrame["recent"][number],
): string {
  return `${fact.id}\u0000${fact.at}\u0000${String(fact.accepted)}`;
}

/**
 * Projects the child's bounded recent facts into operator events.
 *
 * The ingress process is the only one that sees the gate, so it also owns
 * `ingress_received`, `gated` and `dropped`. Every fact was received; only an
 * admitted one passed the gate. Facts already in `seen` are skipped, which
 * makes a metrics reconnect or a duplicate frame idempotent instead of
 * replaying history into the UI.
 */
export function projectIngressFacts(
  facts: IngressMetricsFrame["recent"],
  seen: Set<string>,
): readonly AgentEventInput[] {
  const live = new Set(facts.map((fact) => ingressFactKey(fact)));
  for (const key of seen) {
    if (!live.has(key)) seen.delete(key);
  }

  const projected: AgentEventInput[] = [];
  for (const fact of [...facts].reverse()) {
    const key = ingressFactKey(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    projected.push({
      stage: "ingress_received",
      traceId: fact.id,
      summary: `接入 ${fact.kind}，已交给闸门${
        fact.latencyMs === null ? "" : `（${fact.latencyMs}ms）`
      }`,
      source: "ingress",
    });
    if (fact.accepted) {
      projected.push({
        stage: "gated",
        traceId: fact.id,
        summary: `闸门已通过：${fact.kind}${
          fact.latencyMs === null ? "" : `（${fact.latencyMs}ms）`
        }`,
        source: "ingress",
      });
    } else {
      projected.push({
        stage: "dropped",
        status: "skipped",
        traceId: fact.id,
        // Drop reasons are a closed set produced by the gate. Map them to
        // fixed labels instead of echoing any future free-text value.
        summary: `闸门丢弃 ${fact.kind}：${
          INGRESS_DROP_REASON_LABELS[fact.reason] ?? "未提供原因"
        }`,
        errorCode: "E_INGRESS_DROPPED",
        source: "ingress",
      });
    }
  }
  return projected;
}

/**
 * Joins a decision to the task id the body assigned. The command id is known
 * before the ack; the body's task id arrives later. Keeping both in one place
 * means a progress frame and the terminal frame cannot disagree about which
 * task the operator is looking at.
 */
export class TaskTelemetry {
  private readonly taskIds = new Map<string, string>();
  private readonly publish: (event: AgentEventInput) => void;

  constructor(publish: (event: AgentEventInput) => void) {
    this.publish = publish;
  }

  queued(input: {
    readonly decisionId: string;
    readonly traceId: string | null;
    readonly taskId: string;
    readonly summary: string;
    readonly source: AgentEvent["source"];
    readonly goalId?: string | null;
    readonly playbook?: {
      readonly playbookId?: string | null;
      readonly cardStatus?: AgentEvent["cardStatus"];
      readonly switchReason?: string | null;
      readonly failureCode?: string | null;
      readonly recoveryId?: string | null;
      readonly modelChoice?: boolean | null;
      readonly fallbackReason?: string | null;
      readonly routeMode?: AgentEvent["routeMode"];
      readonly blockedReason?: string | null;
      readonly blacklistId?: string | null;
      readonly targetLock?: AgentEvent["targetLock"];
    };
  }): void {
    this.taskIds.set(input.decisionId, input.taskId);
    this.publish({
      stage: "task_queued",
      traceId: input.traceId,
      taskId: input.taskId,
      decisionId: input.decisionId,
      goalId: input.goalId ?? null,
      summary: input.summary,
      ...(input.playbook ?? {}),
      source: input.source,
    });
  }

  running(input: {
    readonly decisionId: string;
    readonly traceId: string | null;
    readonly taskId: string;
    readonly summary: string;
    readonly source: AgentEvent["source"];
    readonly goalId?: string | null;
    readonly playbook?: {
      readonly playbookId?: string | null;
      readonly cardStatus?: AgentEvent["cardStatus"];
      readonly switchReason?: string | null;
      readonly failureCode?: string | null;
      readonly recoveryId?: string | null;
      readonly modelChoice?: boolean | null;
      readonly fallbackReason?: string | null;
      readonly routeMode?: AgentEvent["routeMode"];
      readonly blockedReason?: string | null;
      readonly blacklistId?: string | null;
      readonly targetLock?: AgentEvent["targetLock"];
    };
  }): void {
    this.taskIds.set(input.decisionId, input.taskId);
    this.publish({
      stage: "task_running",
      traceId: input.traceId,
      taskId: input.taskId,
      decisionId: input.decisionId,
      goalId: input.goalId ?? null,
      summary: input.summary,
      ...(input.playbook ?? {}),
      source: input.source,
    });
  }

  taskId(decisionId: string): string | null {
    return this.taskIds.get(decisionId) ?? null;
  }

  /**
   * The body's terminal frame names its own task id, but the decision map is
   * authoritative when both exist: it is the id the operator saw at queue time.
   * A late frame without a decision can still produce a terminal event.
   */
  settled(input: {
    readonly decisionId: string | null;
    readonly traceId: string | null;
    readonly taskId?: string | null;
    readonly status: AgentEventStatus;
    readonly summary: string;
    readonly errorCode?: string | null;
    readonly durationMs?: number | null;
    readonly source: AgentEvent["source"];
    readonly playbook?: {
      readonly playbookId?: string | null;
      readonly cardStatus?: AgentEvent["cardStatus"];
      readonly switchReason?: string | null;
      readonly failureCode?: string | null;
      readonly recoveryId?: string | null;
      readonly modelChoice?: boolean | null;
      readonly fallbackReason?: string | null;
      readonly routeMode?: AgentEvent["routeMode"];
      readonly blockedReason?: string | null;
      readonly blacklistId?: string | null;
      readonly targetLock?: AgentEvent["targetLock"];
    };
  }): string | null {
    const joined =
      input.decisionId === null ? null : this.taskId(input.decisionId);
    if (input.decisionId !== null) this.taskIds.delete(input.decisionId);
    const taskId = joined ?? input.taskId ?? null;
    this.publish({
      stage: "task_settled",
      status: input.status,
      traceId: input.traceId,
      taskId,
      decisionId: input.decisionId,
      durationMs: input.durationMs ?? null,
      summary: input.summary,
      errorCode: input.errorCode ?? null,
      ...(input.playbook ?? {}),
      source: input.source,
    });
    return taskId;
  }
}

/**
 * Preserves the bridge error code while adding the command id the operator
 * already saw in `task_queued`. A failed issue never becomes `task_running`,
 * but its terminal event still needs to join the queued row.
 */
export class TaskDispatchError extends Error {
  readonly taskId: string;
  readonly code: string;

  constructor(taskId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TaskDispatchError";
    this.taskId = taskId;
    this.code =
      cause instanceof Error && "code" in cause && typeof cause.code === "string"
        ? cause.code
        : "E_INTERNAL";
  }
}

/**
 * Queues one direct (non-goal) skill and emits the operator lifecycle around
 * the bridge call. A failed `issue` throws before `task_running`, so a missing
 * body is never shown as a task that started. The returned command id is the
 * join key until the body's ack supplies its task id.
 */
export function dispatchDirectSkill(input: {
  readonly decision: {
    readonly id: string;
    readonly eventId: string;
    readonly skill: NonNullable<import("@craftmate/contracts").Decision["skill"]>;
    readonly priority: import("@craftmate/contracts").Decision["priority"];
  };
  readonly taskTelemetry: TaskTelemetry;
  readonly goalId: string | null;
  readonly issue: (command: SkillCommand) => void;
  readonly commandId?: string;
}): string {
  const commandId = input.commandId ?? crypto.randomUUID();
  const skill = input.decision.skill;
  input.taskTelemetry.queued({
    decisionId: input.decision.id,
    traceId: input.decision.eventId,
    taskId: commandId,
    goalId: input.goalId,
    summary: `直接动作已排队：${skill.name}`,
    source: "agent",
  });
  try {
    input.issue({
      v: 1,
      type: "cmd",
      id: commandId,
      decisionId: input.decision.id,
      op: skill.name,
      args: skill.args,
      priority: input.decision.priority,
      idempotencyKey: skill.idempotencyKey,
      ...(skill.deadlineTicks === undefined
        ? {}
        : { deadlineTick: skill.deadlineTicks }),
    });
  } catch (error) {
    throw new TaskDispatchError(commandId, error);
  }
  input.taskTelemetry.running({
    decisionId: input.decision.id,
    traceId: input.decision.eventId,
    taskId: commandId,
    goalId: input.goalId,
    summary: `动作已下达：${skill.name}`,
    source: "agent",
  });
  return commandId;
}

/**
 * Settles a queued direct task that never reached `task_running`. The bridge
 * failure is the terminal fact, so the UI gets one visible row per command
 * instead of a queued task that appears stuck forever.
 */
export function failDirectDispatch(input: {
  readonly taskTelemetry: TaskTelemetry;
  readonly decision: { readonly id: string; readonly eventId: string };
  readonly error: TaskDispatchError;
}): void {
  input.taskTelemetry.settled({
    decisionId: input.decision.id,
    traceId: input.decision.eventId,
    taskId: input.error.taskId,
    status: "failed",
    // A dispatch error can carry local/body text. The error code is the
    // allowlisted operator fact; the message remains in server logs.
    summary: "动作未下达",
    errorCode: input.error.code,
    source: "agent",
  });
}

function cleanSummary(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "").trim().slice(0, MAX_SUMMARY);
}

