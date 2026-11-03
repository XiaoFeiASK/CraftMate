import type { DatabaseSync } from "node:sqlite";
import type {
  ActionStatus,
  BridgeErrorCode,
  DecisionKind,
  Memory,
  MemoryDraft,
  MemoryFamily,
  MemoryState,
  RecalledMemory,
  ReviewCandidate,
  ReviewKind,
  ReviewStatus,
  Priority,
  SkillName,
  TimelineEntry,
} from "@craftmate/contracts";
import type { MemoryPort } from "@craftmate/agent/application";
import type { CommitmentStatus } from "@craftmate/agent/domain";

/** Rough chars-per-token for CJK + ASCII mixed text; budgets are advisory. */
const CHARS_PER_TOKEN = 2;

interface MemoryRow {
  id: string;
  lineage_id: string;
  session_id: string | null;
  subject_ref: string;
  family: MemoryFamily;
  content: string;
  disclosure: Memory["disclosure"];
  confidence: number;
  state: MemoryState;
  revision: number;
  created_at_ms: number;
}

/**
 * Approved-memory store. `memory_active` is the only view recall reads, so an
 * unapproved draft cannot leak into a prompt even if its row exists.
 */
export class MemoryStore implements MemoryPort {
  private readonly db: DatabaseSync;
  private readonly sessionId: string | null;

  constructor(db: DatabaseSync, sessionId: string | null = null) {
    this.db = db;
    this.sessionId = sessionId;
  }

  recall(options: {
    readonly subjectRef: string;
    readonly query: string;
    readonly budgetTokens: number;
  }): readonly RecalledMemory[] {
    // Subject match first: a viewer's own history matters more than a global
    // fact that merely shares a keyword. FTS only ranks inside that set.
    const rows = this.db
      .prepare(
        `SELECT id, lineage_id, session_id, subject_ref, family, content, disclosure,
                confidence, state, revision, created_at_ms
         FROM memory_active
         WHERE subject_ref = ?
         ORDER BY revision DESC, created_at_ms DESC`,
      )
      .all(options.subjectRef) as unknown as MemoryRow[];

    const recalled: RecalledMemory[] = [];
    let used = 0;
    for (const row of rows) {
      if (row.disclosure === "silence") continue;
      const tokens = Math.ceil(row.content.length / CHARS_PER_TOKEN);
      if (used + tokens > options.budgetTokens) continue;
      recalled.push({ memory: toMemory(this.withEvidence(row)), tokens });
      used += tokens;
    }
    void options.query;
    return recalled;
  }

