import {
  type PlanStep,
  type RouteBlacklist,
} from "@craftmate/contracts";
import {
  IRON_SET,
  acceptanceGoal,
  hasItem,
  inventoryCount,
  planMission,
  planSurvival,
  queryRecipe,
  taskSignature,
  worldFactsFromSnapshot,
  type GoalId,
  type MissionDecision,
  type Task,
  type WorldFacts,
} from "../domain/index.ts";
import {
  SurvivalGoalPlanner,
  applyFailureRecovery,
  projectPlan,
  type GoalPlan,
  type GoalPlanner,
  type GoalPlanningInput,
  type GoalTask,
} from "./goal-runtime.ts";
import { PlanCompiler, boundedId, guardsForSkill } from "./plan-compiler.ts";

/**
 * Production planner: one deterministic mission spine compiles the current
 * stage, and the body receives a single continuous job when a sequence can be
 * proven from the current inventory. The model no longer re-ranks every
 * atomic step, which was the source of conflicting planners and idle gaps.
 */
export class MissionGoalPlanner implements GoalPlanner {
  private readonly baseline: GoalPlanner;
  private readonly readRouteBlacklist:
    | ((facts: WorldFacts) => readonly RouteBlacklist[])
    | undefined;

  constructor(
    options: {
      readonly baseline?: GoalPlanner;
      readonly readRouteBlacklist?: (
        facts: WorldFacts,
      ) => readonly RouteBlacklist[];
    } = {},
  ) {
    this.baseline = options.baseline ?? new SurvivalGoalPlanner();
    this.readRouteBlacklist = options.readRouteBlacklist;
  }

  plan(input: GoalPlanningInput): GoalPlan | null {
    const snapshot = input.world as Parameters<
      typeof worldFactsFromSnapshot
    >[0];
    const targetLock = input.progress.targetLock ?? null;
    const routeBlacklist =
      input.routeBlacklist ??
      this.readRouteBlacklist?.(
        worldFactsFromSnapshot(snapshot, { targetLock }),
      );
    const enriched =
      routeBlacklist === undefined ? input : { ...input, routeBlacklist };
    const baseline = this.baseline.plan(enriched);
    if (baseline === null) return baseline;
    const facts = worldFactsFromSnapshot(snapshot, {
      routeBlacklist: routeBlacklist ?? [],
      targetLock,
    });
    const mission = planMission({
      facts,
      goalTitle: input.goal.title,
      stage: baseline.stage.id,
    });
    const acceptance = acceptanceGoal(input.goal.title);
    if (mission.complete && acceptance !== "full") {
      return {
        ...baseline,
        stage: { id: mission.stage, title: mission.title },
        milestone: { id: "acceptance-complete", title: mission.title },
        nextTask: null,
        complete: true,
        verified: true,
        blockedReason: null,
        strategyKey: `strategy:${mission.kind}`,
        cardId: `strategy.${mission.kind}`,
        cardTitle: mission.title,
        cardReason: mission.reason,
        cardStatus: "done",
        cardSwitchReason: mission.reason,
      };
    }

    const sameStage = baseline.stage.id === mission.stage;
    const baselineRank = stageRank(baseline.stage.id);
    const missionRank = stageRank(mission.stage);
    /*
     * A later mission stage must be allowed to pull the body forward when the
     * old DAG's milestone bookkeeping is stale. A safety stage may pull it
     * back, but ordinary night work may not.
     */
    const mayOverride =
      !sameStage &&
      (missionRank > baselineRank ||
        mission.kind === "survive" ||
        mission.kind === "secure-food" ||
        mission.kind === "recover-tool" ||
        mission.kind === "iron-set" ||
        mission.kind === "acquire-station");
    const compiled = mayOverride
      ? this.compileStage(enriched, facts, mission)
      : baseline;
    if (compiled === null) return baseline;
    /*
     * A safety mission names the food stage even when that stage is already
     * complete. Compiling the backward target then produces a valid but empty
     * plan, and the runtime silently re-plans forever without issuing a task.
     * Keep the baseline task and only apply the safety card metadata; the
     * survival layer itself contains the low-health meal and retreat gates.
     */
    if (
      mayOverride &&
      compiled.nextTask === null &&
      baseline.nextTask !== null &&
      (mission.kind === "survive" || mission.kind === "secure-food")
    ) {
      return withCompiledJob(applyMission(baseline, mission), facts);
    }
    const withMission = applyMission(compiled, mission);
    return withCompiledJob(withMission, facts);
  }

