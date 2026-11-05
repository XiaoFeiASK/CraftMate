import { z } from "zod";

/**
 * Operator-facing event contract.
 *
 * Every event is a projection of a fact the backend already has. It carries
 * join keys rather than prose so the console can group a trace without
 * reconstructing state, and every free-text field is written after the
 * control-plane redaction boundary — never raw prompt, model output, audience
 * text, or a credential.
 */
export const agentEventStageSchema = z.enum([
  "ingress_received",
  "gated",
  "dropped",
  "arbitrated",
  "planned",
  "task_queued",
  "task_running",
  "progress",
  "task_settled",
  "failed",
  "voice_started",
  "voice_settled",
  "settings_applied",
  "connection_changed",
]);
export type AgentEventStage = z.infer<typeof agentEventStageSchema>;

export const agentEventStatusSchema = z.enum([
  "ok",
  "waiting",
  "degraded",
  "failed",
  "skipped",
  "unknown",
]);
export type AgentEventStatus = z.infer<typeof agentEventStatusSchema>;

/**
 * A safe judgement summary. `intent` and `nextStep` are operator-facing copy;
 * they are not raw chain-of-thought, provider output, or audience text.
 */
export const agentJudgementSchema = z.object({
  summary: z.string().trim().min(1).max(600),
  intent: z.string().trim().max(80).default(""),
  reason: z.string().trim().max(600).default(""),
  nextStep: z.string().trim().max(240).default(""),
  confidence: z.enum(["observed", "inferred", "unknown"]).default("unknown"),
});
export type AgentJudgement = z.infer<typeof agentJudgementSchema>;

export const agentEventSchema = z.object({
  id: z.string().min(1),
  at: z.number().int().nonnegative(),
  stage: agentEventStageSchema,
  status: agentEventStatusSchema.default("ok"),
  traceId: z.string().min(1).nullable().default(null),
  taskId: z.string().min(1).nullable().default(null),
  decisionId: z.string().min(1).nullable().default(null),
  goalId: z.string().min(1).nullable().default(null),
  /** End-to-end or stage-local duration. Null means it was not measured. */
  durationMs: z.number().int().nonnegative().nullable().default(null),
  /** Operator-safe summary, already redacted at the control-plane boundary. */
  summary: z.string().trim().max(600).default(""),
  /** Machine-readable failure such as E_BODY_MISSING. */
  errorCode: z.string().trim().max(64).nullable().default(null),
  source: z.enum(["ingress", "agent", "goal", "voice", "bridge", "control"]),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;

/**
 * Per-room ingress facts. A zero is only shown when the counter is genuinely
 * known to be zero; missing or unconfigured data is `null`, never success.
 */
export const ingressMetricsSchema = z.object({
  state: z.enum(["unknown", "not_configured", "connecting", "open", "closed", "error"]),
  detail: z.string().default(""),
  roomId: z.string().nullable().default(null),
  lastEventAt: z.number().int().nonnegative().nullable().default(null),
  received: z.number().int().nonnegative().nullable().default(null),
  forwarded: z.number().int().nonnegative().nullable().default(null),
  queued: z.number().int().nonnegative().nullable().default(null),
  dropped: z.number().int().nonnegative().nullable().default(null),
  dropReasons: z.record(z.number().int().nonnegative()).default({}),
  upstreamConnected: z.boolean().nullable().default(null),
  reconnects: z.number().int().nonnegative().nullable().default(null),
  updatedAt: z.number().int().nonnegative().nullable().default(null),
});
export type IngressMetrics = z.infer<typeof ingressMetricsSchema>;

/**
 * What the ingress process knows about itself. `roomId` and `updatedAt` are
 * added by the orchestrator, which is the only process that knows the saved
 * configuration.
 */
export const ingressMetricsFrameSchema = z.object({
  state: z.enum(["connecting", "open", "closed", "error"]),
  detail: z.string().default(""),
  lastEventAt: z.number().int().nonnegative().nullable().default(null),
  received: z.number().int().nonnegative(),
  forwarded: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  dropReasons: z.record(z.number().int().nonnegative()).default({}),
  upstreamConnected: z.boolean(),
  reconnects: z.number().int().nonnegative().default(0),
  /** Recent safe facts, already stripped of audience text by the child. */
  recent: z.array(z.object({
    /** Platform event id; joins this ingress fact to its decision trace. */
    id: z.string().min(1),
    at: z.number().int().nonnegative(),
    kind: z.enum(["comment", "gift", "like", "enter", "viewer_count"]),
    accepted: z.boolean(),
    reason: z.string().max(80).default(""),
    latencyMs: z.number().int().nonnegative().nullable().default(null),
  })).readonly().default([]),
});
export type IngressMetricsFrame = z.infer<typeof ingressMetricsFrameSchema>;

export const telemetrySnapshotSchema = z.object({
  /** Newest first, bounded by the backend so a long run cannot grow the wire. */
  events: z.array(agentEventSchema).readonly().default([]),
  judgement: agentJudgementSchema.nullable().default(null),
  ingress: ingressMetricsSchema,
  /** Timeline entries are fetched by trace id; their presence is not implied. */
  generatedAt: z.number().int().nonnegative().default(0),
});
export type TelemetrySnapshot = z.infer<typeof telemetrySnapshotSchema>;

