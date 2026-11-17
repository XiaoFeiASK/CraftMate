import { z } from "zod";
import type { BridgeCapability } from "./bridge.ts";

/**
 * Per-skill arguments. The bridge ships `args` as an open record on the wire,
 * so every producer validates against this registry before serialising. That
 * keeps one definition of "a valid goto" instead of one per caller.
 */
export const skillNameSchema = z.enum([
  "goto",
  "follow",
  "flee",
  "look_at",
  "mine_block",
  "mine_tunnel",
  "chop_tree",
  "collect_items",
  "craft",
  "equip",
  "eat",
  "deposit",
  "withdraw",
  "place_block",
  "pillar_up",
  "smelt",
  "attack",
  "use_block",
  "sleep",
  "say",
  "emote",
  "wait",
  "run_plan",
]);
export type SkillName = z.infer<typeof skillNameSchema>;

const blockId = z.string().trim().min(1).max(120);
const itemId = z.string().trim().min(1).max(120);
const playerName = z.string().trim().min(1).max(32);
const point = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

/**
 * A body may choose a concrete instance only inside a family the Agent
 * approved. Families are data, never callbacks, so a plan cannot smuggle an
 * arbitrary predicate onto the body.
 */
export const planTargetFamilySchema = z.object({
  id: z.string().trim().min(1).max(80),
  kind: z.enum(["block", "entity", "station", "item"]),
  ids: z.array(z.string().trim().min(1).max(120)).min(1).max(64),
  dimension: z.string().trim().min(1).max(120).optional(),
  maxDistance: z.number().min(1).max(64).optional(),
});
export type PlanTargetFamily = z.infer<typeof planTargetFamilySchema>;

function guardDepth(guard: PlanGuard): number {
  return guard.type === "all" || guard.type === "or"
    ? 1 + Math.max(0, ...guard.guards.map(guardDepth))
    : 1;
}

/**
 * Guard whitelist. The body evaluates these directly; no expression language,
 * script, or model-authored predicate is accepted.
 */
export type PlanGuard =
  | { readonly type: "inventory"; readonly item: string; readonly min?: number | undefined; readonly max?: number | undefined }
  | { readonly type: "target_family"; readonly family: string; readonly state: "observed" | "visible" | "reachable"; readonly min?: number | undefined }
  | { readonly type: "station"; readonly block: string; readonly reachable: boolean }
  | { readonly type: "dimension"; readonly id: string }
  | { readonly type: "health"; readonly min?: number | undefined; readonly max?: number | undefined }
  | { readonly type: "food"; readonly min?: number | undefined; readonly max?: number | undefined }
  | { readonly type: "time"; readonly phase: "day" | "night" }
  | { readonly type: "world_version"; readonly equals?: string | undefined; readonly changed?: boolean | undefined }
  | { readonly type: "all"; readonly guards: readonly PlanGuard[] }
  | { readonly type: "or"; readonly guards: readonly PlanGuard[] };

export const planGuardSchema = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("inventory"),
      item: z.string().trim().min(1).max(120),
      min: z.number().int().nonnegative().optional(),
      max: z.number().int().nonnegative().optional(),
    }),
    z.object({
      type: z.literal("target_family"),
      family: z.string().trim().min(1).max(80),
      state: z.enum(["observed", "visible", "reachable"]),
      min: z.number().int().min(1).max(64).default(1),
    }),
    z.object({
      type: z.literal("station"),
      block: z.string().trim().min(1).max(120),
      reachable: z.boolean().default(true),
    }),
    z.object({
      type: z.literal("dimension"),
      id: z.string().trim().min(1).max(120),
    }),
    z.object({
      type: z.literal("health"),
      min: z.number().min(0).max(20).optional(),
      max: z.number().min(0).max(20).optional(),
    }),
    z.object({
      type: z.literal("food"),
      min: z.number().int().min(0).max(20).optional(),
      max: z.number().int().min(0).max(20).optional(),
    }),
    z.object({
      type: z.literal("time"),
      phase: z.enum(["day", "night"]),
    }),
    z.object({
      type: z.literal("world_version"),
      equals: z.string().trim().min(1).max(80).optional(),
      changed: z.boolean().optional(),
    }),
    z.object({
      type: z.literal("all"),
      guards: z.array(planGuardSchema).min(1).max(8),
    }),
    z.object({
      type: z.literal("or"),
      guards: z.array(planGuardSchema).min(1).max(8),
    }),
  ]),
).superRefine((guard, context) => {
  if (guardDepth(guard) > 3) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "guard nesting exceeds 3 levels",
    });
  }
}) as z.ZodType<PlanGuard>;

