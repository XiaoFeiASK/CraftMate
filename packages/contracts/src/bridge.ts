import { z } from "zod";
import { prioritySchema, skillNameSchema } from "./decision.ts";
import { skillOutcomeSchema } from "./outcome.ts";

export { skillNameSchema, type SkillName } from "./decision.ts";

/** Wire version. Bump only with a migration path on both sides. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/**
 * Capabilities are semantic, never Minecraft class names. The orchestrator
 * only schedules skills whose capability is advertised by the connected body.
 */
export const bridgeCapabilitySchema = z.enum([
  "sensor",
  "move",
  "mine",
  "build",
  "attack",
  "use",
  "container",
  "camera",
  "hud",
  "voice",
]);
export type BridgeCapability = z.infer<typeof bridgeCapabilitySchema>;

export const ownershipSchema = z.enum(["agent", "operator", "none"]);
export type Ownership = z.infer<typeof ownershipSchema>;

export const skillCommandSchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  type: z.literal("cmd"),
  id: z.string().min(1),
  /** Links the side effect to the decision that authorised it. */
  decisionId: z.string().min(1).optional(),
  op: skillNameSchema,
  args: z.record(z.unknown()),
  deadlineTick: z.number().int().optional(),
  priority: prioritySchema,
  idempotencyKey: z.string().min(1),
});
export type SkillCommand = z.infer<typeof skillCommandSchema>;

export const worldEventSchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  type: z.literal("event"),
  seq: z.number().int(),
  tick: z.number().int().nonnegative(),
  name: z.string().min(1),
  data: z.record(z.unknown()),
});
export type WorldEvent = z.infer<typeof worldEventSchema>;

/**
 * Semantic state sent with the body heartbeat. The planner uses this
 * observation to choose actions that are possible in the current world.
 */
export const worldSnapshotSchema = z.object({
  inWorld: z.boolean(),
  world: z.string().max(160).nullable().optional(),
  position: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  }).nullable().optional(),
  yaw: z.number().nullable().optional(),
  pitch: z.number().nullable().optional(),
  /**
   * The audience-facing camera can be deliberately decoupled from the
   * player's interaction rotation. These values describe what viewers see.
   */
  cameraYaw: z.number().nullable().optional(),
  cameraPitch: z.number().nullable().optional(),
  health: z.number().nonnegative().nullable().optional(),
  food: z.number().int().nonnegative().nullable().optional(),
  /**
   * Physical state at the same instant as `position`. The body reports these
   * so a planner can distinguish a real fall from a stale client value, and
   * so acceptance runs can prove whether the feet are supported.
   */
  onGround: z.boolean().nullable().optional(),
  fallDistance: z.number().nonnegative().nullable().optional(),
  verticalVelocity: z.number().nullable().optional(),
  /** A screen the player opened; the agent must pause instead of closing it. */
  screenOpen: z.boolean().nullable().optional(),
  floor: z.string().max(160).nullable().optional(),
  /** World spawn; available to future goal-directed navigation. */
  spawn: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  }).nullable().optional(),
  selectedItem: z.string().max(160).nullable().optional(),
  hotbar: z.array(z.object({
    slot: z.number().int().min(0).max(8),
    item: z.string().max(160),
    count: z.number().int().positive(),
  })).max(9).optional(),
  entities: z.array(z.object({
    name: z.string().max(160),
    type: z.string().max(160),
    distance: z.number().nonnegative(),
  })).max(16).optional(),
  nearbyBlocks: z.array(z.object({
    id: z.string().min(1).max(160),
    count: z.number().int().positive().optional(),
  })).max(32).optional(),
});
export type WorldSnapshot = z.infer<typeof worldSnapshotSchema>;

/**
 * Body-observed danger that outranks any queued skill. These are facts about
 * the player, not decisions: the body reports one when it is about to take
 * damage and the orchestrator decides what to cancel. A new kind may be added
 * without a protocol bump because the wire carries a plain string.
 */
export const reflexEventSchema = z.object({
  kind: z.enum([
    "lava",
    "low_health",
    "falling",
    "drowning",
    "on_fire",
    "starving",
    "creeper",
  ]),
  /** One sentence an operator or model can read without knowing the body. */
  detail: z.string().min(1).max(240),
  /** Player health after the observation, so the console can show severity. */
  health: z.number().nonnegative().optional(),
});
export type ReflexEvent = z.infer<typeof reflexEventSchema>;

