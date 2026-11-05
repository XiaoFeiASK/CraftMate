import type {
  AgentEvent,
  AgentEventStage,
  AgentEventStatus,
  AgentJudgement,
  Decision,
  GoalProgress,
  IngressMetrics,
  Proposal,
  ShowMode,
  ShowSnapshot,
  TelemetrySnapshot,
  VoiceStatus,
} from "@craftmate/contracts";

export const STAGE_LABELS: Record<AgentEventStage, string> = {
  ingress_received: "接入",
  gated: "闸门",
  dropped: "丢弃",
  arbitrated: "仲裁",
  planned: "规划",
  task_queued: "入队",
  task_running: "执行",
  progress: "进度",
  task_settled: "终态",
  failed: "失败",
  voice_started: "语音",
  voice_settled: "语音终态",
  settings_applied: "配置",
  connection_changed: "控制",
};

export const STATUS_LABELS: Record<AgentEventStatus, string> = {
  ok: "正常",
  waiting: "等待",
  degraded: "降级",
  failed: "失败",
  skipped: "已跳过",
  unknown: "未知",
};

export const EVENT_SOURCES: Record<AgentEvent["source"], string> = {
  ingress: "Ingress",
  agent: "Agent",
  goal: "目标运行时",
  voice: "语音",
  bridge: "Bridge",
  control: "控制面",
};

export interface TraceGroup {
  readonly traceId: string | null;
  readonly events: readonly AgentEvent[];
  readonly startedAt: number;
  readonly lastAt: number;
  readonly stages: readonly AgentEventStage[];
  readonly terminal: AgentEventStatus | null;
  readonly taskId: string | null;
  readonly decisionId: string | null;
  readonly goalId: string | null;
}

/**
 * Events arrive newest-first. A trace is the preferred join, but voice and
 * body frames can name only a task or decision. Falling back to those ids keeps
 * one comment's rows together instead of splitting its lifecycle by frame type.
 * A null join is its own group per event so two control events never merge.
 */
export function groupByTrace(events: readonly AgentEvent[], limit = 16): readonly TraceGroup[] {
  const parent = events.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let current = index;
    while (parent[current] !== root) {
      const next = parent[current]!;
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  // A voice or bridge frame can name only a task/decision that another event
  // already tied to a trace. Unioning all three keys makes grouping independent
  // of arrival order and keeps one comment's lifecycle in one row.
  const owners = new Map<string, number>();
  events.forEach((event, index) => {
    for (const key of [
      event.traceId === null ? null : `trace:${event.traceId}`,
      event.taskId === null ? null : `task:${event.taskId}`,
      event.decisionId === null ? null : `decision:${event.decisionId}`,
    ]) {
      if (key === null) continue;
      const owner = owners.get(key);
      if (owner === undefined) owners.set(key, index);
      else union(index, owner);
    }
  });

  const groups = new Map<number, AgentEvent[]>();
  events.forEach((event, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [event]);
    else group.push(event);
  });

  return [...groups.values()]
    .map((list): TraceGroup => {
      const ordered = [...list].sort((left, right) => left.at - right.at);
      const terminalEvent = [...ordered]
        .reverse()
        .find(
          (event) =>
            event.stage === "task_settled" ||
            event.stage === "failed" ||
            event.stage === "dropped" ||
            event.stage === "voice_settled",
        );
      return {
        traceId: lastValue(ordered, "traceId"),
        events: ordered,
        startedAt: ordered[0]?.at ?? 0,
        lastAt: ordered.at(-1)?.at ?? 0,
        stages: [...new Set(ordered.map((event) => event.stage))],
        terminal: terminalEvent?.status ?? null,
        taskId: lastValue(ordered, "taskId"),
        decisionId: lastValue(ordered, "decisionId"),
        goalId: lastValue(ordered, "goalId"),
      };
    })
    .sort((left, right) => right.lastAt - left.lastAt)
    .slice(0, limit);
}

/**
 * Configuration and connection events are useful in the feed, but they do not
 * have a comment lifecycle. Keep the pipeline anchored to the newest real trace
 * instead of letting a later system event blank it out.
 */
export function latestTraceGroup(groups: readonly TraceGroup[]): TraceGroup | undefined {
  return groups.find((group) => group.traceId !== null);
}

