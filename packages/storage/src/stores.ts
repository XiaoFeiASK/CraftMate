import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ActionStatus,
  AudienceEvent,
  Decision,
  SkillCall,
} from "@craftmate/contracts";

const RAW_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface SessionContext {
  readonly sessionId: string;
  readonly personaVersionId: string;
}

export interface AppendSourceResult {
  readonly id: string;
  /** False when the platform event id was already stored for this session. */
  readonly inserted: boolean;
}

/**
 * Session bootstrap. Every decision row needs a persona version and every
 * source row needs a live session, so both are created once and reused.
 */
export class SessionStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Idempotent: reuses the active persona version and the newest live session,
   * creating them only when absent.
   */
  bootstrap(persona: { readonly id: string; readonly name: string }, goalText: string): SessionContext {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO persona (id, persona_key, name, created_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (persona_key) DO NOTHING`,
      )
      .run(persona.id, persona.id, persona.name, now);

    const personaRow = this.db
      .prepare("SELECT id FROM persona WHERE persona_key = ?")
      .get(persona.id) as { id: string } | undefined;
    if (!personaRow) throw new Error(`persona ${persona.id} could not be created`);

    let versionRow = this.db
      .prepare("SELECT id FROM persona_version WHERE persona_id = ? AND state = 'active'")
      .get(personaRow.id) as { id: string } | undefined;
    if (!versionRow) {
      const versionId = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO persona_version
             (id, persona_id, revision, content_json, state, created_at_ms)
           VALUES (?, ?, 1, ?, 'active', ?)`,
        )
        .run(versionId, personaRow.id, JSON.stringify({ id: persona.id, name: persona.name }), now);
      versionRow = { id: versionId };
    }

    let sessionRow = this.db
      .prepare("SELECT id FROM show_session WHERE status = 'live' ORDER BY created_at_ms DESC LIMIT 1")
      .get() as { id: string } | undefined;
    if (!sessionRow) {
      const sessionId = crypto.randomUUID();
      const next = this.db.prepare("SELECT coalesce(max(session_no), 0) + 1 AS n FROM show_session").get() as {
        n: number;
      };
      this.db
        .prepare(
          `INSERT INTO show_session
             (id, session_no, persona_version_id, goal_text, status, started_at_ms, created_at_ms)
           VALUES (?, ?, ?, ?, 'live', ?, ?)`,
        )
        .run(sessionId, next.n, versionRow.id, goalText, now, now);
      sessionRow = { id: sessionId };
    }

    return { sessionId: sessionRow.id, personaVersionId: versionRow.id };
  }
}

export class SourceStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Append-only evidence. `inserted: false` means the platform event was
   * already recorded, which is the restart-safe half of deduplication.
   */
  append(sessionId: string, event: AudienceEvent): AppendSourceResult {
    // The uniqueness guard is a partial index, which `ON CONFLICT` cannot
    // target, so dedupe with an explicit lookup inside one immediate transaction.
    const existing = this.db
      .prepare("SELECT id FROM source WHERE session_id = ? AND kind = ? AND external_event_id = ?")
      .get(sessionId, event.kind, event.id) as { id: string } | undefined;
    if (existing) return { id: existing.id, inserted: false };

    const now = Date.now();
    const id = crypto.randomUUID();
    const text = event.text?.slice(0, 500) ?? null;
    this.db
      .prepare(
        `INSERT INTO source
           (id, external_event_id, session_id, kind, actor_ref, raw_text,
            payload_json, content_hash, received_at_ms, raw_expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.id,
        sessionId,
        event.kind,
        hashActor(event.userId),
        text,
        JSON.stringify({
          nickname: event.nickname.slice(0, 40),
          gift: event.gift ?? null,
        }),
        contentHash(event),
        now,
        text === null ? null : now + RAW_RETENTION_MS,
      );
    return { id, inserted: true };
  }

  /** Blank the raw text of expired rows, keeping the hash and metrics. */
  expireRawText(now = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE source SET raw_text = NULL
         WHERE raw_text IS NOT NULL AND raw_expires_at_ms IS NOT NULL AND raw_expires_at_ms <= ?`,
      )
      .run(now);
    return Number(result.changes);
  }
}

export class DecisionStore {
  constructor(private readonly db: DatabaseSync) {}

  append(context: SessionContext, sourceId: string, decision: Decision, traceId: string): void {
    this.db
      .prepare(
        `INSERT INTO decision_log
           (id, session_id, source_id, persona_version_id, trace_id, revision, stage,
            intent, decision, priority, score, reason, trace_json, created_at_ms)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        context.sessionId,
        sourceId,
        context.personaVersionId,
        traceId,
        decision.stage,
        decision.intent,
        decision.decision,
        decision.priority,
        decision.score,
        decision.reason,
        JSON.stringify({ eventId: decision.eventId, nickname: decision.nickname }),
        decision.at,
      );
  }

  recent(sessionId: string, limit: number): Decision[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.intent, d.decision, d.priority, d.score, d.reason, d.stage,
                d.created_at_ms, d.trace_json, s.raw_text
         FROM decision_log d
         JOIN source s ON s.id = d.source_id
         WHERE d.session_id = ? ORDER BY d.created_at_ms DESC LIMIT ?`,
      )
      .all(sessionId, limit) as {
      id: string;
      intent: Decision["intent"];
      decision: Decision["decision"];
      priority: Decision["priority"];
      score: number;
      reason: string;
      stage: Decision["stage"];
      created_at_ms: number;
      trace_json: string;
      raw_text: string | null;
    }[];

    return rows.map((row) => {
      const trace = JSON.parse(row.trace_json) as { eventId?: string; nickname?: string };
      return {
        id: row.id,
        eventId: trace.eventId ?? "",
        nickname: trace.nickname ?? "",
        text: row.raw_text ?? "",
        intent: row.intent,
        decision: row.decision,
        priority: row.priority,
        reason: row.reason,
        score: row.score,
        stage: row.stage,
        skill: null,
        at: row.created_at_ms,
      };
    });
  }
}

export class ActionStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Returns the attempt id, or the existing one when the idempotency key was
   * already used — a retried command must not execute twice.
   */
  begin(
    sessionId: string,
    decisionId: string,
    call: SkillCall,
    priority: Decision["priority"],
  ): { id: string; created: boolean } {
    const existing = this.db
      .prepare("SELECT id FROM action_attempt WHERE idempotency_key = ?")
      .get(call.idempotencyKey) as { id: string } | undefined;
    if (existing) return { id: existing.id, created: false };

    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO action_attempt
           (id, session_id, decision_id, skill, args_json, priority, status,
            idempotency_key, deadline_tick, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        decisionId,
        call.name,
        JSON.stringify(call.args),
        priority,
        call.idempotencyKey,
        call.deadlineTicks ?? null,
        Date.now(),
      );
    return { id, created: true };
  }

  settle(attemptId: string, status: ActionStatus, errorCode?: string): void {
    const terminal = status !== "queued" && status !== "running";
    this.db
      .prepare(
        `UPDATE action_attempt
         SET status = ?, started_at_ms = coalesce(started_at_ms, ?),
             finished_at_ms = ?, error_code = ?
         WHERE id = ?`,
      )
      .run(status, Date.now(), terminal ? Date.now() : null, errorCode ?? null, attemptId);
  }
}

function hashActor(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 32);
}

function contentHash(event: AudienceEvent): string {
  return createHash("sha256")
    .update(`${event.id}\u0000${event.kind}\u0000${event.text ?? ""}\u0000${event.ts}`)
    .digest("hex");
}
