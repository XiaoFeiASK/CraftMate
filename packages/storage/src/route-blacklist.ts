import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  routeBlacklistDraftSchema,
  routeBlacklistQuerySchema,
  routeBlacklistSchema,
  routeBlacklistCovers,
  type RouteBlacklist,
  type RouteBlacklistDraft,
  type RouteBlacklistQueryInput,
} from "@craftmate/contracts";
import type { SessionContext } from "./stores.ts";

interface RouteBlacklistRow {
  readonly id: string;
  readonly session_id: string | null;
  readonly dimension: string;
  readonly kind: RouteBlacklist["kind"];
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly target_ref: string | null;
  readonly reason_code: string;
  readonly reason_detail: string | null;
  readonly source: RouteBlacklist["source"];
  readonly expires_at_ms: number | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

/** Durable route refusals, scoped to the current show session. */
export class RouteBlacklistStore {
  private readonly db: DatabaseSync;
  private readonly context: SessionContext;

  constructor(db: DatabaseSync, context: SessionContext) {
    this.db = db;
    this.context = context;
  }

  record(input: RouteBlacklistDraft, at = Date.now()): RouteBlacklist {
    const draft = routeBlacklistDraftSchema.parse(input);
    const id = createHash("sha256")
      .update(
        [
          this.context.sessionId,
          draft.kind,
          draft.dimension,
          String(draft.x),
          String(draft.y),
          String(draft.z),
          draft.targetRef ?? "",
        ].join("\u0000"),
      )
      .digest("hex")
      .slice(0, 24);
    this.db
      .prepare(
        `INSERT INTO route_blacklist
           (id, session_id, dimension, kind, x, y, z, radius, target_ref,
            reason_code, reason_detail, source, expires_at_ms,
            created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           radius = excluded.radius,
           reason_code = excluded.reason_code,
           reason_detail = excluded.reason_detail,
           source = excluded.source,
           expires_at_ms = excluded.expires_at_ms,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        id,
        this.context.sessionId,
        draft.dimension,
        draft.kind,
        draft.x,
        draft.y,
        draft.z,
        draft.radius,
        draft.targetRef,
        draft.reasonCode,
        draft.reasonDetail,
        draft.source,
        draft.expiresAt,
        at,
        at,
      );
    return this.get(id) ?? this.fromDraft(id, draft, at);
  }

  list(includeExpired = false, limit = 64, now = Date.now()): readonly RouteBlacklist[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM route_blacklist
         WHERE session_id = ?
           AND (? = 1 OR expires_at_ms IS NULL OR expires_at_ms > ?)
         ORDER BY updated_at_ms DESC, rowid DESC
         LIMIT ?`,
      )
      .all(
        this.context.sessionId,
        includeExpired ? 1 : 0,
        now,
        limit,
      ) as unknown as RouteBlacklistRow[];
    return rows.map((row) => this.toEntry(row));
  }

  active(query: RouteBlacklistQueryInput = {}, now = Date.now()): readonly RouteBlacklist[] {
    const parsed = routeBlacklistQuerySchema.parse(query);
    return this.list(parsed.includeExpired, parsed.limit, now)
      .filter(
        (entry) =>
          (parsed.dimension === undefined || entry.dimension === parsed.dimension) &&
          (parsed.position === undefined ||
            routeBlacklistCovers(entry, parsed.position, now)),
      )
      .slice(0, parsed.limit);
  }

  get(id: string): RouteBlacklist | null {
    const row = this.db
      .prepare("SELECT * FROM route_blacklist WHERE id = ? AND session_id = ?")
      .get(id, this.context.sessionId) as RouteBlacklistRow | undefined;
    return row === undefined ? null : this.toEntry(row);
  }

  forget(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM route_blacklist WHERE id = ? AND session_id = ?")
      .run(id, this.context.sessionId);
    return Number(result.changes) > 0;
  }

  /**
   * A confirmed arrival proves the route is usable again. Hazard rows also
   * clear here because this method is only called after a successful body
   * observation at that position, not from an optimistic planner guess.
   */
  clearCovering(
    dimension: string,
    point: { readonly x: number; readonly y: number; readonly z: number },
    now = Date.now(),
  ): number {
    const rows = this.active({ dimension, position: point, includeExpired: false, limit: 256 }, now);
    let removed = 0;
    for (const row of rows) {
      if (routeBlacklistCovers(row, point, now) && this.forget(row.id)) removed += 1;
    }
    return removed;
  }

  private toEntry(row: RouteBlacklistRow): RouteBlacklist {
    return routeBlacklistSchema.parse({
      id: row.id,
      sessionId: row.session_id,
      dimension: row.dimension,
      kind: row.kind,
      x: row.x,
      y: row.y,
      z: row.z,
      radius: row.radius,
      targetRef: row.target_ref,
      reasonCode: row.reason_code,
      reasonDetail: row.reason_detail,
      source: row.source,
      expiresAt: row.expires_at_ms,
      createdAt: row.created_at_ms,
      updatedAt: row.updated_at_ms,
    });
  }

  private fromDraft(
    id: string,
    draft: RouteBlacklistDraft,
    at: number,
  ): RouteBlacklist {
    return routeBlacklistSchema.parse({
      id,
      sessionId: this.context.sessionId,
      ...draft,
      createdAt: at,
      updatedAt: at,
    });
  }
}
