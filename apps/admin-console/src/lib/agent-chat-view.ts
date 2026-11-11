import type {
  Decision,
  DecisionKind,
  Intent,
  ShowSnapshot,
  TelemetrySnapshot,
} from "@craftmate/contracts";
import { groupByTrace as groupEventsByTrace, type TraceGroup } from "./telemetry-view.ts";

export type ChatTone = "live" | "good" | "warn" | "bad" | "quiet";

export interface ChatMeta {
  readonly label: string;
  readonly value: string;
  readonly tone?: ChatTone;
}

export interface AudienceChatTurn {
  readonly kind: "audience";
  readonly id: string;
  readonly at: number;
  readonly speaker: string;
  readonly text: string;
  readonly meta: readonly ChatMeta[];
  readonly traceId: string | null;
}

export interface AgentChatMessage {
  readonly kind: "agent";
  readonly id: string;
  readonly at: number;
  readonly text: string;
  readonly meta: readonly ChatMeta[];
  readonly tone: ChatTone;
  readonly traceId: string | null;
  readonly current: boolean;
}

export interface SystemChatTurn {
  readonly kind: "system";
  readonly id: string;
  readonly at: number;
  readonly text: string;
  readonly tone: ChatTone;
}

export type AgentChatEntry = AudienceChatTurn | AgentChatMessage | SystemChatTurn;

const INTENT_LABELS: Record<Intent, string> = {
  move: "移动",
  mine: "采集",
  build: "建造",
  craft: "合成",
  eat: "进食",
  follow: "跟随",
  chat: "聊天",
  danger: "危险",
  spam: "刷屏",
  unknown: "未知",
};

const INTENT_REQUESTS: Record<Intent, string> = {
  move: "去一个地方",
  mine: "采集点东西",
  build: "搭点东西",
  craft: "做个东西",
  eat: "找点吃的",
  follow: "跟着某个人",
  chat: "陪聊两句",
  danger: "处理眼前的情况",
  spam: "发重复内容",
  unknown: "做一件还不清楚的事",
};

const SKILL_LABELS: Record<string, string> = {
  goto: "移动",
  follow: "跟随",
  flee: "撤离",
  look_at: "观察",
  mine_block: "挖方块",
  chop_tree: "砍树",
  collect_items: "拾取物品",
  craft: "合成",
  equip: "装备",
  eat: "吃东西",
  deposit: "存入容器",
  place_block: "放置方块",
  pillar_up: "搭高",
  build_schematic: "搭建",
  descend: "向下挖掘",
  smelt: "熔炼",
  attack: "攻击",
  use_block: "使用方块",
  sleep: "睡觉",
  say: "说话",
  emote: "做动作",
  wait: "等待",
};

const DECISION_LABELS: Record<DecisionKind, string> = {
  IGNORE: "忽略",
  OBSERVE: "观察",
  ACK_ONLY: "只回应",
  QUEUE: "排队",
  EXECUTE: "执行",
  REFUSE: "拒绝",
};

/**
 * Builds the operator-facing chat transcript from structured facts only.
 *
 * Audience text, decision reasons and model prose intentionally never enter
 * this projection. A chat bubble can say what kind of request arrived and what
 * the agent did, but the raw comment remains in SQLite for audit/replay.
 */
export function buildAgentChat(
  snapshot: ShowSnapshot,
  telemetry: TelemetrySnapshot,
  limit = 12,
): readonly AgentChatEntry[] {
  const decisions = [...snapshot.decisions]
    .sort((left, right) => left.at - right.at)
    .slice(-Math.max(1, limit));
  const groups = groupEventsByTrace(telemetry.events, Math.max(32, limit * 2));
  const groupByDecision = new Map<string, TraceGroup>();
  const groupByTraceId = new Map<string, TraceGroup>();
  for (const group of groups) {
    if (group.decisionId !== null) groupByDecision.set(group.decisionId, group);
    if (group.traceId !== null) groupByTraceId.set(group.traceId, group);
  }

  const turns: AgentChatEntry[] = [];
  decisions.forEach((decision, index) => {
    const current = index === decisions.length - 1;
    const group =
      groupByDecision.get(decision.id) ??
      groupByTraceId.get(decision.eventId) ??
      null;
    const origin = syntheticOrigin(decision.eventId);
    if (origin === null) {
      turns.push(audienceTurn(decision));
    } else {
      turns.push({
        kind: "system",
        id: `origin-${decision.id}`,
        at: Math.max(0, decision.at - 1),
        text: origin,
        tone: decision.intent === "danger" ? "warn" : "quiet",
      });
    }
    turns.push(
      agentTurn(
        decision,
        group,
        current && judgementMatchesDecision(telemetry.judgement, decision)
          ? telemetry.judgement
          : null,
      ),
    );
  });

  if (turns.length === 0 && telemetry.judgement !== null) {
    turns.push({
      kind: "agent",
      id: "current-judgement",
      at: Date.now(),
      text: telemetry.judgement.summary,
      meta: judgementMeta(telemetry.judgement),
      tone: "quiet",
      traceId: null,
      current: true,
    });
  }

  return turns.sort((left, right) => left.at - right.at);
}

