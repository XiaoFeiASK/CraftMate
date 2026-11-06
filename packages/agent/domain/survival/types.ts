import type { Intent, SkillCall } from "@craftmate/contracts";
import type { ToolTier } from "../knowledge/src/index.ts";

export type GoalId = "wood-and-table" | "stone-tools" | "food" | "shelter" | "iron" | "nether" | "eyes" | "stronghold" | "dragon";

export const STAGE_ORDER: readonly GoalId[] = [
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

export interface InventorySlot {
  readonly item: string;
  readonly count: number;
  readonly section?: "hotbar" | "main" | "armor" | "offhand";
  readonly slot?: number;
}

export interface NearbyBlock {
  readonly id: string;
  readonly count?: number;
}

export interface NearbyEntity {
  readonly name: string;
  readonly type: string;
  readonly distance: number;
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
}

export interface Position {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A read-only projection of #39's WorldSnapshot. Every value is optional
 * because an older body, a stalled render thread, or a reconnect may only
 * provide a subset. `unverified` must stay distinguishable from `false`.
 */
export interface WorldFacts {
  readonly inWorld: boolean;
  readonly world?: string | null;
  readonly dimension?: string | null;
  readonly position?: Position | null;
  readonly health?: number | null;
  readonly food?: number | null;
  /** True once this body session observed a food item in its inventory. */
  readonly foodAcquired?: boolean | null;
  /** True once this body session confirmed eating a food item. */
  readonly foodConsumed?: boolean | null;
  /** True once this body session crafted a crafting table. */
  readonly craftingTableCrafted?: boolean | null;
  /** True once this body session placed a crafting table in the world. */
  readonly craftingTablePlaced?: boolean | null;
  /** True while a crafting table is within the body's observation radius. */
  readonly craftingTableNearby?: boolean | null;
  /** Last crafting table this body placed. */
  readonly craftingTable?: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly timeOfDay?: number | null;
  readonly day?: number | null;
  readonly sleeping?: boolean | null;
  /** True only after this body completed a sleep that advanced the day. */
  readonly sleptThroughNight?: boolean | null;
  readonly screenOpen?: boolean | null;
  readonly onGround?: boolean | null;
  readonly inventory: readonly InventorySlot[];
  readonly nearbyBlocks?: readonly NearbyBlock[];
  readonly entities?: readonly NearbyEntity[];
  readonly selectedItem?: string | null;
  /** A block the body can aim at now; absence is not proof that none exist. */
  readonly reachableBlock?: {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly z: number;
  } | null;
  /** Facility the body can currently reach and use. */
  readonly stations?: readonly ("crafting_table" | "furnace" | "blast_furnace" | "bed" | "portal")[];
}

export interface Milestone {
  readonly id: string;
  readonly title: string;
  /** Human-readable condition, always answerable from WorldFacts. */
  readonly condition: string;
  readonly verify: (facts: WorldFacts) => MilestoneStatus;
  readonly optional?: boolean;
}

export type MilestoneStatus = "complete" | "incomplete" | "unverified";

export interface Stage {
  readonly id: GoalId;
  readonly index: number;
  readonly title: string;
  readonly objective: string;
  /** Stage ids that must be complete before this one is actionable. */
  readonly requires: readonly GoalId[];
  readonly milestones: readonly Milestone[];
}

export interface SeasonGoal {
  readonly id: string;
  readonly title: string;
  /** The terminal stage. `dragon` for the default objective. */
  readonly target: GoalId;
  readonly version: number;
  /** Operator lock: autonomous planners must not replace it. */
  readonly lockedByOperator: boolean;
  readonly setBy?: string | null;
  readonly setAt?: number | null;
}

export type TaskKind = "gather" | "craft" | "place" | "mine" | "smelt" | "combat" | "interact" | "navigate";
export type TaskStatus = "ready" | "blocked";
export type MissingKind =
  | "material"
  | "tool"
  | "station"
  | "resource"
  | "dimension"
  | "safety"
  | "capability";

export interface Missing {
  readonly kind: MissingKind;
  readonly item?: string;
  readonly count?: number;
  readonly detail: string;
}

export interface Task {
  readonly id: string;
  readonly stage: GoalId;
  readonly kind: TaskKind;
  readonly title: string;
  readonly skill: SkillCall;
  /** Facts that make this task applicable; used by the runtime to re-check. */
  readonly preconditions: readonly string[];
  readonly expectedEvidence: readonly string[];
  /** What the body result should prove. */
  readonly verify: (facts: WorldFacts) => boolean;
}

export interface BlockedTask {
  readonly stage: GoalId;
  readonly kind: TaskKind;
  readonly title: string;
  readonly missing: readonly Missing[];
}

export interface MilestoneResult {
  readonly id: string;
  readonly title: string;
  readonly status: MilestoneStatus;
  readonly condition: string;
}

export interface StageResult {
  readonly id: GoalId;
  readonly index: number;
  readonly title: string;
  readonly status: "complete" | "active" | "pending" | "blocked";
  readonly milestones: readonly MilestoneResult[];
}

export interface SurvivalPlan {
  readonly goal: SeasonGoal;
  readonly stage: GoalId;
  readonly stageTitle: string;
  readonly stages: readonly StageResult[];
  readonly milestone: MilestoneResult | null;
  readonly task: Task | null;
  readonly blocked: readonly BlockedTask[];
  readonly missing: readonly Missing[];
  /** 0..1, derived solely from verified milestones. */
  readonly verifiedProgress: number;
  readonly completedMilestones: number;
  readonly totalMilestones: number;
  readonly recoveredFrom: string | null;
  readonly evaluatedAt: number;
}

export type ProposalVerdict = "ACCEPT" | "DEFER" | "REJECT" | "CLARIFY";
export type ProposalRisk = "none" | "low" | "medium" | "high" | "critical";
export type GoalAlignment = "aligned" | "neutral" | "conflicting";

export interface ProposalDecision {
  readonly verdict: ProposalVerdict;
  readonly reason: string;
  readonly risk: ProposalRisk;
  readonly goalAlignment: GoalAlignment;
  /** Safe, already-validated next task; null when the proposal must not act. */
  readonly suggestedTask: Task | null;
}

export interface ProposalInput {
  readonly text: string;
  readonly votes: number;
  readonly intent: Intent;
  readonly plan: SurvivalPlan;
  readonly facts: WorldFacts;
}

export interface TaskFailure {
  readonly taskId: string;
  readonly stage: GoalId;
  readonly code: string;
  readonly detail: string;
  readonly attempts: number;
}

export interface RecoveryInput {
  readonly plan: SurvivalPlan;
  readonly facts: WorldFacts;
  readonly failure: TaskFailure;
  /** Previously failed signatures for this stage, newest last. */
  readonly history?: readonly TaskFailure[];
}

export interface Recovery {
  readonly task: Task | null;
  readonly reason: string;
  readonly avoid: readonly string[];
  readonly blocked: readonly BlockedTask[];
}

export interface GoalProgress {
  readonly stage: GoalId;
  readonly stageTitle: string;
  readonly milestone: MilestoneResult | null;
  readonly task: Task | null;
  readonly verifiedProgress: number;
  readonly completedMilestones: number;
  readonly totalMilestones: number;
  readonly verified: boolean;
  readonly blocked: readonly BlockedTask[];
}

export interface SurvivalContext {
  /** Current wall clock for deterministic tests. */
  readonly now?: number;
  readonly clock?: { now(): number; newId(): string };
  /** Skills advertised by the connected body. Undefined means "not checked". */
  readonly availableSkills?: readonly string[];
}

export interface ToolRequirementSummary {
  readonly block: string;
  readonly minimumTier: ToolTier;
  readonly item: string | null;
}
