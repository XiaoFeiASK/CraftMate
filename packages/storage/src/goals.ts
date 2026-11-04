import type { DatabaseSync } from "node:sqlite";
import type {
  GoalProgress,
  Proposal,
  ProposalStatus,
  SeasonGoal,
} from "@craftmate/contracts";
import {
  goalProgressSchema,
  proposalSchema,
  seasonGoalSchema,
} from "@craftmate/contracts";
import type {
  GoalRuntimeRecord,
  GoalRuntimeStore,
  ProposalRepository,
} from "@craftmate/agent/application";
import type { SessionContext } from "./stores.ts";

/** Durable goal state. Evidence is restored; in-flight work is not replayed. */
export class GoalRuntimeSqliteStore implements GoalRuntimeStore {
  private readonly db: DatabaseSync;
  private readonly context: SessionContext;

  constructor(db: DatabaseSync, context: SessionContext) {
    this.db = db;
    this.context = context;
  }

  load(): GoalRuntimeRecord | null {
    const row = this.db
      .prepare(
        `SELECT goal_json, enabled, progress_json, current_decision_id,
                current_strategy_key, last_failure, last_failure_strategy,
                consecutive_failures, retry_at_ms, updated_at_ms, failures_json
         FROM goal_runtime WHERE session_id = ?`,
      )
      .get(this.context.sessionId) as
      | {
          goal_json: string | null;
          enabled: number;
          progress_json: string | null;
          current_decision_id: string | null;
          current_strategy_key: string | null;
          last_failure: string | null;
          last_failure_strategy: string | null;
          consecutive_failures: number;
          retry_at_ms: number;
          updated_at_ms: number;
          failures_json: string | null;
        }
      | undefined;
    if (!row) return null;

    const goal = parseJson(row.goal_json);
    const progress = parseJson(row.progress_json);
    const parsedGoal = goal === null ? null : seasonGoalSchema.safeParse(goal);
    const parsedProgress = progress === null ? null : goalProgressSchema.safeParse(progress);
    return {
      goal: parsedGoal?.success ? parsedGoal.data : null,
      enabled: row.enabled === 1,
      progress: parsedProgress?.success ? parsedProgress.data : null,
      currentDecisionId: row.current_decision_id,
      currentStrategyKey: row.current_strategy_key,
      lastFailure: row.last_failure,
      lastFailureStrategy: row.last_failure_strategy,
      consecutiveFailures: row.consecutive_failures,
      retryAt: row.retry_at_ms,
      updatedAt: row.updated_at_ms,
      failures: parseFailures(row.failures_json),
    };
  }

  save(record: GoalRuntimeRecord): void {
    this.db
      .prepare(
        `INSERT INTO goal_runtime
           (session_id, goal_json, enabled, progress_json, current_decision_id,
            current_strategy_key, last_failure, last_failure_strategy,
            consecutive_failures, retry_at_ms, updated_at_ms, failures_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET
           goal_json = excluded.goal_json,
           enabled = excluded.enabled,
           progress_json = excluded.progress_json,
           current_decision_id = excluded.current_decision_id,
           current_strategy_key = excluded.current_strategy_key,
           last_failure = excluded.last_failure,
           last_failure_strategy = excluded.last_failure_strategy,
           consecutive_failures = excluded.consecutive_failures,
           retry_at_ms = excluded.retry_at_ms,
           updated_at_ms = excluded.updated_at_ms,
           failures_json = excluded.failures_json`,
      )
      .run(
        this.context.sessionId,
        record.goal === null ? null : JSON.stringify(record.goal),
        record.enabled ? 1 : 0,
        record.progress === null ? null : JSON.stringify(record.progress),
        record.currentDecisionId,
        record.currentStrategyKey,
        record.lastFailure,
        record.lastFailureStrategy,
        record.consecutiveFailures,
        record.retryAt,
        record.updatedAt,
        JSON.stringify(record.failures ?? []),
      );
  }
}

function parseFailures(value: string | null): NonNullable<GoalRuntimeRecord["failures"]> {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? (parsed as NonNullable<GoalRuntimeRecord["failures"]>)
      : [];
  } catch {
    return [];
  }
}

/** Dedupe and vote aggregation are enforced by the primary keys, not memory. */
export class SqliteProposalRepository implements ProposalRepository {
  private readonly db: DatabaseSync;
  private readonly context: SessionContext;

  constructor(db: DatabaseSync, context: SessionContext) {
    this.db = db;
    this.context = context;
  }