function audienceTurn(decision: Decision): AudienceChatTurn {
  return {
    kind: "audience",
    id: `audience-${decision.id}`,
    at: Math.max(0, decision.at - 1),
    speaker: decision.nickname || "观众",
    text: `想让你${INTENT_REQUESTS[decision.intent]}。`,
    meta: [
      { label: "意图", value: INTENT_LABELS[decision.intent] },
      { label: "决策", value: DECISION_LABELS[decision.decision] },
    ],
    traceId: decision.eventId || null,
  };
}

function agentTurn(
  decision: Decision,
  group: TraceGroup | null,
  judgement: TelemetrySnapshot["judgement"],
): AgentChatMessage {
  const outcome = decision.outcome ?? null;
  const skill = decision.skill;
  const meta: ChatMeta[] = [];
  if (judgement !== null) meta.push(...judgementMeta(judgement));
  meta.push({
    label: "决策",
    value: `${DECISION_LABELS[decision.decision]} · ${INTENT_LABELS[decision.intent]}`,
  });
  if (skill !== null) {
    meta.push({
      label: "技能",
      value: `${SKILL_LABELS[skill.name] ?? skill.name}${skillArgsSummary(skill.name, skill.args)}`,
    });
  }
  if (outcome !== null) {
    meta.push({
      label: "结果",
      value: outcomeLine(decision),
      tone: outcomeTone(outcome.status),
    });
    meta.push(...outcomeEvidence(decision));
  } else if (skill !== null) {
    meta.push({ label: "结果", value: "等待身体回传终态", tone: "live" });
  }
  if (meta.length === 0 && group !== null) {
    const latest = group.events.at(-1);
    if (latest !== undefined && latest.summary.length > 0) {
      meta.push({ label: "运行时", value: latest.summary });
    }
  }

  return {
    kind: "agent",
    id: `agent-${decision.id}`,
    at: decision.at,
    text: humanizeRuntimeText(judgement?.summary ?? agentLine(decision)),
    meta: meta.slice(0, 6),
    tone: outcome === null ? decisionTone(decision) : outcomeTone(outcome.status),
    traceId: decision.eventId || null,
    current: false,
  };
}

function agentLine(decision: Decision): string {
  const skill = decision.skill;
  const outcome = decision.outcome;
  if (decision.decision === "EXECUTE" && skill !== null) {
    const action = SKILL_LABELS[skill.name] ?? skill.name;
    if (outcome?.status === "completed") {
      return `${action}完成，世界证据已经回传。`;
    }
    if (outcome?.status === "failed") {
      return `${action}没有完成，我先停一下。`;
    }
    if (outcome?.status === "timeout") {
      return `${action}超时了，等下一轮重新观察。`;
    }
    if (outcome?.status === "cancelled") {
      return `${action}已经取消。`;
    }
    if (outcome?.status === "preempted") {
      return `${action}被更重要的任务顶替了。`;
    }
    return `我把「${SKILL_LABELS[skill.name] ?? skill.name}」交给身体了，等它回报。`;
  }
  switch (decision.decision) {
    case "EXECUTE":
      return "我决定执行这一步。";
    case "QUEUE":
      return "先记下，等目标窗口再处理。";
    case "REFUSE":
      return "这个我不接。";
    case "ACK_ONLY":
      if (decision.intent === "danger") {
        return "安全优先，我先不接新动作。";
      }
      if (decision.priority === "ambient") {
        return "我自己接一句，不打断当前节奏。";
      }
      return "这条我只回应，不交给身体。";
    case "OBSERVE":
      return "我先观察，不急着动。";
    default:
      return "这条略过。";
  }
}

function judgementMeta(
  judgement: NonNullable<TelemetrySnapshot["judgement"]>,
): readonly ChatMeta[] {
  const meta: ChatMeta[] = [];
  if (judgement.reason.length > 0) {
    meta.push({
      label: "判断",
    value: humanizeRuntimeText(judgement.reason),
      tone: judgement.confidence === "observed" ? "good" : "warn",
    });
  }
  if (judgement.nextStep.length > 0) {
    meta.push({ label: "下一步", value: humanizeRuntimeText(judgement.nextStep) });
  }
  return meta;
}

function outcomeLine(decision: Decision): string {
  const outcome = decision.outcome;
  if (outcome == null) return "等待终态";
  const skill = decision.skill?.name;
  const action = skill === undefined ? "动作" : SKILL_LABELS[skill] ?? skill;
  switch (outcome.status) {
    case "completed":
      return `${action}完成`;
    case "failed":
      return `${action}没有完成`;
    case "timeout":
      return `${action}超时`;
    case "cancelled":
      return `${action}已取消`;
    case "preempted":
      return `${action}被更高优先级任务顶替`;
  }
}