export const planStepSchema = z.object({
  id: z.string().trim().min(1).max(100),
  /** The body executes ordinary atomic skills; a plan cannot nest plans. */
  skill: skillNameSchema,
  args: z.record(z.unknown()),
  label: z.string().trim().min(1).max(80).optional(),
  /** Re-evaluated immediately before this step starts. */
  guards: z.array(planGuardSchema).max(8).default([]),
  /** The body may pick a concrete instance inside this pre-approved family. */
  targetFamilyId: z.string().trim().min(1).max(80).optional(),
  /** Evidence the body must report before the step may be considered done. */
  evidence: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
});
export type PlanStep = z.infer<typeof planStepSchema>;

/**
 * A bounded continuable plan. `planId` is stable across a replan so the body
 * can reject a resume against a different mission. No nested plan exists; the
 * body returns to the Agent at every guard boundary.
 */
export const runPlanSchema = z.object({
  planId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(120),
  /** The task-tree node that produced this plan. */
  entryNodeId: z.string().trim().min(1).max(100),
  goalFamily: z.string().trim().min(1).max(120),
  targetFamilies: z.array(planTargetFamilySchema).max(8).default([]),
  steps: z.array(planStepSchema).min(1).max(32),
  maxDurationSeconds: z.number().int().min(1).max(180).default(180),
  checkpointIndex: z.number().int().nonnegative().max(32).optional(),
  stopOnFailure: z.boolean().default(true),
  expectedEvidence: z.array(z.string().trim().min(1).max(120)).max(16).default([]),
  /** The observation this plan was compiled against. */
  worldVersion: z.string().trim().min(1).max(80).optional(),
});
export type RunPlan = z.infer<typeof runPlanSchema>;