export { skillOutcomeSchema, type SkillOutcome } from "./outcome.ts";

/**
 * Event names the body may publish over the existing `event` frame. Unknown
 * names stay valid on purpose: an older orchestrator must ignore a newer
 * body's events instead of dropping the connection.
 */
export const REFLEX_EVENT_NAME = "reflex" as const;

export const actionStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "preempted",
  "cancelled",
  "failed",
  "timeout",
]);
export type ActionStatus = z.infer<typeof actionStatusSchema>;

export const bridgeErrorCodeSchema = z.enum([
  "E_SCHEMA",
  "E_UNKNOWN_OP",
  "E_PRECONDITION",
  "E_BUSY",
  "E_TIMEOUT",
  "E_CANCELLED",
  "E_WORLD_CHANGED",
  "E_PERMISSION",
  "E_INTERNAL",
]);
export type BridgeErrorCode = z.infer<typeof bridgeErrorCodeSchema>;

/**
 * Client (headless sim or Minecraft mod) → orchestrator.
 *
 * `hello` must come first. The orchestrator compares capabilities with the
 * token before accepting any command, so a body can never be asked to perform
 * a skill it did not advertise.
 */
export const bridgeClientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("hello"),
    token: z.string().min(1),
    client: z.string().min(1),
    capabilities: z.array(bridgeCapabilitySchema).min(1),
    skills: z.array(skillNameSchema).min(1),
  }),
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("ack"),
    id: z.string().min(1),
    accepted: z.boolean(),
    taskId: z.string().min(1).optional(),
    code: bridgeErrorCodeSchema.optional(),
    detail: z.string().optional(),
  }),
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("progress"),
    taskId: z.string().min(1),
    phase: z.string().min(1),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().optional(),
    tick: z.number().int().nonnegative().optional(),
  }),
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("result"),
    taskId: z.string().min(1),
    status: actionStatusSchema,
    ticks: z.number().int().nonnegative().optional(),
    code: bridgeErrorCodeSchema.optional(),
    detail: z.string().optional(),
    data: z.record(z.unknown()).optional(),
  }),
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("event"),
    seq: z.number().int().nonnegative(),
    tick: z.number().int().nonnegative(),
    name: z.string().min(1),
    data: z.record(z.unknown()),
  }),
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("ownership"),
    owner: ownershipSchema,
    reason: z.string(),
  }),
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("heartbeat"),
    tick: z.number().int().nonnegative(),
    owner: ownershipSchema,
    /**
     * Distinct from liveness. The Mod can publish a fresh snapshot from the
     * network heartbeat thread without touching Minecraft state.
     */
    worldGeneration: z.number().int().nonnegative().optional(),
    /**
     * A world snapshot can only be produced on the render/client thread. A
     * heartbeat during a render stall may omit it, but it must never resend a
     * stale snapshot that makes the planner believe the world is unchanged.
     */
    world: worldSnapshotSchema.nullable().optional(),
  }),
]);
export type BridgeClientFrame = z.infer<typeof bridgeClientFrameSchema>;

/** Orchestrator → client. */
export const bridgeServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("welcome"),
    sessionId: z.string().min(1),
    /**
     * The body must obey this owner immediately. A reconnect after takeover or
     * stop must not assume `agent` just because the token matched.
     */
    owner: ownershipSchema,
    generation: z.number().int().positive(),
    capabilities: z.array(bridgeCapabilitySchema),
    skills: z.array(skillNameSchema),
    heartbeatMs: z.number().int().positive(),
    watchdogMs: z.number().int().positive(),
  }).strict(),
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("cmd"),
    id: z.string().min(1),
    decisionId: z.string().min(1).optional(),
    op: skillNameSchema,
    args: z.record(z.unknown()),
    deadlineTick: z.number().int().optional(),
    priority: prioritySchema,
    idempotencyKey: z.string().min(1),
  }),
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("cancel"),
    taskId: z.string().min(1),
    /** Command id, usable before the body has acknowledged a taskId. */
    id: z.string().min(1).optional(),
    reason: z.string().min(1),
  }),
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("ownership"),
    owner: ownershipSchema,
    reason: z.string(),
  }),
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("heartbeat"),
    tick: z.number().int().nonnegative(),
    owner: ownershipSchema,
  }),
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("error"),
    code: bridgeErrorCodeSchema,
    detail: z.string(),
    id: z.string().optional(),
  }),
]);
export type BridgeServerFrame = z.infer<typeof bridgeServerFrameSchema>;
