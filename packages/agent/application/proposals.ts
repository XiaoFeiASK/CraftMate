import {
  type AudienceEvent,
  type BridgeHealth,
  type GoalProgress,
  type Proposal,
  type ProposalAlignment,
  type ProposalRisk,
  type ProposalStatus,
  type SkillCall,
  type WorldSnapshot,
} from "@craftmate/contracts";
import {
  classifyIntent,
  evaluateProposal as evaluateSurvivalProposal,
  normalizeText,
  planSurvival,
  worldFactsFromSnapshot,
  type GoalId,
  type ProposalRisk as DomainProposalRisk,
} from "../domain/index.ts";
import type { Clock } from "./ports/clock.ts";
import { systemClock } from "./ports/clock.ts";

export type ProposalGateDecision = ProposalStatus;

export interface ProposalIngestResult {
  readonly proposal: Proposal;
  /** False when this comment was aggregated as another vote. */
  readonly created: boolean;
}

export interface ProposalRepository {
  /**
   * Returns the stored proposal, or null when this source event was already
   * recorded. The source event id is the idempotency key.
   */
  insert(proposal: Proposal): Proposal | null;
  update(proposal: Proposal): void;
  get(id: string): Proposal | null;
  list(status: ProposalStatus | null, limit: number): readonly Proposal[];
  /** A recent proposal with the same normalized text, for vote aggregation. */
  findRecentByText(normalizedText: string, since: number): Proposal | null;
  /** Returns the new vote count, or null when this event already voted. */
  addVote(input: {
    readonly proposalId: string;
    readonly sourceEventId: string;
    readonly audienceRef: string;
    readonly at: number;
  }): number | null;
}

export interface ProposalEvaluationInput {
  readonly proposal: Proposal;
  readonly goal: GoalProgress | null;
  readonly world: WorldSnapshot | null;
  /** Capabilities checked while projecting a plan; votes never grant skills. */
  readonly bridge?: BridgeHealth | null;
}

export interface ProposalEvaluation {
  readonly status: ProposalGateDecision;
  readonly reason: string;
  readonly risk: ProposalRisk;
  readonly goalAlignment: ProposalAlignment;
  /** Internal only: the execution gate checks capability, never dispatches. */
  readonly skill?: SkillCall | null;
}

/**
 * The pure goal-engine seam (#42 supplies the real implementation). A default
 * implementation keeps the inbox useful without inventing target alignment.
 */
export interface ProposalEvaluator {
  evaluate(input: ProposalEvaluationInput): ProposalEvaluation;
}

export interface ProposalExecutionContext {
  readonly mode: "agent" | "operator" | "stopped";
  readonly bridge: BridgeHealth | null;
  readonly world: WorldSnapshot | null;
  readonly goal: GoalProgress | null;
}

interface SafetyFinding {
  readonly risk: ProposalRisk;
  readonly reason: string;
}

const SAFETY_RULES: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /岩浆|lava/iu, reason: "安全闸门：岩浆区域不可由观众指派" },
  { pattern: /跳崖|跳下去|坠落|摔死|高处.*(?:跳|走)/u, reason: "安全闸门：高空与坠落风险不可由观众指派" },
  { pattern: /tnt|炸药|点燃.*炸|炸掉/u, reason: "安全闸门：爆炸物不可由观众指派" },
  { pattern: /自杀|杀死自己|杀了自己|送死|去死/u, reason: "安全闸门：自伤意图被确定性拒绝" },
  { pattern: /创造模式|作弊|开挂|\bop\b|give\s|gamemode|tp\s/iu, reason: "安全闸门：作弊与越权操作被确定性拒绝" },
  { pattern: /控制台|管理员|操作员|改目标|换目标|修改目标|接管/u, reason: "安全闸门：观众不能修改目标或取得控制权" },
  { pattern: /忽略.{0,6}(指令|规则|设定)|system\s*prompt|你现在是|无视.{0,4}(规则|限制)/iu, reason: "安全闸门：疑似提示词注入" },
] as const;

