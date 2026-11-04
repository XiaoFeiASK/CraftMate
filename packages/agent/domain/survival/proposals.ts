import type { Intent } from "@craftmate/contracts";
import { hasHostileNearby, isLowHealth } from "./facts.ts";
import type {
  GoalAlignment,
  ProposalDecision,
  ProposalInput,
  ProposalRisk,
  ProposalVerdict,
  Task,
} from "./types.ts";

interface SafetyRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly reason: string;
  readonly risk: ProposalRisk;
}

/**
 * Deterministic safety gate. Votes are deliberately absent from the matching
 * function: no audience size can turn these into an allowed action.
 */
const SAFETY_RULES: readonly SafetyRule[] = [
  {
    id: "lava",
    pattern: /跳(进|入|下)?\s*岩浆|岩浆(里|中)|lava/iu,
    reason: "跳到岩浆会造成不可逆伤害，安全规则拒绝，票数不能覆盖",
    risk: "critical",
  },
  {
    id: "fall",
    pattern: /跳(下|楼|崖)|摔死|从高处(跳|落)|jump\s+off/iu,
    reason: "主动坠落会造成伤害，安全规则拒绝",
    risk: "critical",
  },
  {
    id: "tnt",
    pattern: /\bTNT\b|炸药|引爆|炸死/iu,
    reason: "TNT 会破坏世界并伤害玩家，安全规则拒绝",
    risk: "critical",
  },
  {
    id: "suicide",
    pattern: /自杀|杀死自己|去死|自杀式|kill\s+(yourself|me)/iu,
    reason: "自伤/自杀请求违反安全规则，任何票数都不能覆盖",
    risk: "critical",
  },
  {
    id: "cheat",
    pattern: /作弊|开挂|\bcheat\b|\bop\s+me\b|give\s+me|创造模式|creative/iu,
    reason: "作弊或越权会破坏可验证性，安全规则拒绝",
    risk: "high",
  },
  {
    id: "permission",
    pattern: /拿走?操作员|接管控制|改密码|给管理权限|\bop\s+权限|\bop\s+me\b|sudo|admin\s+access/iu,
    reason: "观众不能获得操作员权限或控制权",
    risk: "critical",
  },
  {
    id: "prompt_injection",
    pattern: /忽略(之前|以上|所有)(的)?(规则|指令)|ignore\s+(all\s+)?(previous|prior)\s+instructions|你现在是/iu,
    reason: "提示词注入不能改变安全与权限规则",
    risk: "high",
  },
];

const STAGE_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "wood-and-table": ["木头", "原木", "砍树", "木板", "工作台", "wood", "log", "plank", "table"],
  "stone-tools": ["石头", "圆石", "木镐", "石镐", "镐", "stone", "cobblestone", "pickaxe"],
  food: ["食物", "吃", "饥饿", "面包", "肉", "food", "eat", "hungry"],
  shelter: ["房子", "庇护所", "床", "睡觉", "夜晚", "house", "shelter", "bed", "sleep"],
  iron: ["铁", "熔炉", "烧", "铁器", "iron", "furnace", "smelt"],
  nether: ["下界", "黑曜石", "传送门", "烈焰", "nether", "obsidian", "portal", "blaze"],
  eyes: ["末影珍珠", "末影之眼", "烈焰粉", "ender", "pearl", "eye", "blaze"],
  stronghold: ["要塞", "定位", "stronghold", "locate"],
  dragon: ["末地", "末影龙", "龙", "end", "dragon"],
};

