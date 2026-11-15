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
  "chop_tree",
  "collect_items",
  "craft",
  "equip",
  "eat",
  "deposit",
  "place_block",
  "pillar_up",
  "smelt",
  "attack",
  "use_block",
  "sleep",
  "say",
  "emote",
  "wait",
  "run_job",
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
 * One node in a body-owned job. The body executes these sequentially without
 * returning to the idle planner between nodes, which removes the visible
 * stop/start between related actions while keeping every node an ordinary
 * skill with the same validation and evidence rules.
 */
export const jobNodeSchema = z.object({
  skill: skillNameSchema,
  args: z.record(z.unknown()),
  /** Optional operator-facing label; the body falls back to the skill name. */
  label: z.string().trim().min(1).max(80).optional(),
});
export type JobNode = z.infer<typeof jobNodeSchema>;

/**
 * A bounded macro plan. `jobId` is stable across a replan so the body can
 * reject a resume against a different mission. `checkpointIndex` is advisory:
 * the body still re-validates every node precondition before executing it.
 */
export const jobPlanSchema = z.object({
  jobId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(120),
  nodes: z.array(jobNodeSchema).min(1).max(32),
  checkpointIndex: z.number().int().nonnegative().optional(),
  /** A failed node aborts the job unless the caller explicitly opts out. */
  stopOnFailure: z.boolean().default(true),
});
export type JobPlan = z.infer<typeof jobPlanSchema>;

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
       * Stop after this many inventory stacks instead of emptying every
       * matching stack. A full backpack needs one free slot, not a chest
       * transfer that also removes the tool-building reserve.
       */
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
    name: z.literal("run_job"),
    args: jobPlanSchema,
  }),
]);
export type SkillArgs = z.infer<typeof skillArgsSchema>;

/** Returns the parsed arguments or `null`; never throws at the call site. */
export function parseSkillArgs(name: SkillName, args: unknown): SkillArgs | null {
  const parsed = skillArgsSchema.safeParse({ name, args });
  if (!parsed.success) return null;
  if (parsed.data.name !== "run_job") return parsed.data;
  // The wire keeps nested args open so an older body can reject a newer
  // skill itself. The producer still validates every child before dispatch;
  // a job may not recursively contain another job.
  for (const node of parsed.data.args.nodes) {
    if (node.skill === "run_job") return null;
    if (skillArgsSchema.safeParse({ name: node.skill, args: node.args }).success === false) {
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
    const parsed = skillArgsSchema.safeParse({ name: call.name, args: call.args });
    if (!parsed.success) {
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
  chop_tree: "mine",
  collect_items: "container",
  craft: "container",
  equip: "use",
  eat: "use",
  deposit: "container",
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
   * A job is a body-owned sequencer, not a new game capability. The body
   * re-checks each child skill against its own advertised catalogue.
   */
  run_job: "sensor",
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
  "chop_tree",
  "collect_items",
  "craft",
  "deposit",
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
  "run_job",
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
