import type {
  BodyEvent,
  Decision,
  DecisionKind,
  Intent,
  OperatorKind,
  Proposal,
  ProposalStatus,
  ShowSnapshot,
  TelemetrySnapshot,
} from "@craftmate/contracts";

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

export interface ProposalChatTurn {
  readonly kind: "proposal";
  readonly id: string;
  readonly at: number;
  readonly speaker: string;
  readonly text: string;
  readonly meta: readonly ChatMeta[];
  readonly proposalId: string;
  readonly status: ProposalStatus;
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

export type AgentChatEntry =
  | AudienceChatTurn
  | ProposalChatTurn
  | AgentChatMessage
  | SystemChatTurn;

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
  IGNORE: "略过",
  OBSERVE: "观察",
  ACK_ONLY: "回应",
  QUEUE: "记下",
  EXECUTE: "执行",
  REFUSE: "拒绝",
};

const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: "等你决定",
  accepted: "已采纳",
  deferred: "已稍后处理",
  rejected: "未采纳",
  clarify: "需要说清楚",
};

const BODY_EVENT_LABELS: Record<string, string> = {
  lava: "岩浆",
  low_health: "低生命",
  falling: "坠落",
  drowning: "溺水",
  on_fire: "着火",
  starving: "饥饿",
  creeper: "苦力怕",
};

/**
 * Builds the user-facing conversation. Audience comments and proposals use
 * their real text; the agent uses its planned speech when available. Decision
 * and bridge details stay as compact evidence under the bubble instead of
 * becoming a second timeline.
 */
export function buildAgentChat(
  snapshot: ShowSnapshot,
  telemetry: TelemetrySnapshot,
  worldEvents: readonly BodyEvent[] = [],
  limit = 24,
): readonly AgentChatEntry[] {
  const decisions = [...snapshot.decisions]
    .sort((left, right) => left.at - right.at)
    .slice(-Math.max(1, limit));
  const proposals = [...snapshot.proposals]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-Math.max(1, limit));

  const decisionByEvent = new Map<string, Decision>();
  for (const decision of snapshot.decisions) decisionByEvent.set(decision.eventId, decision);
  const proposalByEvent = new Map<string, Proposal>();
  for (const proposal of proposals) proposalByEvent.set(proposal.sourceEventId, proposal);

  const recentWorldEvents = [...worldEvents]
    .sort((left, right) => left.at - right.at)
    .slice(-8);
  const hasBodyReflex = recentWorldEvents.some((event) => event.name === "reflex");
  const turns: AgentChatEntry[] = [];

  decisions.forEach((decision, index) => {
    const current = index === decisions.length - 1;
    const proposal = proposalByEvent.get(decision.eventId);

    if (proposal !== undefined) {
      turns.push(proposalTurn(proposal, decision));
    } else {
      const origin = syntheticOrigin(decision.eventId);
      const skipReflexOrigin =
        hasBodyReflex &&
        (decision.eventId.startsWith("reflex:") ||
          decision.eventId.startsWith("system:reflex:"));
      if (origin !== null && !skipReflexOrigin) {
        turns.push({
          kind: "system",
          id: `origin-${decision.id}`,
          at: Math.max(0, decision.at - 1),
          text: origin,
          tone: decision.intent === "danger" ? "warn" : "quiet",
        });
      } else if (origin === null) {
        turns.push(audienceTurn(decision));
      }
    }

    turns.push(
      agentTurn(
        decision,
        current && judgementMatchesDecision(telemetry.judgement, decision)
          ? telemetry.judgement
          : null,
      ),
    );
  });

  for (const proposal of proposals) {
    if (decisionByEvent.has(proposal.sourceEventId)) continue;
    turns.push(proposalTurn(proposal, null));
  }

  for (const event of recentWorldEvents) {
    turns.push(bodyEventTurn(event));
  }

  if (snapshot.operatorNotice !== null) {
    turns.push({
      kind: "system",
      id: `operator-${snapshot.operatorNotice.at}`,
      at: snapshot.operatorNotice.at,
      text: operatorNoticeLine(snapshot.operatorNotice.kind),
      tone:
        snapshot.operatorNotice.kind === "stop"
          ? "bad"
          : snapshot.operatorNotice.kind === "takeover"
            ? "warn"
            : "quiet",
    });
  }

  if (turns.length === 0 && telemetry.judgement !== null) {
    turns.push({
      kind: "agent",
      id: "current-judgement",
      at: Date.now(),
      text: humanizeRuntimeText(telemetry.judgement.summary),
      meta: judgementMeta(telemetry.judgement),
      tone: "quiet",
      traceId: null,
      current: true,
    });
  }

  return dedupeAndSort(turns);
}

