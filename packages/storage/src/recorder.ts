import type { AudienceEvent, Decision } from "@craftmate/contracts";
import type { DatabaseSync } from "node:sqlite";
import type { ShowRecorder } from "@craftmate/agent/application";
import { DecisionStore, type SessionContext, SourceStore } from "./stores.ts";

/**
 * Bridges the domain's write port onto SQLite. Kept here rather than in the
 * domain so `packages/agent` never depends on a database driver.
 */
export class SqliteRecorder implements ShowRecorder {
  private readonly sources: SourceStore;
  private readonly decisions: DecisionStore;
  private readonly context: SessionContext;
  private readonly sourceIds = new Map<string, string>();

  constructor(db: DatabaseSync, context: SessionContext) {
    this.context = context;
    this.sources = new SourceStore(db);
    this.decisions = new DecisionStore(db);
  }

  recordSource(event: AudienceEvent): boolean {
    const { id, inserted } = this.sources.append(this.context.sessionId, event);
    this.sourceIds.set(event.id, id);
    return inserted;
  }

  recordDecision(decision: Decision): void {
    const sourceId = this.sourceIds.get(decision.eventId);
    if (!sourceId) throw new Error(`decision ${decision.id} has no stored source`);
    this.decisions.append(this.context, sourceId, decision, decision.eventId);
  }
}