  /** The mission spine is synchronous; no per-step model latency. */
  async planAsync(input: GoalPlanningInput): Promise<GoalPlan | null> {
    return this.plan(input);
  }

  private compileStage(
    input: GoalPlanningInput,
    facts: WorldFacts,
    mission: MissionDecision,
  ): GoalPlan | null {
    const goal = {
      id: input.goal.id,
      title: input.goal.title,
      target: mission.stage as GoalId,
      version: input.goal.version,
      lockedByOperator: true,
      setBy: "operator",
      setAt: input.goal.setAt,
    };
    let plan = planSurvival(facts, goal, {
      availableSkills: input.health?.skills ?? [],
      forcedStage: mission.stage as GoalId,
    });
    if (plan.task !== null) {
      plan = {
        ...plan,
        task: stableTask(plan.task),
      };
    }
    const recovery = applyFailureRecovery(plan, input, facts);
    if (recovery.resolved !== null) return recovery.resolved;
    plan = recovery.plan;
    return projectPlan(
      plan,
      facts,
      plan.task,
      plan.task === null
        ? `${mission.title}：${mission.requirements.join("；")}`
        : null,
      plan.blocked,
    );
  }
}

function stableTask(task: Task): Task {
  return { ...task, id: `task:${taskSignature(task)}` };
}

function applyMission(plan: GoalPlan, mission: MissionDecision): GoalPlan {
  return {
    ...plan,
    cardId: `strategy.${mission.kind}`,
    cardTitle: mission.title,
    cardReason: mission.reason,
    cardStatus: mission.complete ? "done" : "available",
    cardSwitchReason: mission.reason,
    cardModelChoice: false,
    cardFallbackReason: null,
  };
}

/**
 * A smelt that produces enough ingots for carried recipes is one job: the
 * furnace work and the following table work should not be separated by an
 * idle replan. Nodes whose non-ingot ingredients are not already present are
 * deliberately omitted; the next observation can compile them safely.
 */