function outcomeEvidence(decision: Decision): readonly ChatMeta[] {
  const result = decision.outcome?.outcome;
  if (result == null) return [];
  const meta: ChatMeta[] = [];
  for (const change of result.changes?.slice(0, 2) ?? []) {
    const position =
      change.position === undefined
        ? ""
        : ` · ${Math.round(change.position.x)}, ${Math.round(change.position.y)}, ${Math.round(change.position.z)}`;
    meta.push({ label: "世界证据", value: `${change.detail}${position}`, tone: "good" });
  }
  if (result.progress !== undefined) {
    meta.push({
      label: "进度",
      value: `${result.progress.done}/${result.progress.total ?? "?"}${
        result.progress.unit === undefined ? "" : ` ${result.progress.unit}`
      }`,
    });
  }
  if (result.unconfirmed !== undefined && result.unconfirmed.length > 0) {
    meta.push({
      label: "待确认",
      value: result.unconfirmed.join("；"),
      tone: "warn",
    });
  }
  if (meta.length === 0 && result.summary !== undefined) {
    meta.push({ label: "结果", value: result.summary });
  }
  return meta;
}

function decisionTone(decision: Decision): ChatTone {
  if (decision.decision === "REFUSE" || decision.decision === "IGNORE") return "quiet";
  if (decision.decision === "QUEUE") return "warn";
  if (decision.decision === "EXECUTE") return "live";
  return "quiet";
}

function outcomeTone(status: NonNullable<Decision["outcome"]>["status"]): ChatTone {
  if (status === "completed") return "good";
  if (status === "failed" || status === "timeout") return "bad";
  if (status === "preempted") return "warn";
  return "quiet";
}

function syntheticOrigin(eventId: string): string | null {
  if (eventId.startsWith("system:reflex:") || eventId.startsWith("reflex:")) {
    const kind = eventId.startsWith("system:reflex:")
      ? eventId.split(":")[2] ?? ""
      : eventId.split(":")[1] ?? "";
    return `安全反射 · ${reflexLabel(kind)}`;
  }
  if (eventId.startsWith("system:idle")) return "空场节拍 · Agent 自己接了一句";
  if (eventId.startsWith("goal:")) return "主线任务 · 自主推进";
  return null;
}

function reflexLabel(kind: string): string {
  switch (kind) {
    case "falling":
      return "坠落";
    case "drowning":
      return "溺水";
    case "lava":
      return "岩浆";
    case "creeper":
      return "苦力怕";
    case "low_health":
      return "低生命";
    default:
      return kind.length === 0 ? "危险" : kind;
  }
}

function skillArgsSummary(name: string, args: Readonly<Record<string, unknown>>): string {
  if (name === "chop_tree" && typeof args["count"] === "number") {
    return ` × ${args["count"]}`;
  }
  if (name === "mine_block" && typeof args["block"] === "string") {
    const count = typeof args["count"] === "number" ? ` × ${args["count"]}` : "";
    return ` ${shortBlock(args["block"])}${count}`;
  }
  if (name === "craft" && typeof args["item"] === "string") {
    return ` ${shortItem(args["item"])}`;
  }
  return "";
}

function shortBlock(value: string): string {
  return value.replace(/^minecraft:/, "");
}

function shortItem(value: string): string {
  return value.replace(/^minecraft:/, "");
}

function judgementMatchesDecision(
  judgement: TelemetrySnapshot["judgement"],
  decision: Decision,
): judgement is NonNullable<TelemetrySnapshot["judgement"]> {
  if (judgement === null) return false;
  const skill = decision.skill?.name;
  if (skill === undefined) return false;
  return (
    judgement.summary.includes(skill) ||
    judgement.nextStep.includes(skill) ||
    judgement.reason.includes(skill)
  );
}

export function humanizeRuntimeText(value: string): string {
  const replacements: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bchop_tree\b/g, "砍树"],
    [/\bmine_block\b/g, "挖方块"],
    [/\bcollect_items\b/g, "拾取物品"],
    [/\bgoto\b/g, "移动"],
    [/\blook_at\b/g, "观察"],
    [/\bplace_block\b/g, "放置方块"],
    [/\bcraft\b/g, "合成"],
    [/\bsmelt\b/g, "熔炼"],
    [/\battack\b/g, "攻击"],
    [/\bdeposit\b/g, "存入容器"],
    [/\bequip\b/g, "装备"],
    [/\bpillar_up\b/g, "搭高"],
    [/\bdescend\b/g, "向下挖掘"],
    [/\buse_block\b/g, "使用方块"],
  ];
  return replacements.reduce(
    (text, [pattern, label]) => text.replace(pattern, label),
    value,
  );
}
