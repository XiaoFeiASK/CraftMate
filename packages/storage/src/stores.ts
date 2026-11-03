import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ActionStatus,
  AudienceEvent,
  Decision,
  ShowSettings,
  SkillCall,
} from "@craftmate/contracts";
import type {
  Commitment,
  CommitmentJournal,
  CommitmentStatus,
  CommitmentTransition,
} from "@craftmate/agent/domain";

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
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

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
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Append-only evidence. `inserted: false` means the platform event was
   * already recorded, which is the restart-safe half of deduplication.
   */
  append(sessionId: string, event: AudienceEvent): AppendSourceResult {
    // The uniqueness guard is a partial index, which `ON CONFLICT` cannot
    // target. The lookup and insert share one immediate transaction so two
    // connections cannot both observe "absent" and race.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT id FROM source WHERE session_id = ? AND kind = ? AND external_event_id = ?")
        .get(sessionId, event.kind, event.id) as { id: string } | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return { id: existing.id, inserted: false };
      }

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
      this.db.exec("COMMIT");
      return { id, inserted: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Blank the raw text of expired rows, keeping the hash and metrics, and
   * leave one audit row per purged source. Each batch is its own transaction,
   * so a crash cannot produce a purge without its audit trail, and a long
   * backlog cannot hold the write lock for the whole stream.
   */
  expireRawText(now = Date.now(), batchSize = 500): number {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new Error(`batchSize must be a positive integer, got ${batchSize}`);
    }
    let total = 0;
    for (;;) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const expired = this.db
          .prepare(
            `SELECT id, session_id, content_hash FROM source
             WHERE raw_text IS NOT NULL AND raw_expires_at_ms IS NOT NULL AND raw_expires_at_ms <= ?
             ORDER BY raw_expires_at_ms LIMIT ?`,
          )
          .all(now, batchSize) as { id: string; session_id: string; content_hash: string }[];
        if (expired.length === 0) {
          this.db.exec("COMMIT");
          return total;
        }

        const blank = this.db.prepare("UPDATE source SET raw_text = NULL WHERE id = ?");
        const audit = this.db.prepare(
          `INSERT INTO source_retention_audit
             (id, session_id, source_id, action, content_hash, occurred_at_ms)
           VALUES (?, ?, ?, 'raw_text_expired', ?, ?)
           ON CONFLICT (source_id, action) DO NOTHING`,
        );
        for (const row of expired) {
          blank.run(row.id);
          audit.run(crypto.randomUUID(), row.session_id, row.id, row.content_hash, now);
        }
        this.db.exec("COMMIT");
        total += expired.length;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

/**
 * SQLite journal for the commitment ledger. Every method is safe to retry:
 * state updates are guarded by the expected revision and event ids are
 * derived from that revision.
 */
export class CommitmentStore implements CommitmentJournal {
  private readonly db: DatabaseSync;
  private readonly context: SessionContext;

  constructor(db: DatabaseSync, context: SessionContext) {
    this.db = db;
    this.context = context;
  }

  reserve(commitment: Commitment): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          `SELECT session_id, status, revision, utterance, audience_ref, created_at_ms
           FROM commitment WHERE id = ?`,
        )
        .get(commitment.id) as
        | {
            session_id: string;
            status: CommitmentStatus;
            revision: number;
            utterance: string;
            audience_ref: string;
            created_at_ms: number;
          }
        | undefined;
      if (existing) {
        const identical =
          existing.session_id === this.context.sessionId &&
          existing.status === commitment.status &&
          existing.revision === commitment.revision &&
          existing.utterance === commitment.utterance &&
          existing.audience_ref === commitment.audienceRef &&
          existing.created_at_ms === commitment.createdAt;
        if (!identical) throw new Error(`commitment ${commitment.id} already exists with a different state`);
        this.db.exec("COMMIT");
        return;
      }

      this.db
        .prepare(
          `INSERT INTO commitment
             (id, session_id, source_id, persona_version_id, audience_ref, utterance,
              status, revision, deadline_at_ms, plan_id, created_at_ms, spoken_at_ms, closed_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          commitment.id,
          this.context.sessionId,
          commitment.sourceId,
          this.context.personaVersionId,
          commitment.audienceRef,
          commitment.utterance,
          commitment.status,
          commitment.revision,
          commitment.deadlineAt,
          commitment.planId,
          commitment.createdAt,
          commitment.spokenAt,
          commitment.closedAt,
        );
      this.insertEvent(commitment, null, "reserve before speak", commitment.createdAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  transit(change: CommitmentTransition): void {
    const { from, to } = change;
    if (from === null) throw new Error(`commitment ${to.id} cannot transition from null`);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = to.revision - 1;
      const result = this.db
        .prepare(
          `UPDATE commitment
           SET status = ?, revision = ?, spoken_at_ms = coalesce(spoken_at_ms, ?),
               closed_at_ms = ?
           WHERE id = ? AND revision = ? AND status = ?`,
        )
        .run(to.status, to.revision, to.spokenAt, to.closedAt, to.id, previous, from);
      if (Number(result.changes) === 0) {
        const existing = this.db
          .prepare("SELECT status, revision FROM commitment WHERE id = ?")
          .get(to.id) as { status: CommitmentStatus; revision: number } | undefined;
        // A retried write whose event already landed is a no-op, not a conflict.
        if (existing?.status === to.status && existing.revision === to.revision) {
          this.db.exec("COMMIT");
          return;
        }
        throw new Error(
          `commitment ${to.id} is not at revision ${previous}/${from}; ` +
            `stored ${existing?.revision ?? "missing"}/${existing?.status ?? "missing"}`,
        );
      }
      this.insertEvent(to, from, change.reason, change.at);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Open commitments for the live session, ordered by creation time. */
  open(sessionId = this.context.sessionId): Commitment[] {
    return this.query(sessionId, "commitment_open");
  }

  /** Every commitment in the session, newest last, for replay and audit. */
  list(sessionId = this.context.sessionId): Commitment[] {
    return this.query(sessionId, "commitment");
  }

  private query(sessionId: string, table: "commitment" | "commitment_open"): Commitment[] {
    const rows = this.db
      .prepare(
        `SELECT id, audience_ref, source_id, utterance, status, revision,
                created_at_ms, deadline_at_ms, plan_id, spoken_at_ms, closed_at_ms
         FROM ${table}
         WHERE session_id = ?
         ORDER BY created_at_ms, id`,
      )
      .all(sessionId) as unknown as CommitmentRow[];
    return rows.map(toCommitment);
  }

  /**
   * The console's open count. Counting in SQL keeps the projection correct
   * even if the in-memory ledger was built before the store came online.
   */
  openCount(sessionId = this.context.sessionId): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM commitment_open WHERE session_id = ?")
      .get(sessionId) as { n: number };
    return row.n;
  }

  private insertEvent(
    commitment: Commitment,
    from: CommitmentStatus | null,
    reason: string,
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO commitment_event
           (id, commitment_id, from_status, to_status, reason, occurred_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        `${commitment.id}:${commitment.revision}`,
        commitment.id,
        from,
        commitment.status,
        reason,
        at,
      );
  }
}

interface CommitmentRow {
  id: string;
  audience_ref: string;
  source_id: string | null;
  utterance: string;
  status: CommitmentStatus;
  revision: number;
  created_at_ms: number;
  deadline_at_ms: number | null;
  plan_id: string | null;
  spoken_at_ms: number | null;
  closed_at_ms: number | null;
}

function toCommitment(row: CommitmentRow): Commitment {
  return {
    id: row.id,
    audienceRef: row.audience_ref,
    sourceId: row.source_id,
    utterance: row.utterance,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at_ms,
    deadlineAt: row.deadline_at_ms,
    planId: row.plan_id,
    spokenAt: row.spoken_at_ms,
    closedAt: row.closed_at_ms,
  };
}

export class DecisionStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

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

  /**
   * Totals for a session. The in-memory counters reset on restart, so the
   * console must be seeded from the database or it shows "received N, decided 0".
   */
  counts(sessionId: string): {
    received: number;
    decided: number;
    executed: number;
    refused: number;
    observed: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           count(*) AS received,
           count(*) AS decided,
           sum(CASE WHEN decision = 'EXECUTE' THEN 1 ELSE 0 END) AS executed,
           sum(CASE WHEN decision = 'REFUSE' THEN 1 ELSE 0 END) AS refused,
           sum(CASE WHEN decision = 'OBSERVE' THEN 1 ELSE 0 END) AS observed
         FROM decision_log WHERE session_id = ?`,
      )
      .get(sessionId) as {
      received: number | null;
      decided: number | null;
      executed: number | null;
      refused: number | null;
      observed: number | null;
    };

    return {
      received: row.received ?? 0,
      decided: row.decided ?? 0,
      executed: row.executed ?? 0,
      refused: row.refused ?? 0,
      observed: row.observed ?? 0,
    };
  }
}

export class ActionStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

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

/**
 * Per-session configuration. Reading returns an unvalidated JSON value: the
 * caller owns the schema so this package never becomes a second source of truth
 * for the settings shape.
 */
export class SettingsStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  read(sessionId: string): unknown {
    const row = this.db
      .prepare("SELECT content_json FROM show_settings WHERE session_id = ?")
      .get(sessionId) as { content_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.content_json) as unknown;
    } catch {
      return null;
    }
  }

  write(sessionId: string, settings: ShowSettings): void {
    this.db
      .prepare(
        `INSERT INTO show_settings (session_id, content_json, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE
           SET content_json = excluded.content_json,
               updated_at_ms = excluded.updated_at_ms`,
      )
      .run(sessionId, JSON.stringify(settings), Date.now());
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
