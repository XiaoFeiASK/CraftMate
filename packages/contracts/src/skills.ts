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
  "build_schematic",
  "attack",
  "use_block",
  "sleep",
  "say",
  "emote",
  "wait",
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

export const skillArgsSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("goto"), args: z.object({ target: point }) }),
  z.object({ name: z.literal("follow"), args: z.object({ player: playerName }) }),
  z.object({ name: z.literal("flee"), args: z.object({ player: playerName.optional() }) }),
  z.object({
    name: z.literal("look_at"),
    args: z.union([z.object({ target: point }), z.object({ player: playerName })]),
  }),
  z.object({
    name: z.literal("mine_block"),
    args: z.object({ block: blockId, count: z.number().int().min(1).max(64).default(1) }),
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
    args: z.object({ container: point.optional(), item: itemId.optional() }),
  }),
  z.object({
    name: z.literal("place_block"),
    args: z.object({ block: blockId, count: z.number().int().min(1).max(64).default(1) }),
  }),
  z.object({ name: z.literal("build_schematic"), args: z.object({ schematic: z.string().trim().min(1).max(120) }) }),
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
]);
export type SkillArgs = z.infer<typeof skillArgsSchema>;

/** Returns the parsed arguments or `null`; never throws at the call site. */
export function parseSkillArgs(name: SkillName, args: unknown): SkillArgs | null {
  const parsed = skillArgsSchema.safeParse({ name, args });
  return parsed.success ? parsed.data : null;
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
  build_schematic: "build",
  attack: "attack",
  use_block: "use",
  sleep: "use",
  say: "hud",
  emote: "hud",
  wait: "sensor",
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
  "sleep",
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
