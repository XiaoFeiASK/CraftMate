import type { DatabaseSync } from "node:sqlite";
import {
  agentEventSchema,
  type AgentEvent,
  type AgentEventStage,
  type AgentEventStatus,
} from "@craftmate/contracts";
import type { SessionContext } from "./stores.ts";

interface AgentEventRow {
  readonly id: string;
  readonly stage: AgentEventStage;
  readonly status: AgentEventStatus;
  readonly trace_id: string | null;
  readonly task_id: string | null;
  readonly decision_id: string | null;
  readonly goal_id: string | null;
  readonly duration_ms: number | null;
  readonly summary: string;
  readonly error_code: string | null;
  readonly playbook_id: string | null;
  readonly card_status: AgentEvent["cardStatus"] | null;
  readonly switch_reason: string | null;
  readonly failure_code: string | null;
  readonly recovery_id: string | null;
  readonly model_choice: number | null;
  readonly fallback_reason: string | null;
  readonly route_mode: AgentEvent["routeMode"] | null;
  readonly blocked_reason: string | null;
  readonly blacklist_id: string | null;
  readonly target_lock_json: string | null;
  readonly source: AgentEvent["source"];
  readonly created_at_ms: number;
}

/**
 * Append-only operator events. The table is deliberately separate from the
 * decision log: an ingress drop or a voice failure happens without a decision,
 * and forcing them into `decision_log` would invent rows that never existed.
 */
export class AgentEventStore {
  private readonly db: DatabaseSync;
  private readonly context: SessionContext;

  constructor(db: DatabaseSync, context: SessionContext) {
    this.db = db;
    this.context = context;
  }

  append(event: AgentEvent): void {
    // Validate at the write edge so a new projection cannot silently persist a
    // column that the console schema would reject on the next reconnect.
    const parsed = agentEventSchema.parse(event);
    this.db
      .prepare(
        `INSERT INTO agent_event
           (id, session_id, stage, status, trace_id, task_id, decision_id, goal_id,
            duration_ms, summary, error_code, playbook_id, card_status,
            switch_reason, failure_code, recovery_id, model_choice,
            fallback_reason, route_mode, blocked_reason, blacklist_id,
            target_lock_json, source, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        parsed.id,
        this.context.sessionId,
        parsed.stage,
        parsed.status,
        parsed.traceId,
        parsed.taskId,
        parsed.decisionId,
        parsed.goalId,
        parsed.durationMs,
        parsed.summary,
        parsed.errorCode,
        parsed.playbookId ?? null,
        parsed.cardStatus ?? null,
        parsed.switchReason ?? null,
        parsed.failureCode ?? null,
        parsed.recoveryId ?? null,
        parsed.modelChoice === null || parsed.modelChoice === undefined
          ? null
          : parsed.modelChoice
            ? 1
            : 0,
        parsed.fallbackReason ?? null,
        parsed.routeMode ?? null,
        parsed.blockedReason ?? null,
        parsed.blacklistId ?? null,
        parsed.targetLock === null || parsed.targetLock === undefined
          ? null
          : JSON.stringify(parsed.targetLock),
        parsed.source,
        parsed.at,
      );
  }

  recent(limit = 120): readonly AgentEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, stage, status, trace_id, task_id, decision_id, goal_id,
                duration_ms, summary, error_code, playbook_id, card_status,
                switch_reason, failure_code, recovery_id, model_choice,
                fallback_reason, route_mode, blocked_reason, blacklist_id,
                target_lock_json, source, created_at_ms
         FROM agent_event WHERE session_id = ?
         ORDER BY created_at_ms DESC, rowid DESC LIMIT ?`,
      )
      .all(this.context.sessionId, limit) as unknown as AgentEventRow[];
    return rows.map((row) =>
      agentEventSchema.parse({
        id: row.id,
        at: row.created_at_ms,
        stage: row.stage,
        status: row.status,
        traceId: row.trace_id,
        taskId: row.task_id,
        decisionId: row.decision_id,
        goalId: row.goal_id,
        durationMs: row.duration_ms,
        summary: row.summary,
        errorCode: row.error_code,
        playbookId: row.playbook_id,
        cardStatus: row.card_status,
        switchReason: row.switch_reason,
        failureCode: row.failure_code,
        recoveryId: row.recovery_id,
        modelChoice: row.model_choice === null ? null : row.model_choice === 1,
        fallbackReason: row.fallback_reason,
        routeMode: row.route_mode,
        blockedReason: row.blocked_reason,
        blacklistId: row.blacklist_id,
        targetLock:
          row.target_lock_json === null ? null : JSON.parse(row.target_lock_json),
        source: row.source,
      }),
    );
  }

  trace(traceId: string, limit = 200): readonly AgentEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, stage, status, trace_id, task_id, decision_id, goal_id,
                duration_ms, summary, error_code, playbook_id, card_status,
                switch_reason, failure_code, recovery_id, model_choice,
                fallback_reason, route_mode, blocked_reason, blacklist_id,
                target_lock_json, source, created_at_ms
         FROM agent_event WHERE session_id = ? AND trace_id = ?
         ORDER BY created_at_ms ASC LIMIT ?`,
      )
      .all(this.context.sessionId, traceId, limit) as unknown as AgentEventRow[];
    return rows.map((row) =>
      agentEventSchema.parse({
        id: row.id,
        at: row.created_at_ms,
        stage: row.stage,
        status: row.status,
        traceId: row.trace_id,
        taskId: row.task_id,
        decisionId: row.decision_id,
        goalId: row.goal_id,
        durationMs: row.duration_ms,
        summary: row.summary,
        errorCode: row.error_code,
        playbookId: row.playbook_id,
        cardStatus: row.card_status,
        switchReason: row.switch_reason,
        failureCode: row.failure_code,
        recoveryId: row.recovery_id,
        modelChoice: row.model_choice === null ? null : row.model_choice === 1,
        fallbackReason: row.fallback_reason,
        routeMode: row.route_mode,
        blockedReason: row.blocked_reason,
        blacklistId: row.blacklist_id,
        targetLock:
          row.target_lock_json === null ? null : JSON.parse(row.target_lock_json),
        source: row.source,
      }),
    );
  }

  /**
   * An event list is not a replay. Replay still comes from the source,
   * decision, commitment and action rows; this query only proves the event
   * stream survived a restart.
   */
  count(): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM agent_event WHERE session_id = ?")
      .get(this.context.sessionId) as { n: number };
    return row.n;
  }
}

