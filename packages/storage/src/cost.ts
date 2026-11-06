import type { DatabaseSync } from "node:sqlite";
import type { Budget } from "@craftmate/contracts";

/**
 * Token/price accounting for the model. Costs are recorded per call so the
 * hourly rollup is a query, not a counter that resets on restart.
 */
export class CostStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  record(entry: {
    readonly sessionId: string;
    readonly provider: string;
    readonly model: string;
    readonly cost: number;
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly at?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO model_cost (
           id, session_id, provider, model, cost,
           prompt_tokens, completion_tokens, occurred_at_ms
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        entry.sessionId,
        entry.provider,
        entry.model,
        entry.cost,
        entry.promptTokens ?? 0,
        entry.completionTokens ?? 0,
        entry.at ?? Date.now(),
      );
  }

  /** Rolling window, so an hour of spend does not require a cron reset. */
  spentSince(at: number): number {
    const row = this.db
      .prepare("SELECT coalesce(sum(cost), 0) AS total FROM model_cost WHERE occurred_at_ms >= ?")
      .get(at) as { total: number };
    return row.total;
  }

  spentByKey(provider: string): number {
    const row = this.db
      .prepare("SELECT coalesce(sum(cost), 0) AS total FROM model_cost WHERE provider = ?")
      .get(provider) as { total: number };
    return row.total;
  }

  /** Determines whether the next call must degrade to the template. */
  budget(options: {
    readonly hourlyLimit: number;
    readonly keyLimit: number;
    readonly provider: string;
    readonly now?: number;
  }): Budget {
    const windowStart = (options.now ?? Date.now()) - 60 * 60 * 1000;
    const hourly = this.spentSince(windowStart);
    const keyed = this.spentByKey(options.provider);
    const hourlyExceeded = options.hourlyLimit > 0 && hourly >= options.hourlyLimit;
    const keyExceeded = options.keyLimit > 0 && keyed >= options.keyLimit;
    return {
      hourlyLimit: options.hourlyLimit,
      keyLimit: options.keyLimit,
      spent: hourly,
      degraded: hourlyExceeded || keyExceeded,
      detail: hourlyExceeded
        ? `本小时已用 ${hourly.toFixed(2)}，超过上限 ${options.hourlyLimit}`
        : keyExceeded
          ? `该 Key 累计 ${keyed.toFixed(2)}，超过上限 ${options.keyLimit}`
          : "",
    };
  }
}
