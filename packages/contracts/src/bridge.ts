import { z } from "zod";
import { prioritySchema, skillNameSchema } from "./decision.ts";

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
  }),
]);
export type BridgeClientFrame = z.infer<typeof bridgeClientFrameSchema>;

/** Orchestrator → client. */
export const bridgeServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("welcome"),
    sessionId: z.string().min(1),
    capabilities: z.array(bridgeCapabilitySchema),
    skills: z.array(skillNameSchema),
    heartbeatMs: z.number().int().positive(),
    watchdogMs: z.number().int().positive(),
  }),
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    type: z.literal("cmd"),
    id: z.string().min(1),
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