export const skillArgsSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("goto"),
    args: z.object({
      target: point,
      /**
       * Walking is non-destructive by default. `dig` and `recover` are
       * explicit planner escalations; a failed walk must never enter either.
       */
      mode: z.enum(["walk", "dig", "recover"]).optional(),
      /**
       * Fallback destinations in preference order. Exploration uses this to
       * avoid failing just because its first heading ends in water or a cliff;
       * ordinary movement still gives one exact target.
       */
      candidates: z.array(point).min(1).max(8).optional(),
      /**
       * Exploration only: reaching the end of a proven safe partial route is
       * real progress (a new observation area) even though the requested
       * column was not reached. Ordinary movement must stay exact.
       */
      acceptPartial: z.boolean().optional(),
      /**
       * Safety-critical movement chosen by the planner (retreat or escape).
       * The body's threat reflex must not cancel the action that is already
       * answering the danger.
       */
      emergency: z.boolean().optional(),
      /**
       * Horizontal arrival tolerance in blocks. Omitted keeps the historic
       * one-cell window; use 2-4 for a structure entrance or a shoreline
       * where the exact cell may be occupied.
       */
      radius: z.number().int().min(1).max(8).optional(),
    }),
  }),
  z.object({ name: z.literal("follow"), args: z.object({ player: playerName }) }),
  z.object({ name: z.literal("flee"), args: z.object({ player: playerName.optional() }) }),
  z.object({
    name: z.literal("look_at"),
    args: z.union([z.object({ target: point }), z.object({ player: playerName })]),
  }),
  z.object({
    name: z.literal("mine_block"),
    args: z.object({
      block: blockId,
      count: z.number().int().min(1).max(64).default(1),
      /**
       * Exact blueprint/mine cell. Omitted for ordinary "mine the nearest
       * matching block" work; a fixed cell never falls back to a broad scan.
       */
      at: point.optional(),
      /**
       * Blueprint excavation (a staircase or rescue tunnel) is complete once
       * the named cell is air. Ordinary resource mining still waits for the
       * drop; a staircase drop can fall into the pit it just opened.
       */
      requireDrop: z.boolean().optional(),
    }),
  }),
  z.object({
    name: z.literal("mine_tunnel"),
    args: z.object({
      /**
       * Omit to continue a horizontal branch at the body's current Y. A
       * lower value cuts a reusable staircase down to that layer.
       */
      targetY: z.number().int().min(-60).max(320).optional(),
      /**
       * Fresh branch cells to open after reaching targetY. Bounded to keep a
       * single body action under the orchestrator's watchdog window.
       */
      length: z.number().int().min(0).max(8).default(4),
      direction: z.enum(["north", "south", "east", "west"]).optional(),
      rememberMine: z.boolean().optional(),
    }),
  }),
  z.object({ name: z.literal("chop_tree"), args: z.object({ count: z.number().int().min(1).max(16).default(1) }) }),
  z.object({
    name: z.literal("collect_items"),
    args: z.object({ item: itemId.optional(), count: z.number().int().min(1).max(64).default(1) }),
  }),
  z.object({ name: z.literal("craft"), args: z.object({ item: itemId, count: z.number().int().min(1).max(64).default(1) }) }),
  z.object({ name: z.literal("equip"), args: z.object({ item: itemId }) }),
  z.object({ name: z.literal("eat"), args: z.object({ item: itemId.optional() }) }),
  z.object({
    name: z.literal("deposit"),
    args: z.object({
      container: point.optional(),
      item: itemId.optional(),
      /**
       * Batch several overflow types into one chest visit. A single `item`
       * stays supported for older plans.
       */
      items: z.array(itemId).min(1).max(8).optional(),
      /**
       * Stop after this many inventory stacks instead of emptying every
       * matching stack. A full backpack needs one free slot, not a chest
       * transfer that also removes the tool-building reserve.
       */
      maxStacks: z.number().int().min(1).max(36).optional(),
    }),
  }),
  z.object({
    name: z.literal("withdraw"),
    args: z.object({
      container: point.optional(),
      items: z.array(itemId).min(1).max(8).optional(),
      /** Coarse groups avoid guessing the wood species stored in a chest. */
      category: z.enum(["wood"]).optional(),
      maxStacks: z.number().int().min(1).max(36).optional(),
    }),
  }),
  z.object({
    name: z.literal("place_block"),
    args: z.object({
      block: blockId,
      count: z.number().int().min(1).max(64).default(1),
      /** Exact cell for a fixed camp fixture; omitted for adjacent placement. */
      at: point.optional(),
    }),
  }),
  z.object({
    name: z.literal("pillar_up"),
    args: z.object({
      block: blockId.optional(),
      height: z.number().int().min(1).max(16).default(3),
    }),
  }),
  z.object({
    name: z.literal("smelt"),
    args: z.object({
      input: itemId,
      output: itemId,
      count: z.number().int().min(1).max(64).default(1),
      fuel: itemId.optional(),
    }),
  }),
  z.object({
    name: z.literal("attack"),
    args: z.object({
      target: z.string().trim().min(1).max(64),
      /** Alternative entity IDs accepted by the same hunt. */
      targets: z.array(z.string().trim().min(1).max(64)).min(1).max(8).optional(),
      count: z.number().int().min(1).max(16).optional(),
      /** Search radius; the body still proves each hit and approach. */
      radius: z.number().min(1).max(48).optional(),
      /** Finish when this target dies, instead of requiring a fixed hit count. */
      lethal: z.boolean().optional(),
      /** Collect the kill's drops before reporting success. */
      collect: z.boolean().optional(),
    }),
  }),
  z.object({ name: z.literal("use_block"), args: z.object({ block: blockId.optional() }) }),
  z.object({ name: z.literal("sleep"), args: z.object({}).strict() }),
  z.object({ name: z.literal("say"), args: z.object({ text: z.string().trim().min(1).max(280) }) }),
  z.object({ name: z.literal("emote"), args: z.object({ name: z.string().trim().min(1).max(40) }) }),
  z.object({ name: z.literal("wait"), args: z.object({ ticks: z.number().int().min(1).max(20 * 60) }) }),
  z.object({
    name: z.literal("run_plan"),
    args: runPlanSchema,
  }),
]);
export type SkillArgs = z.infer<typeof skillArgsSchema>;

