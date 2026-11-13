import { z } from "zod";
import { navigationModeSchema, targetLockSchema } from "./navigation.ts";
import { audienceEventSchema, sourceHealthSchema } from "./audience.ts";
import { decisionSchema, intentSchema } from "./decision.ts";
import {
  integrationSettingsUpdateSchema,
  integrationSettingsViewSchema,
  showSettingsSchema,
} from "./settings.ts";
import { voiceStatusSchema, voiceSubtitleSchema } from "./voice.ts";
import { bridgeHealthSchema, opsRequestSchema, opsSnapshotSchema } from "./ops.ts";
import { timelineEntrySchema } from "./replay.ts";
import { agentEventSchema, telemetrySnapshotSchema } from "./telemetry.ts";

export const showModeSchema = z.enum(["agent", "operator", "stopped"]);
export type ShowMode = z.infer<typeof showModeSchema>;

export const operatorKindSchema = z.enum(["whisper", "takeover", "release", "stop"]);
export type OperatorKind = z.infer<typeof operatorKindSchema>;

export const operatorCommandSchema = z.object({
  kind: operatorKindSchema,
  text: z.string(),
});
export type OperatorCommand = z.infer<typeof operatorCommandSchema>;

export const showStatsSchema = z.object({
  /** Dashboard counters since its last reset; audit records are retained. */
  since: z.number().int().nonnegative().optional(),
  received: z.number().int().nonnegative(),
  /** Every decision produced, including IGNORE / ACK_ONLY / QUEUE. */
  decided: z.number().int().nonnegative(),
  executed: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  openCommitments: z.number().int().nonnegative(),
});
export type ShowStats = z.infer<typeof showStatsSchema>;

export const modelConnectionSchema = z.object({
  state: z.enum(["unverified", "ready", "error", "disabled"]),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  detail: z.string().default(""),
});
export type ModelConnection = z.infer<typeof modelConnectionSchema>;

/**
 * Discovery result for an OpenAI-compatible `/models` endpoint. The console
 * asks the local kernel so the browser never has to make a cross-origin
 * request with the operator's key.
 */
export const modelCatalogSchema = z.object({
  baseUrl: z.string(),
  ok: z.boolean(),
  models: z.array(z.string().trim().min(1).max(200)).readonly(),
  detail: z.string().default(""),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

export const operatorNoticeSchema = z.object({
  kind: operatorKindSchema,
  text: z.string(),
  detail: z.string(),
  at: z.number().int().nonnegative(),
});
export type OperatorNotice = z.infer<typeof operatorNoticeSchema>;

export const goalStatusSchema = z.enum([
  "unverified",
  "active",
  "paused",
  "blocked",
  "completed",
  "failed",
]);
export type GoalStatus = z.infer<typeof goalStatusSchema>;

/**
 * The operator-owned end goal. `version` increments on every replacement so a
 * plan or proposal evaluated against an older goal can be discarded instead of
 * silently retargeted.
 */
export const seasonGoalSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400),
  status: goalStatusSchema,
  version: z.number().int().positive(),
  setBy: z.literal("operator"),
  setAt: z.number().int().nonnegative(),
});
export type SeasonGoal = z.infer<typeof seasonGoalSchema>;

export const goalMilestoneSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  status: z.enum(["completed", "unverified"]),
});
export type GoalMilestone = z.infer<typeof goalMilestoneSchema>;

/**
 * Progress is evidence, never a percentage. Before the goal engine can verify
 * a milestone it stays explicitly `unverified`; the console must not turn that
 * gap into a fabricated completion rate.
 */