function audienceTurn(decision: Decision): AudienceChatTurn {
  const text = decision.text.trim();
  return {
    kind: "audience",
    id: `audience-${decision.id}`,
    at: Math.max(0, decision.at - 1),
    speaker: decision.nickname.trim() || "观众",
    text: text.length > 0 ? text : `想让你${INTENT_REQUESTS[decision.intent]}。`,
    meta: [],
    traceId: decision.eventId || null,
  };
}

function proposalTurn(proposal: Proposal, decision: Decision | null): ProposalChatTurn {
  const meta: ChatMeta[] = [
    {
      label: "提议",
      value: PROPOSAL_STATUS_LABELS[proposal.status],
      tone: proposalStatusTone(proposal.status),
    },
  ];
  if (proposal.votes > 1) {
    meta.push({ label: "支持", value: `${proposal.votes} 票` });
  }
  if (proposal.risk === "blocked" || proposal.risk === "high") {
    meta.push({
      label: "提醒",
      value: proposal.risk === "blocked" ? "安全上不建议" : "需要谨慎",
      tone: proposal.risk === "blocked" ? "bad" : "warn",
    });
  }

  return {
    kind: "proposal",
    id: `proposal-${proposal.id}`,
    at: proposal.createdAt,
    speaker:
      decision?.nickname.trim() ||
      (proposal.audienceRef.length > 0 ? `观众 ${shortRef(proposal.audienceRef)}` : "观众"),
    text: proposal.text,
    meta,
    proposalId: proposal.id,
    status: proposal.status,
    traceId: proposal.sourceEventId || null,
  };
}

function agentTurn(
  decision: Decision,
  judgement: TelemetrySnapshot["judgement"],
): AgentChatMessage {
  const outcome = decision.outcome ?? null;
  const skill = decision.skill;
  const speech = decision.speech.trim();
  const meta: ChatMeta[] = [];

  const decisionText =
    skill === null
      ? `${DECISION_LABELS[decision.decision]} · ${INTENT_LABELS[decision.intent]}`
      : `${DECISION_LABELS[decision.decision]} · ${SKILL_LABELS[skill.name] ?? skill.name}${skillArgsSummary(skill.name, skill.args)}`;
  meta.push({ label: "决策", value: decisionText });

  if (outcome !== null) {
    const changes = outcome.outcome?.changes?.length ?? 0;
    meta.push({
      label: "结果",
      value: changes > 0 ? `${outcomeLine(decision)} · ${changes} 处变化` : outcomeLine(decision),
      tone: outcomeTone(outcome.status),
    });
    if (outcome.outcome?.unconfirmed?.length) {
      meta.push({
        label: "待确认",
        value: `${outcome.outcome.unconfirmed.length} 项`,
        tone: "warn",
      });
    }
  } else if (skill !== null) {
    meta.push({ label: "状态", value: "正在执行", tone: "live" });
  }

  if (judgement !== null) {
    meta.push(...judgementMeta(judgement).slice(0, 1));
  }

  return {
    kind: "agent",
    id: `agent-${decision.id}`,
    at: decision.at,
    text: humanizeRuntimeText(outcome === null && speech.length > 0 ? speech : agentLine(decision)),
    meta: meta.slice(0, 4),
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
      if (decision.intent === "mine") return "挖到了，材料已经收进背包。";
      if (decision.intent === "move") return "我到了。";
      if (decision.intent === "craft") return "做好了，下一步继续。";
      return `${action}完成了。`;
    }
    if (outcome?.status === "failed") {
      if (decision.intent === "move") return "这条路走不通，我换个方向。";
      return `这次${action}没成，我先停一下。`;
    }
    if (outcome?.status === "timeout") return `${action}花的时间有点久，我先重新观察。`;
    if (outcome?.status === "cancelled") return `${action}先取消了。`;
    if (outcome?.status === "preempted") return "有更急的事，我先去做那个。";
    return `我去${action}，马上回来。`;
  }
  switch (decision.decision) {
    case "EXECUTE":
      return "这一步我来做。";
    case "QUEUE":
      return "先记下了，等手上这件事结束就处理。";
    case "REFUSE":
      return "这个我不接。";
    case "ACK_ONLY":
      if (decision.intent === "danger") return "安全优先，我先不接新动作。";
      if (decision.priority === "ambient") return "我接一句，不打断现在的节奏。";
      return "听到了，我先回应一下。";
    case "OBSERVE":
      return "我先看看情况，不急着动。";
    default:
      return "这条先略过。";
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
  if (outcome == null) return "等待结果";
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
      return "已切换优先任务";
  }
}

function decisionTone(decision: Decision): ChatTone {
  if (decision.decision === "REFUSE" || decision.decision === "IGNORE") return "quiet";
  if (decision.decision === "QUEUE") return "warn";
  if (decision.decision === "EXECUTE") return "live";
  return "quiet";
}