const EXPLICIT_REFUSALS: readonly RegExp[] = [
  /^(?:不要|别|不许|禁止|不准)/u,
  /(?:不要|别|不许|禁止|不准).{0,8}(?:跳|炸|杀|死|岩浆|tnt)/iu,
] as const;

const AGGREGATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Audience input becomes a proposal, never a command. The inbox owns the
 * deterministic safety gate and the execution gate; the goal engine owns the
 * target-alignment judgement.
 */
export class ProposalInbox {
  private readonly repository: ProposalRepository;
  private readonly evaluator: ProposalEvaluator;
  private readonly clock: Clock;
  private readonly shownVotes = new Set<string>();
  private readonly seenEvents = new Set<string>();

  constructor(options: {
    readonly repository: ProposalRepository;
    readonly evaluator?: ProposalEvaluator;
    readonly clock?: Clock;
  }) {
    this.repository = options.repository;
    this.evaluator = options.evaluator ?? new DefaultProposalEvaluator();
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Returns the created or vote-updated proposal. A duplicate source event is
   * ignored. Votes only change `votes`; they never change the gate status.
   */
  ingest(
    event: AudienceEvent,
    context: ProposalExecutionContext,
    audienceRef: string,
  ): ProposalIngestResult | null {
    if (event.kind !== "comment") return null;
    const text = event.text?.trim() ?? "";
    if (text.length === 0) return null;
    if (this.seenEvents.has(event.id)) return null;
    this.seenEvents.add(event.id);

    const normalized = normalizeText(text);
    const existing = this.repository.findRecentByText(
      normalized,
      this.clock.now() - AGGREGATE_WINDOW_MS,
    );
    if (existing) {
      const votes = this.repository.addVote({
        proposalId: existing.id,
        sourceEventId: event.id,
        audienceRef,
        at: this.clock.now(),
      });
      if (votes === null) {
        // Memory/imported repositories may not track votes; the event id still
        // dedupes the visible reply while the durable store decides the count.
        if (this.shownVotes.has(event.id)) return null;
      }
      this.shownVotes.add(event.id);
      const updated: Proposal = votes === null ? existing : { ...existing, votes };
      this.repository.update(updated);
      return { proposal: updated, created: false };
    }

    const intent = classifyIntent(event).intent;
    const base: Proposal = {
      id: this.clock.newId(),
      sourceEventId: event.id,
      audienceRef,
      text,
      votes: 1,
      intent,
      status: "pending",
      reason: "等待评估",
      risk: "low",
      goalAlignment: "unknown",
      createdAt: this.clock.now(),
      decidedAt: null,
    };

    const safety = safetyGate(text);
    if (safety !== null) {
      const rejected = this.persist({
        ...base,
        status: "rejected",
        reason: safety.reason,
        risk: safety.risk,
        goalAlignment: "unknown",
        decidedAt: this.clock.now(),
      });
      return rejected === null ? null : { proposal: rejected, created: true };
    }

    const evaluation = this.evaluator.evaluate({
      proposal: base,
      goal: context.goal,
      world: context.world,
      bridge: context.bridge,
    });
    const gated = executionGate(evaluation, context);
    const created = this.persist({
      ...base,
      status: gated.status,
      reason: gated.reason,
      risk: gated.risk,
      goalAlignment: gated.goalAlignment,
      decidedAt:
        gated.status === "pending" ? null : this.clock.now(),
    });
    return created === null ? null : { proposal: created, created: true };
  }

  /** Operator decision. A terminal proposal cannot be accepted twice. */
  decide(
    proposalId: string,
    status: Exclude<ProposalStatus, "pending">,
    reason: string,
    context: ProposalExecutionContext,
  ): Proposal | null {
    const proposal = this.repository.get(proposalId);
    if (!proposal || proposal.decidedAt !== null) return null;
    if (proposal.status === "accepted") return null;

    if (status === "accepted") {
      if (proposal.risk === "blocked" || safetyGate(proposal.text) !== null) {
        const rejected: Proposal = {
          ...proposal,
          status: "rejected",
          reason: "安全闸门：该提议不能被人为采纳",
          decidedAt: this.clock.now(),
        };
        this.repository.update(rejected);
        return rejected;
      }
      const gate = executionGate(
        {
          status: "accepted",
          reason,
          risk: proposal.risk,
          goalAlignment: proposal.goalAlignment,
          skill: null,
        },
        context,
      );
      if (gate.status !== "accepted") {
        const deferred: Proposal = {
          ...proposal,
          status: gate.status,
          reason: gate.reason,
          goalAlignment: gate.goalAlignment,
          decidedAt: this.clock.now(),
        };
        this.repository.update(deferred);
        return deferred;
      }
    }

    const decided: Proposal = {
      ...proposal,
      status,
      reason,
      decidedAt: this.clock.now(),
    };
    this.repository.update(decided);
    return decided;
  }

  query(status: ProposalStatus | null, limit: number): readonly Proposal[] {
    return this.repository.list(status, limit);
  }

  private persist(proposal: Proposal): Proposal | null {
    return this.repository.insert(proposal);
  }
}

/**
 * Without #42 there is no defensible goal-alignment claim. Safe proposals are
 * parked as pending; explicit refusals are rejected; nothing is auto-accepted.
 */
export class DefaultProposalEvaluator implements ProposalEvaluator {
  evaluate(input: ProposalEvaluationInput): ProposalEvaluation {
    const text = input.proposal.text.trim();
    if (EXPLICIT_REFUSALS.some((pattern) => pattern.test(text))) {
      return {
        status: "rejected",
        reason: "观众明确表示不要执行该提议",
        risk: "low",
        goalAlignment: "neutral",
      };
    }
    if (/^(?:\+?1|支持|同意|投票|赞)$/u.test(normalizeText(text))) {
      return {
        status: "clarify",
        reason: "只有投票，没有具体行动；请回复要推进的动作",
        risk: "low",
        goalAlignment: "unknown",
      };
    }
    return {
      status: "pending",
      reason:
        input.goal === null
          ? "目标引擎未接入，保留给操作员决定"
          : "等待目标引擎判断与当前阶段的一致性",
      risk: input.proposal.intent === "danger" ? "high" : "low",
      goalAlignment: "unknown",
    };
  }
}

/**
 * Adapter over #42's target-alignment judgement. It re-derives the plan from
 * the observed world on every proposal; it never trusts a stale plan or an
 * audience vote as a command.
 */
export class SurvivalProposalEvaluator implements ProposalEvaluator {
  evaluate(input: ProposalEvaluationInput): ProposalEvaluation {
    const facts = worldFactsFromSnapshot(
      input.world as Parameters<typeof worldFactsFromSnapshot>[0],
    );
    const target = toGoalId(input.goal?.stage.id);
    const plan = planSurvival(
      facts,
      {
        id: input.goal?.goalId ?? "unverified-goal",
        title: input.goal?.stage.title ?? "等待目标",
        target,
        version: input.goal?.goalVersion ?? 1,
        lockedByOperator: true,
        setBy: "operator",
        setAt: null,
      },
      input.bridge?.skills === undefined
        ? {}
        : { availableSkills: input.bridge.skills },
    );
    const verdict = evaluateSurvivalProposal({
      text: input.proposal.text,
      votes: input.proposal.votes,
      intent: input.proposal.intent,
      plan,
      facts,
    });
    return {
      status:
        verdict.verdict === "ACCEPT"
          ? "accepted"
          : verdict.verdict === "REJECT"
            ? "rejected"
            : verdict.verdict === "CLARIFY"
              ? "clarify"
              : "deferred",
      reason: verdict.reason,
      risk: toContractRisk(verdict.risk),
      goalAlignment:
        verdict.goalAlignment === "aligned"
          ? "aligned"
          : verdict.goalAlignment === "conflicting"
            ? "off_goal"
            : "neutral",
      skill: verdict.suggestedTask?.skill ?? null,
    };
  }
}

function toContractRisk(risk: DomainProposalRisk): ProposalRisk {
  if (risk === "critical") return "blocked";
  if (risk === "none") return "low";
  return risk;
}

function toGoalId(stage: string | undefined): GoalId {
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

/**
 * The third gate. It can defer an otherwise valid proposal because the body
 * is unavailable, the operator owns control, or the queue is busy.
 */
export function executionGate(
  evaluation: ProposalEvaluation,
  context: ProposalExecutionContext,
): ProposalEvaluation {
  if (evaluation.status !== "accepted") return evaluation;
  if (context.mode !== "agent") {
    return {
      ...evaluation,
      status: "deferred",
      reason: "执行闸门：当前不是 Agent 主控，提议已延后",
    };
  }
  const bridge = context.bridge;
  if (
    bridge === null ||
    !bridge.connected ||
    bridge.owner !== "agent" ||
    bridge.permission !== "agent"
  ) {
    return {
      ...evaluation,
      status: "deferred",
      reason: "执行闸门：没有可用的游戏身体或代理权，提议已延后",
    };
  }
  if (context.world === null || !context.world.inWorld) {
    return {
      ...evaluation,
      status: "deferred",
      reason: "执行闸门：客户端尚未进入世界，提议已延后",
    };
  }
  if (context.world.screenOpen === true) {
    return {
      ...evaluation,
      status: "deferred",
      reason: "执行闸门：玩家界面打开，提议已延后",
    };
  }
  if (bridge.queued > 0 || bridge.running > 0) {
    return {
      ...evaluation,
      status: "deferred",
      reason: "执行闸门：身体队列忙，提议已延后",
    };
  }
  if (evaluation.skill && !bridge.skills.includes(evaluation.skill.name)) {
    return {
      ...evaluation,
      status: "rejected",
      reason: `执行闸门：身体未声明 ${evaluation.skill.name} 能力`,
    };
  }
  return evaluation;
}

function safetyGate(text: string): SafetyFinding | null {
  for (const rule of SAFETY_RULES) {
    if (rule.pattern.test(text)) {
      return { risk: "blocked", reason: rule.reason };
    }
  }
  return null;
}

/** In-memory repository used by unit tests and previews. */
export class MemoryProposalRepository implements ProposalRepository {
  private readonly proposals = new Map<string, Proposal>();
  private readonly sourceEvents = new Set<string>();
  private readonly votes = new Set<string>();

  insert(proposal: Proposal): Proposal | null {
    if (this.sourceEvents.has(proposal.sourceEventId)) return null;
    this.sourceEvents.add(proposal.sourceEventId);
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  update(proposal: Proposal): void {
    this.proposals.set(proposal.id, proposal);
  }

  get(id: string): Proposal | null {
    return this.proposals.get(id) ?? null;
  }

  list(status: ProposalStatus | null, limit: number): readonly Proposal[] {
    return [...this.proposals.values()]
      .filter((proposal) => status === null || proposal.status === status)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit);
  }

  findRecentByText(normalizedText: string, since: number): Proposal | null {
    for (const proposal of this.proposals.values()) {
      if (
        proposal.createdAt >= since &&
        normalizeText(proposal.text) === normalizedText
      ) {
        return proposal;
      }
    }
    return null;
  }

  addVote(input: {
    readonly proposalId: string;
    readonly sourceEventId: string;
    readonly audienceRef: string;
    readonly at: number;
  }): number | null {
    if (this.votes.has(input.sourceEventId) || this.sourceEvents.has(input.sourceEventId)) {
      return null;
    }
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal) return null;
    this.votes.add(input.sourceEventId);
    const next = { ...proposal, votes: proposal.votes + 1 };
    this.proposals.set(proposal.id, next);
    return next.votes;
  }
}