export const goalProgressSchema = z.object({
  goalId: z.string().min(1),
  goalVersion: z.number().int().positive(),
  status: goalStatusSchema,
  stage: z.object({
    id: z.string().min(1),
    title: z.string().trim().min(1).max(160),
  }),
  milestone: z.object({
    id: z.string().min(1),
    title: z.string().trim().min(1).max(160),
  }),
  nextTask: z.string().trim().max(240),
  milestones: z.array(goalMilestoneSchema).default([]),
  completed: z.number().int().nonnegative().default(0),
  unverified: z.number().int().nonnegative().default(0),
  lastFailure: z.string().trim().max(600).nullable().default(null),
  /**
   * Operator-facing playbook state. Alternatives stay bounded so the wire
   * never grows with the full catalog; blocked reasons explain the gate.
   */
  playbook: z
    .object({
      cardId: z.string().min(1).max(80),
      cardTitle: z.string().trim().min(1).max(160),
      cardReason: z.string().trim().max(500).default(""),
      status: z.enum(["available", "blocked", "done"]),
      activeForMs: z.number().int().nonnegative().default(0),
      minDwellRemainingMs: z.number().int().nonnegative().default(0),
      switchReason: z.string().trim().max(300).nullable().default(null),
      modelChoice: z.boolean().nullable().default(null),
      fallbackReason: z.string().trim().max(300).nullable().default(null),
      failureCode: z.string().trim().max(64).nullable().default(null),
      recoveryId: z.string().trim().max(80).nullable().default(null),
      alternatives: z
        .array(
          z.object({
            id: z.string().min(1).max(80),
            title: z.string().trim().min(1).max(160),
            status: z.enum(["available", "blocked", "done"]),
            blockedReason: z.string().trim().max(300).nullable().default(null),
          }),
        )
        .max(8)
        .default([]),
    })
    .nullable()
    .optional(),
  /** Short-lived entity/explore target selected by the planner. */
  targetLock: targetLockSchema.nullable().optional(),
  /** Consecutive terminal failures; zero means the runtime is not backing off. */
  consecutiveFailures: z.number().int().nonnegative().default(0),
  /** Absolute epoch-ms time the next attempt is allowed, or null when none. */
  retryAt: z.number().int().nonnegative().nullable().default(null),
  updatedAt: z.number().int().nonnegative(),
});
export type GoalProgress = z.infer<typeof goalProgressSchema>;