/** Returns the parsed arguments or `null`; never throws at the call site. */
export function parseSkillArgs(name: SkillName, args: unknown): SkillArgs | null {
  const parsed = skillArgsSchema.safeParse({ name, args });
  if (!parsed.success) return null;
  if (parsed.data.name !== "run_plan") return parsed.data;
  // The wire keeps nested args open so an older body can reject a newer
  // skill itself. The producer still validates every step before dispatch;
  // a plan may not recursively contain another plan.
  const familyIds = new Set(parsed.data.args.targetFamilies.map((family) => family.id));
  for (const step of parsed.data.args.steps) {
    if (step.skill === "run_plan") return null;
    if (step.targetFamilyId !== undefined && !familyIds.has(step.targetFamilyId)) {
      return null;
    }
    if (skillArgsSchema.safeParse({ name: step.skill, args: step.args }).success === false) {
      return null;
    }
  }
  return parsed.data;
}

/**
 * A concrete invocation. `args` stays a record on the wire so a newer body can
 * accept skills this orchestrator does not know yet; producers go through
 * `parseSkillArgs` first.
 */
export const skillCallSchema = z
  .object({
    name: skillNameSchema,
    args: z.record(z.unknown()),
    deadlineTicks: z.number().int().positive().optional(),
    idempotencyKey: z.string().min(1),
  })
  .superRefine((call, context) => {
    const parsed = parseSkillArgs(call.name, call.args);
    if (parsed === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["args"],
        message: `invalid args for ${call.name}`,
      });
    }
  });
export type SkillCall = z.infer<typeof skillCallSchema>;

/** Skill a body must advertise for each operation, checked at `hello`. */
export const SKILL_CAPABILITY: Readonly<Record<SkillName, string>> = {
  goto: "move",
  follow: "move",
  flee: "move",
  look_at: "camera",
  mine_block: "mine",
  mine_tunnel: "mine",
  chop_tree: "mine",
  collect_items: "container",
  craft: "container",
  equip: "use",
  eat: "use",
  deposit: "container",
  withdraw: "container",
  place_block: "build",
  pillar_up: "build",
  smelt: "use",
  attack: "attack",
  use_block: "use",
  sleep: "use",
  say: "hud",
  emote: "hud",
  wait: "sensor",
  /**
   * A plan is a body-owned sequencer, not a new game capability. The body
   * re-checks each child skill against its own advertised catalogue.
   */
  run_plan: "sensor",
};

/**
 * The contract is the future catalogue; this is the catalogue that the current
 * Fabric body can execute. Keep it aligned with GameActions so UI, planning and
 * documentation cannot describe unimplemented skills as product capabilities.
 */
export const FABRIC_BODY_SKILLS = [
  "goto",
  "look_at",
  "mine_block",
  "mine_tunnel",
  "chop_tree",
  "collect_items",
  "craft",
  "deposit",
  "withdraw",
  "say",
  "wait",
  "attack",
  "equip",
  "eat",
  "use_block",
  "place_block",
  "pillar_up",
  "smelt",
  "sleep",
  "run_plan",
] as const satisfies readonly SkillName[];

export const FABRIC_BODY_CAPABILITIES = [
  "sensor",
  "move",
  "mine",
  "container",
  "attack",
  "use",
  "build",
  "camera",
  "hud",
] as const satisfies readonly BridgeCapability[];

const REQUIRED_FABRIC_CAPABILITIES = FABRIC_BODY_SKILLS.map(
  (skill) => SKILL_CAPABILITY[skill] as BridgeCapability,
);

const fabricCapabilities: readonly BridgeCapability[] = FABRIC_BODY_CAPABILITIES;
if (REQUIRED_FABRIC_CAPABILITIES.some((capability) => !fabricCapabilities.includes(capability))) {
  throw new Error("Fabric body capability catalogue is inconsistent with its skill catalogue");
}