function proposalStatusTone(status: ProposalStatus): ChatTone {
  if (status === "accepted") return "good";
  if (status === "rejected") return "bad";
  if (status === "clarify") return "warn";
  return "quiet";
}

function outcomeTone(status: NonNullable<Decision["outcome"]>["status"]): ChatTone {
  if (status === "completed") return "good";
  if (status === "failed" || status === "timeout") return "bad";
  if (status === "preempted") return "warn";
  return "quiet";
}

function bodyEventTurn(event: BodyEvent): SystemChatTurn {
  const data = isRecord(event.data) ? event.data : null;
  const kind = data !== null && typeof data["kind"] === "string" ? data["kind"] : "";
  const detail = data !== null && typeof data["detail"] === "string" ? data["detail"] : "";
  const label = BODY_EVENT_LABELS[kind] ?? (kind || event.name);
  const health = data !== null && typeof data["health"] === "number" ? data["health"] : null;
  const text = [`身体避险 · ${label}`, humanizeRuntimeText(detail)]
    .filter((part) => part.length > 0)
    .join(" · ");
  return {
    kind: "system",
    id: `world-${event.at}-${event.name}-${kind}`,
    at: event.at,
    text: health === null ? text : `${text} · 生命 ${health.toFixed(1)}`,
    tone: event.name === "reflex" ? "warn" : "quiet",
  };
}

function operatorNoticeLine(kind: OperatorKind): string {
  if (kind === "takeover") return "操作员接管了控制";
  if (kind === "release") return "操作员把控制交还给 Agent";
  if (kind === "stop") return "操作员触发了急停";
  return "操作员私下提醒了一句";
}

function syntheticOrigin(eventId: string): string | null {
  if (eventId.startsWith("system:reflex:") || eventId.startsWith("reflex:")) {
    const kind = eventId.startsWith("system:reflex:")
      ? eventId.split(":")[2] ?? ""
      : eventId.split(":")[1] ?? "";
    return `安全反射 · ${reflexLabel(kind)}`;
  }
  if (eventId.startsWith("system:idle")) return "Agent 自己找了点话说";
  if (eventId.startsWith("goal:")) return "主线任务 · Agent 自主推进";
  return null;
}

function reflexLabel(kind: string): string {
  return BODY_EVENT_LABELS[kind] ?? (kind.length === 0 ? "危险" : kind);
}

function skillArgsSummary(name: string, args: Readonly<Record<string, unknown>>): string {
  if (name === "chop_tree" && typeof args["count"] === "number") {
    return ` × ${args["count"]}`;
  }
  if (name === "mine_block" && typeof args["block"] === "string") {
    const count = typeof args["count"] === "number" ? ` × ${args["count"]}` : "";
    return ` ${shortItem(args["block"])}${count}`;
  }
  if (name === "craft" && typeof args["item"] === "string") {
    return ` ${shortItem(args["item"])}`;
  }
  return "";
}

function shortItem(value: string): string {
  const name = value.replace(/^minecraft:/, "").replaceAll("_", " ");
  return ITEM_NAMES[name] ?? name;
}

function shortRef(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}…${value.slice(-3)}`;
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

function dedupeAndSort(entries: readonly AgentChatEntry[]): readonly AgentChatEntry[] {
  const unique = new Map<string, AgentChatEntry>();
  for (const entry of entries) unique.set(entry.id, entry);
  return [...unique.values()].sort((left, right) => {
    if (left.at !== right.at) return left.at - right.at;
    return kindOrder(left.kind) - kindOrder(right.kind);
  });
}

function kindOrder(kind: AgentChatEntry["kind"]): number {
  if (kind === "system") return 0;
  if (kind === "agent") return 2;
  return 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ITEM_NAMES: Readonly<Record<string, string>> = {
  oak_log: "橡木原木",
  birch_log: "白桦原木",
  spruce_log: "云杉原木",
  oak_planks: "橡木木板",
  birch_planks: "白桦木板",
  stick: "木棍",
  crafting_table: "工作台",
  wooden_pickaxe: "木镐",
  stone_pickaxe: "石镐",
  iron_pickaxe: "铁镐",
  furnace: "熔炉",
  cobblestone: "圆石",
  raw_iron: "粗铁",
  iron_ingot: "铁锭",
  coal: "煤炭",
  charcoal: "木炭",
  torch: "火把",
  wool: "羊毛",
  bed: "床",
};

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
    [/\bconfirmed 0 hit\(s\) before the attack stopped\b/g, "攻击没有命中"],
    [/\bno safe standing route reached the target\b/g, "没有找到安全的接近路线"],
    [/\bcould not pillar through the ceiling\b/g, "无法继续向上突破"],
    [/\barrived at the requested position\b/g, "已到达指定位置"],
    [/\bminecraft:/g, ""],
  ];
  return replacements.reduce(
    (text, [pattern, label]) => text.replace(pattern, label),
    value,
  );
}