export const proposalStatusSchema = z.enum([
  "pending",
  "accepted",
  "deferred",
  "rejected",
  "clarify",
]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const proposalRiskSchema = z.enum(["low", "medium", "high", "blocked"]);
export type ProposalRisk = z.infer<typeof proposalRiskSchema>;

export const proposalAlignmentSchema = z.enum([
  "aligned",
  "neutral",
  "off_goal",
  "unknown",
]);
export type ProposalAlignment = z.infer<typeof proposalAlignmentSchema>;

/**
 * One audience suggestion after the three deterministic gates. `votes` only
 * raises reply priority; it never promotes a proposal to `accepted`.
 */
export const proposalSchema = z.object({
  id: z.string().min(1),
  sourceEventId: z.string().min(1),
  audienceRef: z.string().min(1),
  text: z.string().trim().min(1).max(500),
  votes: z.number().int().nonnegative().default(1),
  intent: intentSchema,
  status: proposalStatusSchema,
  reason: z.string().trim().min(1).max(600),
  risk: proposalRiskSchema,
  goalAlignment: proposalAlignmentSchema,
  createdAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative().nullable().default(null),
});
export type Proposal = z.infer<typeof proposalSchema>;

export const showSnapshotSchema = z.object({
  mode: showModeSchema,
  stats: showStatsSchema,
  decisions: z.array(decisionSchema).readonly(),
  operatorNotice: operatorNoticeSchema.nullable(),
  goal: goalProgressSchema.nullable().default(null),
  proposals: z.array(proposalSchema).readonly().default([]),
  sourceHealth: sourceHealthSchema.nullable().default(null),
  voiceStatus: voiceStatusSchema.nullable().default(null),
  bridge: bridgeHealthSchema.nullable().default(null),
  model: modelConnectionSchema.nullable().default(null),
});
export type ShowSnapshot = z.infer<typeof showSnapshotSchema>;

/**
 * Wire projection of the persona. The console only needs identity and the
 * weights it renders, so the full domain persona never crosses this boundary.
 */
export const personaSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  identity: z.string().min(1),
  weights: z.record(z.number()),
});
export type PersonaSummary = z.infer<typeof personaSummarySchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello") }),
  z.object({ type: z.literal("activityReset") }),
  z.object({ type: z.literal("comment"), payload: audienceEventSchema }),
  z.object({ type: z.literal("operator"), payload: operatorCommandSchema }),
  z.object({
    type: z.literal("goalSet"),
    payload: z.object({
      title: z.string().trim().min(1).max(120),
      description: z.string().trim().max(400),
    }),
  }),
  z.object({ type: z.literal("goalPause") }),
  z.object({ type: z.literal("goalResume") }),
  z.object({
    type: z.literal("proposalDecision"),
    payload: z.object({
      proposalId: z.string().min(1),
      status: z.enum(["accepted", "deferred", "rejected", "clarify"]),
      reason: z.string().trim().min(1).max(600),
    }),
  }),
  z.object({
    type: z.literal("proposalQuery"),
    payload: z.object({
      status: proposalStatusSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
  }),
  z.object({ type: z.literal("settings"), payload: showSettingsSchema }),
  z.object({
    type: z.literal("settingsSave"),
    payload: z.object({
      settings: showSettingsSchema,
      integrations: integrationSettingsUpdateSchema,
    }),
  }),
  z.object({
    type: z.literal("modelList"),
    payload: z.object({
      baseUrl: z.string().trim().url().max(240).refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        "URL must use http: or https:",
      ),
      /** Omitted or blank means "use the key already saved for this URL". */
      apiKey: z.string().trim().max(4_096).optional(),
    }),
  }),
  z.object({
    type: z.literal("speak"),
    payload: z.object({ text: z.string().trim().min(1).max(2_000) }),
  }),
  z.object({ type: z.literal("ops"), payload: opsRequestSchema }),
  z.object({ type: z.literal("replay"), payload: z.object({ traceId: z.string().min(1) }) }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    payload: z.object({
      persona: personaSummarySchema,
      snapshot: showSnapshotSchema,
      settings: showSettingsSchema,
      integrations: integrationSettingsViewSchema,
      telemetry: telemetrySnapshotSchema,
    }),
  }),
  z.object({ type: z.literal("decision"), payload: decisionSchema }),
  z.object({ type: z.literal("stats"), payload: showStatsSchema }),
  z.object({ type: z.literal("snapshot"), payload: showSnapshotSchema }),
  z.object({ type: z.literal("goal"), payload: goalProgressSchema }),
  z.object({
    type: z.literal("proposals"),
    payload: z.object({ proposals: z.array(proposalSchema).readonly() }),
  }),
  z.object({ type: z.literal("operator"), payload: operatorCommandSchema }),
  z.object({ type: z.literal("source"), payload: sourceHealthSchema }),
  z.object({ type: z.literal("settings"), payload: showSettingsSchema }),
  z.object({ type: z.literal("integrations"), payload: integrationSettingsViewSchema }),
  z.object({ type: z.literal("models"), payload: modelCatalogSchema }),
  z.object({ type: z.literal("voice"), payload: voiceStatusSchema }),
  z.object({ type: z.literal("subtitle"), payload: voiceSubtitleSchema }),
  z.object({ type: z.literal("bridge"), payload: bridgeHealthSchema }),
  z.object({
    type: z.literal("world"),
    payload: z.object({
      name: z.string().min(1).max(64),
      data: z.unknown(),
      at: z.number().int().nonnegative(),
    }),
  }),
  z.object({ type: z.literal("ops"), payload: opsSnapshotSchema }),
  z.object({
    type: z.literal("replay"),
    payload: z.object({ traceId: z.string().min(1), entries: z.array(timelineEntrySchema) }),
  }),
  /** Append-only operator facts; the console keeps the newest window. */
  z.object({ type: z.literal("event"), payload: agentEventSchema }),
  /** Bounded replacement snapshot, sent after any event or metric change. */
  z.object({ type: z.literal("telemetry"), payload: telemetrySnapshotSchema }),
  z.object({
    type: z.literal("error"),
    payload: z.object({ code: z.string(), detail: z.string() }),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** Body event as it appears in the control console. */
export type BodyEvent = Extract<ServerMessage, { type: "world" }>["payload"];
