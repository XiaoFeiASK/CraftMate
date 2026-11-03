import type { DatabaseSync } from "node:sqlite";
import type { BridgeErrorCode, SkillCommand } from "@craftmate/contracts";
import type { ActionPort, BridgeTerminalStatus } from "./types.ts";

interface ActionAttemptRow {
  id: string;
  status: string;
}

/**
 * Adapter onto A's existing `action_attempt` table. The Bridge never gets a
 * raw database handle: this port is constructed by the orchestrator owner and
 * only exposes begin/settle.
 */
export class SqliteActionPort implements ActionPort {
  private readonly db: DatabaseSync;
  private readonly sessionId: string;
  private readonly fallbackDecisionId: string | null;
  private readonly fallbackPriority: SkillCommand["priority"];

  constructor(
    db: DatabaseSync,
    options: {
      readonly sessionId: string;
      /** Used only when the command itself carries no decisionId. */
      readonly decisionId?: string;
      readonly priority?: SkillCommand["priority"];
    },
  ) {
    this.db = db;
    this.sessionId = options.sessionId;
    this.fallbackDecisionId = options.decisionId ?? null;
    this.fallbackPriority = options.priority ?? "command";
  }

  begin(command: SkillCommand): { id: string; created: boolean } {
    const existing = this.db
      .prepare("SELECT id, status FROM action_attempt WHERE idempotency_key = ?")
      .get(command.idempotencyKey) as ActionAttemptRow | undefined;
    if (existing) return { id: existing.id, created: false };

    const decisionId = command.decisionId ?? this.fallbackDecisionId;
    if (decisionId === null) {
      throw new Error(`action ${command.idempotencyKey} has no decision to attach to`);
    }
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
        this.sessionId,
        decisionId,
        command.op,
        JSON.stringify(command.args),
        this.fallbackPriority,
        command.idempotencyKey,
        command.deadlineTick ?? null,
        Date.now(),
      );
    return { id, created: true };
  }

  settle(
    attemptId: string,
    status: BridgeTerminalStatus,
    errorCode?: BridgeErrorCode,
    result?: Readonly<Record<string, unknown>>,
  ): void {
    // The port only receives terminal states; finished_at_ms is always set.
    const terminal = true;
    this.db
      .prepare(
        `UPDATE action_attempt
         SET status = ?, started_at_ms = coalesce(started_at_ms, ?),
             finished_at_ms = ?, error_code = ?, result_json = ?
         WHERE id = ?`,
      )
      .run(
        status,
        Date.now(),
        terminal ? Date.now() : null,
        errorCode ?? null,
        result === undefined ? null : JSON.stringify(result),
        attemptId,
      );
  }
}
