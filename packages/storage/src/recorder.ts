import type { AudienceEvent, Decision, Proposal } from "@craftmate/contracts";
import type { DatabaseSync } from "node:sqlite";
import type { ShowRecorder } from "@craftmate/agent/application";
import { DecisionStore, type SessionContext, SourceStore } from "./stores.ts";
import { SqliteProposalRepository } from "./goals.ts";

const MAX_SOURCE_CACHE = 1_000;

/**
 * Bridges the domain's write port onto SQLite. Kept here rather than in the
 * domain so `packages/agent` never depends on a database driver.
 */
export class SqliteRecorder implements ShowRecorder {
  private readonly db: DatabaseSync;
  private readonly sources: SourceStore;
  private readonly decisions: DecisionStore;
  private readonly context: SessionContext;
  private readonly sourceIds = new Map<string, string>();
  private readonly proposals: SqliteProposalRepository;

  constructor(db: DatabaseSync, context: SessionContext) {
    this.db = db;
    this.context = context;
    this.sources = new SourceStore(db);
    this.decisions = new DecisionStore(db);
    this.proposals = new SqliteProposalRepository(db, context);
  }

  recordSource(event: AudienceEvent): boolean {
    const { id, inserted } = this.sources.append(this.context.sessionId, event);
    if (inserted) {
      this.sourceIds.set(event.id, id);
      while (this.sourceIds.size > MAX_SOURCE_CACHE) {
        const oldest = this.sourceIds.keys().next().value;
        if (oldest === undefined) break;
        this.sourceIds.delete(oldest);
      }
    }
    return inserted;
  }

  recordDecision(decision: Decision): void {
    const sourceId = this.findSourceId(decision.eventId);
    if (!sourceId) throw new Error(`decision ${decision.id} has no stored source`);
    this.decisions.append(this.context, sourceId, decision, decision.eventId);
  }

  /**
   * Stage C rewrites the row it already created. Keeping the id stable means a
   * replay shows one decision, not a template followed by a correction.
   */
  updateDecision(decision: Decision): void {
    this.decisions.update(decision);
  }

  recordProposal(proposal: Proposal): void {
    this.proposals.insert(proposal);
  }

  updateProposal(proposal: Proposal): void {
    this.proposals.update(proposal);
  }

  /**
   * Evicted cache entries are recovered from the database, which is also what
   * makes a decision traceable after a process restart.
   */
  findSourceId(eventId: string): string | undefined {
    // Check cache first for fast path
    const cached = this.sourceIds.get(eventId);
    if (cached) return cached;
    // Fall back to database lookup
    const row = this.db
      .prepare(
        `SELECT id FROM source
         WHERE session_id = ? AND external_event_id = ?
         ORDER BY received_at_ms DESC LIMIT 1`,
      )
      .get(this.context.sessionId, eventId) as { id: string } | undefined;
    return row?.id;
  }
}
