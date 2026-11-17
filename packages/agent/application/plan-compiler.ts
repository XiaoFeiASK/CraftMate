import {
  runPlanSchema,
  type PlanGuard,
  type PlanStep,
  type PlanTargetFamily,
  type SkillCall,
} from "@craftmate/contracts";
import {
  inventoryCount,
  queryRecipe,
  type WorldFacts,
} from "../domain/index.ts";
import type { GoalTask } from "./goal-runtime.ts";

export interface PlanCompilerInput {
  readonly task: GoalTask;
  readonly facts: WorldFacts;
  readonly planId: string;
  readonly entryNodeId: string;
  readonly goalFamily: string;
  readonly worldVersion?: string | null;
  readonly checkpointIndex?: number;
  readonly steps?: readonly PlanStep[];
  readonly targetFamilies?: readonly PlanTargetFamily[];
  readonly expectedEvidence?: readonly string[];
  readonly maxDurationSeconds?: number;
}

/**
 * Compiles a task or a proven short sequence into the only body macro skill.
 * The compiler owns typed guards and evidence names; the model never writes a
 * predicate and never chooses a body target instance.
 */
export class PlanCompiler {
  compile(input: PlanCompilerInput): SkillCall {
    if (input.task.skill.name === "run_plan") return input.task.skill;
    const steps =
      input.steps !== undefined && input.steps.length > 0
        ? [...input.steps]
        : [this.stepFor(input.task, input.facts)];
    return this.compileSequence({
      ...input,
      steps,
      targetFamilies:
        input.targetFamilies ?? this.familiesFor(steps, input.facts),
      expectedEvidence:
        input.expectedEvidence ?? steps.flatMap((step) => step.evidence).slice(0, 16),
    });
  }

  compileSequence(
    input: PlanCompilerInput & {
      readonly steps: readonly PlanStep[];
      readonly targetFamilies: readonly PlanTargetFamily[];
    },
  ): SkillCall {
    /*
     * Acquisition steps name the station family they need before that station
     * exists (for example craft an iron pickaxe at the table placed earlier
     * in the same plan), so the caller cannot list every family up front.
     * Referencing an undeclared family fails `run_plan` contract validation
     * and turned the live iron job into sixteen rejected plans. Add the
     * family the step actually names instead of emitting a plan the body must
     * reject.
     */
    const families = new Map(
      input.targetFamilies.map((family) => [family.id, family]),
    );
    const steps = input.steps.map((step) => {
      const id = step.targetFamilyId;
      if (id === undefined || families.has(id)) return step;
      if (id === "station:crafting_table") {
        families.set(id, {
          id,
          kind: "station",
          ids: ["minecraft:crafting_table"],
          maxDistance: 16,
        });
        return step;
      }
      // An id with no derivable family cannot be authorized. The step's own
      // guards still prove reachability, and the body may choose the concrete
      // block, so keep the step but drop the dangling reference.
      const { targetFamilyId: _dropped, ...rest } = step;
      return rest;
    });
    const plan = runPlanSchema.parse({
      planId: input.planId,
      title: input.task.text,
      entryNodeId: input.entryNodeId,
      goalFamily: input.goalFamily,
      targetFamilies: [...families.values()],
      steps,
      maxDurationSeconds: input.maxDurationSeconds ?? 180,
      ...(input.checkpointIndex === undefined
        ? {}
        : { checkpointIndex: input.checkpointIndex }),
      stopOnFailure: true,
      expectedEvidence: [...(input.expectedEvidence ?? [])],
      ...(input.worldVersion === undefined || input.worldVersion === null
        ? {}
        : { worldVersion: input.worldVersion }),
    });
    return {
      name: "run_plan",
      args: plan,
      /*
       * A plan owns its own 180-second budget. Without an explicit command
       * deadline the bridge falls back to thirty seconds, which expired while
       * the plan was still loading a furnace or cooking an eight-item batch:
       * the live iron chestplate job died one second after the furnace was
       * placed. Keep the transport deadline above the body budget so a queued
       * plan is never killed before its own checkpoint/timeout policy runs.
       */
      deadlineTicks: ((input.maxDurationSeconds ?? 180) + 60) * 20,
      idempotencyKey: `strategy:run_plan:${plan.planId}:${plan.steps.length}:${plan.entryNodeId}`,
    };
  }

  stepFor(task: GoalTask, facts: WorldFacts): PlanStep {
    const family = familyForSkill(task.skill.name, task.skill.args);
    return {
      id: boundedId(`step:${task.taskId ?? task.skill.name}`, 100),
      skill: task.skill.name,
      args: task.skill.args,
      label: task.text,
      guards: [...guardsForSkill(task.skill.name, task.skill.args, facts, family?.id)],
      ...(family === null ? {} : { targetFamilyId: family.id }),
      evidence: [...evidenceForSkill(task.skill.name, task.skill.args)],
    };
  }