function lastValue<K extends "traceId" | "taskId" | "decisionId" | "goalId">(
  events: readonly AgentEvent[],
  key: K,
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = events[index]?.[key];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

export interface PipelineStep {
  readonly stage: AgentEventStage;
  readonly label: string;
  readonly status: AgentEventStatus | "pending";
  readonly at: number | null;
  readonly durationMs: number | null;
}

const PIPELINE: readonly AgentEventStage[] = [
  "ingress_received",
  "gated",
  "arbitrated",
  "planned",
  "task_queued",
  "task_running",
  "task_settled",
];

/**
 * The pipeline is derived from events only. A missing stage stays `pending`;
 * it is never drawn as a completed step just because a later stage exists.
 */
export function pipelineFor(group: TraceGroup | undefined): readonly PipelineStep[] {
  if (group === undefined) {
    return PIPELINE.map((stage) => ({
      stage,
      label: STAGE_LABELS[stage],
      status: "pending" as const,
      at: null,
      durationMs: null,
    }));
  }
  const dropped = group.events.find((event) => event.stage === "dropped");
  return PIPELINE.map((stage) => {
    const event = group.events.find((item) => item.stage === stage);
    const rejected = dropped !== undefined && stage === "gated";
    const blocked = dropped !== undefined && PIPELINE.indexOf(stage) > PIPELINE.indexOf("gated");
    return {
      stage,
      label: STAGE_LABELS[stage],
      status: event?.status ?? (rejected || blocked ? ("skipped" as const) : ("pending" as const)),
      at: event?.at ?? (rejected ? dropped.at : null),
      durationMs: event?.durationMs ?? (rejected ? dropped.durationMs : null),
    };
  });
}

export function currentWork(
  snapshot: ShowSnapshot,
  judgement: TelemetrySnapshot["judgement"] = null,
): {
  readonly label: string;
  readonly detail: string;
  readonly tone: "live" | "waiting" | "idle" | "bad";
} {
  if (snapshot.mode !== "agent") {
    return {
      label: snapshot.mode === "operator" ? "操作员接管" : "已急停",
      detail: snapshot.mode === "operator" ? "Agent 暂停动作，只保留旁白" : "等待操作员恢复",
      tone: "waiting",
    };
  }
  if (judgement !== null) {
    return {
      label: judgement.summary,
      detail: `意图 ${judgement.intent || "未标注"} · ${judgement.nextStep || "等待下一轮观察"}`,
      tone: "idle",
    };
  }
  const running = snapshot.decisions.find(
    (decision) => decision.outcome == null && decision.skill !== null,
  );
  if (running !== undefined) {
    return {
      label: running.skill?.name ?? "动作执行中",
      detail: `意图 ${running.intent} · 等待身体回报终态`,
      tone: "live",
    };
  }
  // A judgement is still useful work while the body is absent: the agent can
  // classify, gate and respond without executing. Do not hide it behind the
  // bridge empty state just because no action can be dispatched.
  if (snapshot.goal?.nextTask) {
    return {
      label: snapshot.goal.nextTask,
      detail: `阶段 ${snapshot.goal.stage.title} · 由目标运行时规划`,
      tone: "idle",
    };
  }
  if (snapshot.goal === null) {
    return {
      label: snapshot.bridge?.connected ? "尚无目标" : "身体未接入",
      detail: snapshot.bridge?.connected
        ? "目标模式未建立，Agent 只回应评论"
        : "进入世界后才会出现真实动作",
      tone: "waiting",
    };
  }
  return { label: "观察中", detail: snapshot.goal.stage.title, tone: "idle" };
}

export function goalProgress(goal: GoalProgress | null): {
  readonly completed: number;
  readonly total: number;
  readonly percent: number | null;
} {
  if (goal === null) return { completed: 0, total: 0, percent: null };
  const total = goal.milestones.length;
  return {
    completed: goal.completed,
    total,
    // No milestones means no defensible percentage; null renders "未验证".
    percent: total === 0 ? null : Math.round((goal.completed / total) * 100),
  };
}

export function queueCount(proposals: readonly Proposal[]): number {
  return proposals.filter((proposal) => proposal.status === "pending").length;
}

export function modeLabel(mode: ShowMode): string {
  if (mode === "operator") return "操作员";
  if (mode === "stopped") return "急停";
  return "自主";
}

export function voiceLabel(voice: VoiceStatus | null): string {
  if (voice === null) return "未接入";
  switch (voice.state) {
    case "idle":
      return voice.queued > 0 ? "排队中" : "待命";
    case "speaking":
      return "播报中";
    case "degraded":
      return "降级";
    default:
      return "未配置";
  }
}

export function relativeTime(at: number | null, now = Date.now()): string {
  if (at === null) return "未知";
  const delta = Math.max(0, now - at);
  if (delta < 5_000) return "刚刚";
  if (delta < 60_000) return `${Math.floor(delta / 1_000)} 秒前`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  return `${Math.floor(delta / 3_600_000)} 小时前`;
}

export function ingressIsKnown(metrics: IngressMetrics): boolean {
  return metrics.state !== "unknown" && metrics.state !== "not_configured";
}

