import { evaluateMilestone, nextMilestone, STAGES, stageById } from "./stages.ts";
import { missingForRecipe, nextTaskForStage } from "./tasks.ts";
import { skillCallSchema } from "@craftmate/contracts";
import {
  STAGE_ORDER,
  type BlockedTask,
  type GoalProgress,
  type MilestoneResult,
  type SeasonGoal,
  type Stage,
  type StageResult,
  type SurvivalContext,
  type SurvivalPlan,
  type Task,
  type WorldFacts,
} from "./types.ts";

/**
 * Pure, idempotent planning. The only inputs are the goal, world facts and an
 * injected clock/id source; re-running after a reconnect cannot inherit a
 * hidden task from the previous session.
 */
export function planSurvival(
  facts: WorldFacts,
  goal: SeasonGoal,
  context: SurvivalContext = {},
): SurvivalPlan {
  const now = context.clock?.now() ?? context.now ?? Date.now();
  const newId = context.clock?.newId ?? (() => crypto.randomUUID());
  const stages = buildStages(goal, facts);
  const targetIndex = Math.max(0, STAGE_ORDER.indexOf(goal.target));
  let active: StageResult | null = null;
  for (const stage of stages) {
    if (stage.index > targetIndex) break;
    if (stage.status !== "complete") {
      active = stage;
      break;
    }
  }
  if (active === null) {
    active = stages.find((stage) => stage.index === targetIndex) ?? stages[0] ?? null;
  }
  const stage: Stage = active === null ? FIRST_STAGE : stageById(active.id);
  let built = nextTaskForStage({
    stage: stage.id,
    facts,
    newId,
  });
  const pendingMilestone = nextMilestone(stage, facts);
  if (built !== null && isTask(built) && pendingMilestone !== null) {
    const alignedTitle = taskMilestoneAlignment(built, pendingMilestone.milestone.id);
    if (alignedTitle !== null) built = { ...built, title: alignedTitle };
  }
  const pending = active === null ? null : pendingMilestone;
  const milestone =
    pending === null
      ? null
      : {
          id: pending.milestone.id,
          title: pending.milestone.title,
          status: pending.status,
          condition: pending.milestone.condition,
        };
  const candidate = built !== null && isTask(built) ? built : null;
  const validated = candidate === null ? null : validateTask(candidate, context.availableSkills);
  const blocked: BlockedTask[] = built !== null && !isTask(built) ? [built] : [];
  if (candidate !== null && validated === null) {
    blocked.push({
      stage: candidate.stage,
      kind: candidate.kind,
      title: candidate.title,
      missing: [
        {
          kind: "capability",
          detail: context.availableSkills === undefined
            ? "任务未通过 skillCallSchema 校验"
            : `身体没有声明技能 ${candidate.skill.name}`,
        },
      ],
    });
  }
  const task = validated;
  const completed = stages
    .filter((entry) => entry.index <= targetIndex)
    .reduce(
      (total, entry) => total + entry.milestones.filter((item) => item.status === "complete").length,
      0,
    );
  const total = stages
    .filter((entry) => entry.index <= targetIndex)
    .reduce((sum, entry) => sum + entry.milestones.length, 0);
  const activeStage = active?.id ?? goal.target;
  const missing = blocked.flatMap((entry) => entry.missing);
  return {
    goal,
    stage: activeStage,
    stageTitle: active?.title ?? stage.title,
    stages,
    milestone,
    task,
    blocked,
    missing,
    verifiedProgress: total === 0 ? 0 : completed / total,
    completedMilestones: completed,
    totalMilestones: total,
    recoveredFrom: null,
    evaluatedAt: now,
  };
}

export function nextTask(plan: SurvivalPlan): Task | null {
  return plan.task;
}

export function goalProgress(plan: SurvivalPlan): GoalProgress {
  return {
    stage: plan.stage,
    stageTitle: plan.stageTitle,
    milestone: plan.milestone,
    task: plan.task,
    verifiedProgress: plan.verifiedProgress,
    completedMilestones: plan.completedMilestones,
    totalMilestones: plan.totalMilestones,
    verified: plan.stage !== "dragon" || plan.milestone?.status === "complete",
    blocked: plan.blocked,
  };
}

export function buildStages(goal: SeasonGoal, facts: WorldFacts): readonly StageResult[] {
  const targetIndex = Math.max(0, STAGE_ORDER.indexOf(goal.target));
  const completed = new Set<string>();
  const results: StageResult[] = [];
  for (const stage of STAGES) {
    const milestones: MilestoneResult[] = stage.milestones.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      status: evaluateMilestone(milestone, facts),
      condition: milestone.condition,
    }));
    const allComplete = milestones.every((entry) => entry.status === "complete");
    const prerequisitesMet = stage.requires.every((id) => completed.has(id));
    if (allComplete) completed.add(stage.id);
    if (stage.index > targetIndex) {
      results.push({ ...summarize(stage), status: "pending", milestones });
      continue;
    }
    const status: StageResult["status"] = allComplete
      ? "complete"
      : !prerequisitesMet
        ? "pending"
        : "active";
    results.push({ ...summarize(stage), status, milestones });
  }
  return results;
}

/**
 * A stage with no executable task but known missing dependencies is reported
 * as blocked, not active, so the runtime can pause instead of spinning.
 */
export function applyBlocked(plan: SurvivalPlan): SurvivalPlan {
  if (plan.task !== null || plan.blocked.length === 0) return plan;
  return {
    ...plan,
    stages: plan.stages.map((stage) =>
      stage.id === plan.stage ? { ...stage, status: "blocked" as const } : stage,
    ),
  };
}

function summarize(stage: Stage): Omit<StageResult, "status" | "milestones"> {
  return { id: stage.id, index: stage.index, title: stage.title };
}

const FIRST_STAGE: Stage = STAGES[0] ?? {
  id: "wood-and-table",
  index: 0,
  title: "木头与工作台",
  objective: "",
  requires: [],
  milestones: [],
};

function isTask(value: Task | BlockedTask): value is Task {
  return "skill" in value;
}

function validateTask(task: Task, availableSkills: readonly string[] | undefined): Task | null {
  const parsed = skillCallSchema.safeParse(task.skill);
  if (!parsed.success) return null;
  if (availableSkills !== undefined && !availableSkills.includes(task.skill.name)) return null;
  return task;
}

/**
 * Milestones are cumulative evidence, while a stage can need a prerequisite
 * task (for example a table) before the next milestone advances. Only rename
 * the task; the skill and its preconditions stay untouched.
 */
function taskMilestoneAlignment(task: Task, milestoneId: string): string | null {
  if (milestoneId === "have-crafting-table" && task.skill.name === "craft") return "合成工作台";
  if (milestoneId === "have-planks" && task.skill.name === "craft") return "合成木板";
  if (milestoneId === "have-log" && task.skill.name === "chop_tree") return "砍树并获得原木";
  return null;
}

export { missingForRecipe };