  familiesFor(
    steps: readonly PlanStep[],
    facts: WorldFacts,
  ): readonly PlanTargetFamily[] {
    const families = new Map<string, PlanTargetFamily>();
    for (const step of steps) {
      const family = familyForSkill(step.skill, step.args);
      if (family !== null) families.set(family.id, family);
      if (step.skill === "craft") {
        const recipe = queryRecipe(String(step.args["item"] ?? ""));
        if (recipe?.station === "crafting_table") {
          families.set("station:crafting_table", {
            id: "station:crafting_table",
            kind: "station",
            ids: ["minecraft:crafting_table"],
            maxDistance: 16,
          });
        }
      }
    }
    return [...families.values()].slice(0, 8);
  }
}

export function guardsForSkill(
  skill: SkillCall["name"],
  args: Record<string, unknown>,
  facts: WorldFacts,
  targetFamilyId?: string,
): readonly PlanGuard[] {
  const guards: PlanGuard[] = [];
  if (targetFamilyId !== undefined) {
    guards.push({ type: "target_family", family: targetFamilyId, state: "visible", min: 1 });
  }
  if (skill === "craft") {
    const item = String(args["item"] ?? "");
    const recipe = queryRecipe(item);
    if (recipe !== null) {
      const station =
        recipe.station === "crafting_table"
          ? { type: "station" as const, block: "minecraft:crafting_table", reachable: true }
          : null;
      if (station !== null) guards.push(station);
      for (const ingredient of recipe.ingredients) {
        const available = ingredient.choices.reduce(
          (best, choice) => Math.max(best, inventoryCount(facts, choice)),
          0,
        );
        if (available >= ingredient.count) {
          const best = ingredient.choices
            .slice()
            .sort((left, right) => inventoryCount(facts, right) - inventoryCount(facts, left))[0];
          if (best !== undefined) {
            guards.push({
              type: "inventory",
              item: best,
              min: ingredient.count,
            });
          }
        }
      }
    }
  }
  if (skill === "smelt") {
    guards.push({
      type: "inventory",
      item: String(args["input"] ?? ""),
      min: Number(args["count"] ?? 1),
    });
    guards.push({ type: "station", block: "minecraft:furnace", reachable: true });
  }
  if (skill === "mine_block") {
    guards.push({ type: "health", min: 8 });
    guards.push({ type: "food", min: 6 });
  }
  return guards.slice(0, 8);
}

export function familyForSkill(
  skill: SkillCall["name"],
  args: Record<string, unknown>,
): PlanTargetFamily | null {
  if (skill === "mine_block") {
    const block = String(args["block"] ?? "");
    if (block === "") return null;
    return {
      id: `block:${familyKey(block)}`,
      kind: "block",
      ids: [...oreVariants(block)],
      maxDistance: 48,
    };
  }
  if (skill === "chop_tree") {
    return {
      id: "block:logs",
      kind: "block",
      ids: [
        "minecraft:oak_log",
        "minecraft:birch_log",
        "minecraft:spruce_log",
        "minecraft:jungle_log",
        "minecraft:acacia_log",
        "minecraft:dark_oak_log",
        "minecraft:mangrove_log",
        "minecraft:cherry_log",
      ],
      maxDistance: 48,
    };
  }
  if (skill === "attack") {
    const targets = [
      String(args["target"] ?? ""),
      ...((args["targets"] as readonly unknown[] | undefined) ?? []).map(String),
    ].filter((target) => target !== "");
    if (targets.length === 0) return null;
    return { id: `entity:${targets[0]}`, kind: "entity", ids: targets, maxDistance: 32 };
  }
  return null;
}

function evidenceForSkill(
  skill: SkillCall["name"],
  args: Record<string, unknown>,
): readonly string[] {
  switch (skill) {
    case "mine_block":
      return [`block broken: ${String(args["block"] ?? "target")}`, "inventory gain observed"];
    case "craft":
      return [`inventory gain: ${String(args["item"] ?? "item")}`];
    case "smelt":
      return [`inventory gain: ${String(args["output"] ?? "output")}`];
    case "attack":
      return ["target lock", "kill or hit observed"];
    case "collect_items":
      return ["inventory gain observed"];
    default:
      return ["completed with body evidence"];
  }
}

function oreVariants(block: string): readonly string[] {
  const id = block.includes(":") ? block : `minecraft:${block}`;
  if (id.endsWith("_ore") && !id.includes("deepslate_")) {
    const short = id.slice("minecraft:".length);
    return [id, `minecraft:deepslate_${short}`];
  }
  return [id];
}

function familyKey(block: string): string {
  const id = block.includes(":") ? block : `minecraft:${block}`;
  return id.replace(/^minecraft:/u, "").replace(/^deepslate_/u, "");
}

/** Contract ids are opaque labels, so a long task identity is truncated. */
export function boundedId(id: string, max: number): string {
  return id.length <= max ? id : id.slice(0, max);
}