export function evaluateProposal(input: ProposalInput): ProposalDecision {
  const text = input.text.trim();
  const safety = SAFETY_RULES.find((rule) => rule.pattern.test(text));
  if (safety !== undefined) {
    return decision("REJECT", safety.reason, safety.risk, "conflicting", null);
  }
  if (text.length === 0 || !hasOperationalKeyword(text)) {
    return decision("CLARIFY", "提议为空，无法判断目标与风险", "none", "neutral", null);
  }
  if (input.votes < 0 || !Number.isFinite(input.votes)) {
    return decision("REJECT", "票数无效", "low", "neutral", null);
  }

  const currentStage = input.plan.stage;
  const mentioned = stageForText(text);
  const alignment = alignmentFor(currentStage, mentioned, input.intent);

  if (alignment === "conflicting") {
    return decision(
      "REJECT",
      `提议与当前阶段「${input.plan.stageTitle}」冲突，不能绕过既定依赖`,
      "medium",
      alignment,
      null,
    );
  }

  if (hasHostileNearby(input.facts, 5) || isLowHealth(input.facts)) {
    return decision(
      "DEFER",
      "当前环境不安全，先处理威胁；提议保留到安全窗口再评估",
      "high",
      alignment,
      null,
    );
  }

  const task = actionableTask(input);
  if (task !== null) {
    return decision(
      "ACCEPT",
      `提议与当前里程碑一致，转换为计划内任务「${task.title}」`,
      "low",
      "aligned",
      task,
    );
  }

  if (input.intent === "danger") {
    return decision(
      "REJECT",
      "提议被判定为危险动作，安全规则拒绝，票数不能覆盖",
      "high",
      "conflicting",
      null,
    );
  }

  if (input.plan.task === null && mentioned !== null && mentioned !== currentStage) {
    return decision(
      "DEFER",
      `提议属于后续阶段「${mentioned}」；先完成当前阶段，不跳步`,
      "low",
      "neutral",
      null,
    );
  }
  if (alignment === "aligned" && input.plan.task === null) {
    return decision(
      "DEFER",
      "方向一致，但当前计划没有可执行任务或有更紧的前置条件",
      "low",
      alignment,
      null,
    );
  }
  if (mentioned !== null && mentioned !== currentStage) {
    return decision(
      "DEFER",
      `提议属于后续阶段「${mentioned}」；先完成当前阶段，不跳步`,
      "low",
      "neutral",
      null,
    );
  }
  return decision(
    "DEFER",
    "可执行但不在当前里程碑的任务集中；先按计划推进，稍后再评估",
    "low",
    alignment,
    null,
  );
}

/**
 * Converts a proposal into a task only when the proposal's intent matches the
 * current milestone. It never creates a skill from the audience text.
 */
function actionableTask(input: ProposalInput): Task | null {
  const task = input.plan.task;
  if (task === null) return null;
  const currentStageWords = STAGE_KEYWORDS[input.plan.stage] ?? [];
  const lower = input.text.toLowerCase();
  const matchesStage = currentStageWords.some((word) => lower.includes(word.toLowerCase()));
  if (!matchesStage) {
    return null;
  }
  if (task.stage !== input.plan.stage) return null;
  if (task.kind === "combat" && input.intent === "build") return null;
  if (task.kind === "craft" && input.intent === "mine") return null;
  return task;
}

function alignmentFor(
  current: string,
  mentioned: string | null,
  intent: Intent,
): GoalAlignment {
  if (intent === "spam" || intent === "danger") return "conflicting";
  if (mentioned === null) return "neutral";
  if (mentioned === current) return "aligned";
  return "neutral";
}

function stageForText(text: string): string | null {
  const lower = text.toLowerCase();
  const order = ["wood-and-table", "stone-tools", "food", "shelter", "iron", "nether", "eyes", "stronghold", "dragon"];
  for (const stage of order) {
    const words = STAGE_KEYWORDS[stage] ?? [];
    if (words.some((word) => lower.includes(word.toLowerCase()))) return stage;
  }
  return null;
}

function hasOperationalKeyword(text: string): boolean {
  return Object.values(STAGE_KEYWORDS).some((words) =>
    words.some((word) => text.toLowerCase().includes(word.toLowerCase())),
  );
}

function decision(
  verdict: ProposalVerdict,
  reason: string,
  risk: ProposalRisk,
  goalAlignment: GoalAlignment,
  suggestedTask: Task | null,
): ProposalDecision {
  return { verdict, reason, risk, goalAlignment, suggestedTask };
}