function withCompiledJob(plan: GoalPlan, facts: WorldFacts): GoalPlan {
  const task = plan.nextTask;
  if (task === null || plan.stage.id !== "iron") return plan;
  if (task.skill.name !== "smelt") return plan;
  const output = String(task.skill.args["output"] ?? "");
  if (output !== "minecraft:iron_ingot") return plan;
  const count = Number(task.skill.args["count"] ?? 1);
  if (!Number.isFinite(count) || count < 1) return plan;
  const position = facts.position;
  const rememberedTable = facts.craftingTable;
  const tableInReach =
    (facts.stations ?? []).includes("crafting_table") ||
    facts.craftingTableNearby === true ||
    (position !== undefined &&
      position !== null &&
      rememberedTable !== undefined &&
      rememberedTable !== null &&
      Math.hypot(
        rememberedTable.x - position.x,
        rememberedTable.y - position.y,
        rememberedTable.z - position.z,
      ) <= 4.5);
  const carriedTable = inventoryCount(facts, "minecraft:crafting_table") > 0;
  if (!tableInReach && !carriedTable) return plan;

  let ingots = inventoryCount(facts, "minecraft:iron_ingot") + count;
  let sticks = inventoryCount(facts, "minecraft:stick");
  const steps: PlanStep[] = [];
  if (!tableInReach && carriedTable) {
    // The craft node uses a placed station. A remembered table fifty blocks
    // away made the job fail with "no safe route to the crafting table" while
    // the backpack already held three tables.
    steps.push({
      id: "place-table",
      skill: "place_block",
      args: { block: "minecraft:crafting_table", count: 1 },
      label: "放置工作台",
      guards: [],
      evidence: ["nearbyBlocks contains crafting_table"],
    });
  }
  steps.push({
    id: "smelt-ingots",
    skill: "smelt",
    args: {
      ...task.skill.args,
      count,
    },
    label: "熔炼铁锭",
    guards: [...guardsForSkill("smelt", { ...task.skill.args, count }, facts)],
    evidence: ["inventory gain: minecraft:iron_ingot"],
  });
  for (const gear of IRON_SET) {
    if (hasItem(facts, gear.item) || ingots <= 0) continue;
    const recipe = queryRecipe(gear.item);
    if (recipe === null) continue;
    let affordable = true;
    const needed = recipe.ingredients.map((ingredient) => ({
      ingredient,
      available: ingredient.choices.reduce(
        (best, choice) => Math.max(best, inventoryCount(facts, choice)),
        0,
      ),
    }));
    for (const entry of needed) {
      const ingot = entry.ingredient.choices.includes("minecraft:iron_ingot");
      if (ingot) {
        if (ingots < entry.ingredient.count) affordable = false;
      } else if (
        entry.ingredient.choices.includes("minecraft:stick") &&
        sticks < entry.ingredient.count
      ) {
        affordable = false;
      } else if (!ingot && entry.available < entry.ingredient.count) {
        affordable = false;
      }
    }
    if (!affordable) continue;
    for (const entry of needed) {
      if (entry.ingredient.choices.includes("minecraft:iron_ingot")) {
        ingots -= entry.ingredient.count;
      } else if (entry.ingredient.choices.includes("minecraft:stick")) {
        sticks -= entry.ingredient.count;
      }
    }
    steps.push({
      id: `craft:${gear.item}`,
      skill: "craft",
      args: { item: gear.item, count: 1 },
      label: `制作${gear.item}`,
      guards: [...guardsForSkill("craft", { item: gear.item, count: 1 }, facts)],
      ...(tableInReach ? {} : { targetFamilyId: "station:crafting_table" }),
      evidence: [`inventory gain: ${gear.item}`],
    });
  }
  if (steps.length < 2) return plan;
  const missing = IRON_SET.find((gear) => !hasItem(facts, gear.item))?.item ?? "none";
  const compiler = new PlanCompiler();
  const skill = compiler.compileSequence({
    task,
    facts,
    planId: `iron-set:${missing.replace(/^minecraft:/u, "")}:${count}`,
    entryNodeId: boundedId(task.taskId ?? "task:iron-set", 100),
    goalFamily: "iron-set",
    steps,
    targetFamilies: tableInReach
      ? []
      : [{ id: "station:crafting_table", kind: "station", ids: ["minecraft:crafting_table"] }],
    expectedEvidence: steps.flatMap((step) => step.evidence),
    maxDurationSeconds: 180,
    worldVersion: facts.worldVersion ?? null,
  });
  const nextTask: GoalTask = {
    ...task,
    text: "连续熔炼并制作铁套",
    reason: "材料与工作台已具备，用一个受守卫计划完成熔炼和后续制作，避免节点之间空闲重排",
    skill,
  };
  return { ...plan, nextTask, strategyKey: `strategy:iron-job:${missing}` };
}

function stageRank(stage: string): number {
  const order = [
    "wood-and-table",
    "stone-tools",
    "food",
    "shelter",
    "iron",
    "diamond-gear",
    "nether",
    "eyes",
    "stronghold",
    "dragon",
  ];
  const rank = order.indexOf(stage);
  return rank < 0 ? 0 : rank;
}