  /**
   * Drafts are parked in `review_candidate`; only approval writes a memory row.
   * The returned id is the candidate id, not a memory id.
   */
  propose(draft: MemoryDraft, sessionId: string | null = this.sessionId): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO review_candidate
             (id, session_id, kind, payload_json, status, expected_version, created_at_ms)
           VALUES (?, ?, 'experience', ?, 'pending', 0, ?)`,
        )
        .run(id, sessionId, JSON.stringify({ ...draft, type: "memory" }), now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return id;
  }

  /** Approve a pending memory candidate and write the recallable row. */
  approveCandidate(candidateId: string, reviewer = "operator"): string {
    const row = this.db
      .prepare("SELECT kind, payload_json, status FROM review_candidate WHERE id = ?")
      .get(candidateId) as { kind: ReviewKind; payload_json: string; status: ReviewStatus } | undefined;
    if (!row) throw new Error(`unknown review candidate ${candidateId}`);
    if (row.status !== "pending") throw new Error(`candidate ${candidateId} is already ${row.status}`);

    const payload = JSON.parse(row.payload_json) as MemoryDraft & { type?: string };
    const now = Date.now();
    const memoryId = crypto.randomUUID();
    const lineageId = crypto.randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO memory
             (id, lineage_id, session_id, persona_version_id, subject_ref, family, content,
              disclosure, confidence, state, revision, created_at_ms)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active', 1, ?)`,
        )
        .run(
          memoryId,
          lineageId,
          this.sessionId,
          payload.subjectRef,
          payload.family,
          payload.content,
          payload.disclosure,
          payload.confidence,
          now,
        );
      const link = this.db.prepare(
        `INSERT INTO memory_evidence (memory_id, source_id) VALUES (?, ?)
         ON CONFLICT (memory_id, source_id) DO NOTHING`,
      );
      for (const sourceId of payload.evidenceSourceIds ?? []) link.run(memoryId, sourceId);
      this.db
        .prepare(
          `UPDATE review_candidate
           SET status = 'approved', reviewer = ?, decided_at_ms = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(reviewer, now, candidateId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return memoryId;
  }

  rejectCandidate(candidateId: string, reason: string, reviewer = "operator"): void {
    const result = this.db
      .prepare(
        `UPDATE review_candidate
         SET status = 'rejected', reviewer = ?, decision_reason = ?, decided_at_ms = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(reviewer, reason, Date.now(), candidateId);
    if (Number(result.changes) === 0) throw new Error(`candidate ${candidateId} is not pending`);
  }

  forget(memoryId: string): void {
    const row = this.db
      .prepare("SELECT lineage_id, revision FROM memory WHERE id = ?")
      .get(memoryId) as { lineage_id: string; revision: number } | undefined;
    if (!row) throw new Error(`unknown memory ${memoryId}`);
    this.db
      .prepare("UPDATE memory SET state = 'forgotten', revision = ? WHERE id = ? AND revision = ?")
      .run(row.revision + 1, memoryId, row.revision);
  }

  list(state?: MemoryState): readonly Memory[] {
    const rows = (
      state === undefined
        ? this.db
            .prepare(
              `SELECT id, lineage_id, session_id, subject_ref, family, content, disclosure,
                      confidence, state, revision, created_at_ms
               FROM memory_current ORDER BY created_at_ms DESC`,
            )
            .all()
        : this.db
            .prepare(
              `SELECT id, lineage_id, session_id, subject_ref, family, content, disclosure,
                      confidence, state, revision, created_at_ms
               FROM memory_current WHERE state = ? ORDER BY created_at_ms DESC`,
            )
            .all(state)
    ) as unknown as MemoryRow[];
    return rows.map((row) => toMemory(this.withEvidence(row)));
  }

  pendingCandidates(): readonly ReviewCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, status, payload_json, reviewer, decision_reason,
                expected_version, created_at_ms, decided_at_ms
         FROM review_candidate WHERE status = 'pending' ORDER BY created_at_ms`,
      )
      .all() as {
      id: string;
      kind: ReviewKind;
      status: ReviewStatus;
      payload_json: string;
      reviewer: string | null;
      decision_reason: string | null;
      expected_version: number;
      created_at_ms: number;
      decided_at_ms: number | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      reviewer: row.reviewer,
      decisionReason: row.decision_reason,
      expectedVersion: row.expected_version,
      createdAt: row.created_at_ms,
      decidedAt: row.decided_at_ms,
    }));
  }

  private withEvidence(row: MemoryRow): MemoryRow & { evidence: string[] } {
    const evidence = this.db
      .prepare("SELECT source_id FROM memory_evidence WHERE memory_id = ?")
      .all(row.id) as { source_id: string }[];
    return { ...row, evidence: evidence.map((item) => item.source_id) };
  }
}

const KIND_RANK: Record<TimelineEntry["kind"], number> = {
  source: 0,
  decision: 1,
  commitment: 2,
  action: 3,
};

function toMemory(row: MemoryRow & { evidence: string[] }): Memory {
  return {
    id: row.id,
    lineageId: row.lineage_id,
    sessionId: row.session_id,
    subjectRef: row.subject_ref,
    family: row.family,
    content: row.content,
    disclosure: row.disclosure,
    confidence: row.confidence,
    state: row.state,
    revision: row.revision,
    evidenceSourceIds: row.evidence,
    createdAt: row.created_at_ms,
  };
}

/**
 * Read-only timeline for replay. Rows are merged in TypeScript instead of a
 * four-way SQL UNION so each query can use its own index.
 */
export class ReplayStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  sessions(limit = 50): readonly {
    id: string;
    sessionNo: number;
    goal: string;
    status: "planned" | "live" | "ended" | "aborted";
    startedAt: number | null;
    endedAt: number | null;
    decisions: number;
    openCommitments: number;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.session_no, s.goal_text, s.status, s.started_at_ms, s.ended_at_ms,
                (SELECT count(*) FROM decision_log d WHERE d.session_id = s.id) AS decisions,
                (SELECT count(*) FROM commitment_open c WHERE c.session_id = s.id) AS open_commitments
         FROM show_session s ORDER BY s.session_no DESC LIMIT ?`,
      )
      .all(limit) as {
      id: string;
      session_no: number;
      goal_text: string;
      status: "planned" | "live" | "ended" | "aborted";
      started_at_ms: number | null;
      ended_at_ms: number | null;
      decisions: number;
      open_commitments: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      sessionNo: row.session_no,
      goal: row.goal_text,
      status: row.status,
      startedAt: row.started_at_ms,
      endedAt: row.ended_at_ms,
      decisions: row.decisions,
      openCommitments: row.open_commitments,
    }));
  }

  /**
   * Trace lookup must not depend on the in-memory ring buffer, so this reads
   * everything from SQLite and keeps working after a restart.
   */
  timeline(traceId: string): readonly TimelineEntry[] {
    const sources = this.db
      .prepare(
        `SELECT id, kind, actor_ref, raw_text, received_at_ms, external_event_id
         FROM source WHERE external_event_id = ? ORDER BY received_at_ms`,
      )
      .all(traceId) as {
      id: string;
      kind: "comment" | "gift" | "like" | "enter" | "viewer_count" | "operator" | "world" | "system";
      actor_ref: string | null;
      raw_text: string | null;
      received_at_ms: number;
      external_event_id: string;
    }[];

    const decisions = this.db
      .prepare(
        `SELECT id, trace_id, decision, intent, priority, stage, reason, skill_json,
                provider, model, created_at_ms
         FROM decision_log WHERE trace_id = ? ORDER BY created_at_ms`,
      )
      .all(traceId) as {
      id: string;
      trace_id: string;
      decision: DecisionKind;
      intent: string;
      priority: Priority;
      stage: "rules" | "scored" | "planned";
      reason: string;
      skill_json: string | null;
      provider: string | null;
      model: string | null;
      created_at_ms: number;
    }[];

    const commitments = this.db
      .prepare(
        `SELECT c.id, e.to_status, c.utterance, e.reason, e.occurred_at_ms
         FROM commitment_event e
         JOIN commitment c ON c.id = e.commitment_id
         JOIN source s ON s.id = c.source_id
         WHERE s.external_event_id = ?
         ORDER BY e.occurred_at_ms`,
      )
      .all(traceId) as {
      id: string;
      to_status: CommitmentStatus;
      utterance: string;
      reason: string;
      occurred_at_ms: number;
    }[];

    const actions = this.db
      .prepare(
        `SELECT a.id, a.decision_id, a.skill, a.status, a.error_code, a.created_at_ms
         FROM action_attempt a
         JOIN decision_log d ON d.id = a.decision_id
         WHERE d.trace_id = ?
         ORDER BY a.created_at_ms`,
      )
      .all(traceId) as {
      id: string;
      decision_id: string;
      skill: string;
      status: ActionStatus;
      error_code: string | null;
      created_at_ms: number;
    }[];

    const entries: TimelineEntry[] = [
      ...sources.map(
        (row): TimelineEntry => ({
          kind: "source",
          at: row.received_at_ms,
          sourceId: row.id,
          traceId: row.external_event_id,
          eventKind: row.kind,
          actor: row.actor_ref,
          text: row.raw_text,
        }),
      ),
      ...decisions.map((row): TimelineEntry => {
        const skill = row.skill_json === null ? null : (JSON.parse(row.skill_json) as { name: string });
        return {
          kind: "decision",
          at: row.created_at_ms,
          decisionId: row.id,
          traceId: row.trace_id,
          decision: row.decision,
          intent: row.intent,
          priority: row.priority,
          stage: row.stage,
          reason: row.reason,
          skill: skill === null ? null : (skill.name as SkillName),
          provider: row.provider,
          model: row.model,
        };
      }),
      ...commitments.map(
        (row): TimelineEntry => ({
          kind: "commitment",
          at: row.occurred_at_ms,
          commitmentId: row.id,
          status: row.to_status,
          utterance: row.utterance,
          reason: row.reason,
        }),
      ),
      ...actions.map(
        (row): TimelineEntry => ({
          kind: "action",
          at: row.created_at_ms,
          actionId: row.id,
          decisionId: row.decision_id,
          skill: row.skill,
          status: row.status,
          errorCode: row.error_code as BridgeErrorCode | null,
        }),
      ),
    ];
    // Same-millisecond rows get a canonical order: evidence, then the decision,
    // then what the agent promised, then the body's side effect.
    return entries.sort(
      (left: TimelineEntry, right: TimelineEntry) =>
        left.at - right.at || KIND_RANK[left.kind] - KIND_RANK[right.kind],
    );
  }
}