  insert(proposal: Proposal): Proposal | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT id FROM proposal WHERE session_id = ? AND source_event_id = ?")
        .get(this.context.sessionId, proposal.sourceEventId) as { id: string } | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .prepare(
          `INSERT INTO proposal
             (id, session_id, source_event_id, audience_ref, text, normalized_text,
              votes, intent, status, reason, risk, goal_alignment,
              created_at_ms, decided_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          proposal.id,
          this.context.sessionId,
          proposal.sourceEventId,
          proposal.audienceRef,
          proposal.text,
          normalize(proposal.text),
          proposal.votes,
          proposal.intent,
          proposal.status,
          proposal.reason,
          proposal.risk,
          proposal.goalAlignment,
          proposal.createdAt,
          proposal.decidedAt,
        );
      this.db.exec("COMMIT");
      return proposal;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  update(proposal: Proposal): void {
    this.db
      .prepare(
        `UPDATE proposal
         SET votes = ?, status = ?, reason = ?, risk = ?, goal_alignment = ?,
             decided_at_ms = ?
         WHERE id = ? AND session_id = ?`,
      )
      .run(
        proposal.votes,
        proposal.status,
        proposal.reason,
        proposal.risk,
        proposal.goalAlignment,
        proposal.decidedAt,
        proposal.id,
        this.context.sessionId,
      );
  }

  get(id: string): Proposal | null {
    const row = this.db
      .prepare("SELECT * FROM proposal WHERE id = ? AND session_id = ?")
      .get(id, this.context.sessionId) as ProposalRow | undefined;
    return row === undefined ? null : parseProposal(row);
  }

  list(status: ProposalStatus | null, limit: number): readonly Proposal[] {
    const rows = (status === null
      ? this.db
          .prepare(
            `SELECT * FROM proposal WHERE session_id = ?
             ORDER BY created_at_ms DESC LIMIT ?`,
          )
          .all(this.context.sessionId, limit)
      : this.db
          .prepare(
            `SELECT * FROM proposal WHERE session_id = ? AND status = ?
             ORDER BY created_at_ms DESC LIMIT ?`,
          )
          .all(this.context.sessionId, status, limit)) as unknown as ProposalRow[];
    return rows.map(parseProposal);
  }

  findRecentByText(normalizedText: string, since: number): Proposal | null {
    const row = this.db
      .prepare(
        `SELECT * FROM proposal
         WHERE session_id = ? AND normalized_text = ?
           AND created_at_ms >= ?
         ORDER BY created_at_ms DESC LIMIT 1`,
      )
      .get(this.context.sessionId, normalizedText, since) as ProposalRow | undefined;
    return row === undefined ? null : parseProposal(row);
  }

  addVote(input: {
    readonly proposalId: string;
    readonly sourceEventId: string;
    readonly audienceRef: string;
    readonly at: number;
  }): number | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.db
        .prepare(
          `SELECT 1 AS present FROM proposal_vote
           WHERE proposal_id = ? AND source_event_id = ?`,
        )
        .get(input.proposalId, input.sourceEventId);
      if (duplicate) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .prepare(
          `INSERT INTO proposal_vote
             (proposal_id, source_event_id, audience_ref, created_at_ms)
           VALUES (?, ?, ?, ?)`,
        )
        .run(input.proposalId, input.sourceEventId, input.audienceRef, input.at);
      this.db
        .prepare("UPDATE proposal SET votes = votes + 1 WHERE id = ?")
        .run(input.proposalId);
      const row = this.db
        .prepare("SELECT votes FROM proposal WHERE id = ?")
        .get(input.proposalId) as { votes: number } | undefined;
      this.db.exec("COMMIT");
      return row?.votes ?? null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

interface ProposalRow {
  readonly id: string;
  readonly source_event_id: string;
  readonly audience_ref: string;
  readonly text: string;
  readonly votes: number;
  readonly intent: Proposal["intent"];
  readonly status: ProposalStatus;
  readonly reason: string;
  readonly risk: Proposal["risk"];
  readonly goal_alignment: Proposal["goalAlignment"];
  readonly created_at_ms: number;
  readonly decided_at_ms: number | null;
}

function parseProposal(row: ProposalRow): Proposal {
  const parsed = proposalSchema.parse({
    id: row.id,
    sourceEventId: row.source_event_id,
    audienceRef: row.audience_ref,
    text: row.text,
    votes: row.votes,
    intent: row.intent,
    status: row.status,
    reason: row.reason,
    risk: row.risk,
    goalAlignment: row.goal_alignment,
    createdAt: row.created_at_ms,
    decidedAt: row.decided_at_ms,
  });
  return parsed;
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/** Re-exported for type-only consumers that do not import the agent package. */
export type { GoalProgress, Proposal, SeasonGoal };
