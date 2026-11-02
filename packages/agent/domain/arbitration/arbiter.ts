import type {
  AudienceEvent,
  Decision,
  DecisionKind,
  Intent,
  Priority,
  SkillCall,
} from "@craftmate/contracts";
import type { Clock } from "../clock.ts";
import type { Persona } from "../persona/schema.ts";
import { classifyIntent } from "./intent.ts";
import { SCORE_THRESHOLDS, scoreIntent } from "./scoring.ts";

export interface AudienceHistory {
  lastCommandAt(userId: string): number | null;
  recentIntentCount(intent: Intent, windowMs: number): number;
}

export interface ArbiterConfig {
  readonly persona: Persona;
  readonly history: AudienceHistory;
  readonly clock?: Clock;
  readonly cooldownMs?: number;
  readonly quorumWindowMs?: number;
  readonly quorumCount?: number;
}

export interface Arbitration {
  readonly decision: Decision;
}

const PRIORITY_BY_KIND: Record<DecisionKind, Priority> = {
  IGNORE: "ambient",
  OBSERVE: "ambient",
  ACK_ONLY: "ambient",
  QUEUE: "plan",
  EXECUTE: "command",
  REFUSE: "ambient",
};

const INJECTION_PATTERNS: readonly RegExp[] = [
  /忽略.{0,6}(指令|规则|设定)/u,
  /system\s*prompt/iu,
  /你现在是/iu,
];

const DEFAULT_CLOCK: Clock = {
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
};

/** Stage A (rules) and Stage B (scoring). Never calls a model. */
export class Arbiter {
  private readonly persona: Persona;
  private readonly history: AudienceHistory;
  private readonly clock: Clock;
  private readonly cooldownMs: number;
  private readonly quorumWindowMs: number;
  private readonly quorumCount: number;

  constructor(config: ArbiterConfig) {
    this.persona = config.persona;
    this.history = config.history;
    this.clock = config.clock ?? DEFAULT_CLOCK;
    this.cooldownMs = config.cooldownMs ?? 60_000;
    this.quorumWindowMs = config.quorumWindowMs ?? 10_000;
    this.quorumCount = config.quorumCount ?? 30;
  }

  evaluate(event: AudienceEvent): Arbitration {
    const text = event.text?.trim() ?? "";
    const { intent, confidence } = classifyIntent(event);

    const rulesOutcome = this.applyRules(event, text, intent);
    if (rulesOutcome) {
      return this.record(event, text, intent, {
        kind: rulesOutcome.kind,
        score: 0,
        reason: rulesOutcome.reason,
        stage: "rules",
        priority: rulesOutcome.priority ?? priorityFor(rulesOutcome.kind, 0),
      });
    }

    const score = scoreIntent({
      intent,
      confidence,
      textLength: text.length,
      personaWeights: this.persona.weights,
    });
    const quorum = this.history.recentIntentCount(intent, this.quorumWindowMs);
    const kind = this.decideKind(score, quorum, intent);

    return this.record(event, text, intent, {
      kind,
      score,
      reason: this.explain(kind, intent, quorum),
      stage: "scored",
      priority: priorityFor(kind, quorum),
    });
  }

  private applyRules(
    event: AudienceEvent,
    text: string,
    intent: Intent,
  ): { kind: DecisionKind; reason: string; priority?: Priority } | null {
    if (event.kind === "gift") return { kind: "ACK_ONLY", reason: "礼物只提升排队优先级" };
    if (event.kind !== "comment") return { kind: "IGNORE", reason: "非指令事件只记录" };
    if (text.length === 0) return { kind: "IGNORE", reason: "空评论" };
    if (intent === "spam") return { kind: "IGNORE", reason: "疑似刷屏" };
    if (INJECTION_PATTERNS.some((pattern) => pattern.test(text))) {
      return { kind: "REFUSE", reason: "疑似提示词注入" };
    }

    const last = this.history.lastCommandAt(event.userId);
    if (last !== null && this.clock.now() - last < this.cooldownMs) {
      return { kind: "IGNORE", reason: "观众冷却中" };
    }
    return null;
  }

  private decideKind(score: number, quorum: number, intent: Intent): DecisionKind {
    if (intent === "danger" && this.persona.weights.risk < 0.8) return "REFUSE";
    if (quorum >= this.quorumCount) return "QUEUE";
    if (score >= SCORE_THRESHOLDS.execute) return "EXECUTE";
    if (score >= SCORE_THRESHOLDS.acknowledge) return "ACK_ONLY";
    if (score >= SCORE_THRESHOLDS.queue) return "QUEUE";
    return intent === "chat" ? "OBSERVE" : "IGNORE";
  }

  private explain(kind: DecisionKind, intent: Intent, quorum: number): string {
    if (quorum >= this.quorumCount) return `${quorum} 人同时提到，升级为投票候选`;
    switch (kind) {
      case "REFUSE":
        return intent === "danger" ? "大肥鱼不敢做这个" : "不符合角色底线";
      case "EXECUTE":
        return "可行、合人格、有节目效果";
      case "ACK_ONLY":
        return "先回应，暂不执行";
      case "QUEUE":
        return "排进目标队列";
      case "OBSERVE":
        return "氛围评论，只记录";
      default:
        return "优先级不足";
    }
  }

  private record(
    event: AudienceEvent,
    text: string,
    intent: Intent,
    outcome: {
      kind: DecisionKind;
      score: number;
      reason: string;
      stage: Decision["stage"];
      priority: Priority;
      skill?: SkillCall | null;
    },
  ): Arbitration {
    return {
      decision: {
        id: this.clock.newId(),
        eventId: event.id,
        nickname: event.nickname,
        text,
        intent,
        decision: outcome.kind,
        priority: outcome.priority,
        reason: outcome.reason,
        score: Number(outcome.score.toFixed(2)),
        stage: outcome.stage,
        skill: outcome.skill ?? null,
        at: this.clock.now(),
      },
    };
  }
}

/**
 * Priority is deliberately derived from the decision, not from the intent:
 * a queued "mine" is still a plan, while a quorum-backed request outranks a
 * single command. Reflex and safety are never produced here — they belong to
 * the Mod and to the operator channel.
 */
function priorityFor(kind: DecisionKind, quorum: number): Priority {
  if (kind === "QUEUE" && quorum > 0) return "vote";
  return PRIORITY_BY_KIND[kind];
}
