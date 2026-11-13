import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  strategyMemoryDraftSchema,
  strategyMemorySchema,
  worldMemoryDraftSchema,
  worldMemorySchema,
  worldMemoryUpdateSchema,
  type StrategyMemory,
  type StrategyMemoryDraft,
  type WorldMemory,
  type WorldMemoryDraft,
  type WorldMemoryKind,
  type WorldMemoryQuery,
  type WorldMemoryUpdate,
} from "@craftmate/contracts";
import type { WorldFacts } from "@craftmate/agent";
import type { SessionContext } from "./stores.ts";

interface WorldMemoryRow {
  readonly id: string;
  readonly session_id: string | null;
  readonly kind: WorldMemoryKind;
  readonly label: string;
  readonly dimension: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly payload_json: string;
  readonly confidence: number;
  readonly source: WorldMemory["source"];
  readonly observed_at_ms: number;
  readonly expires_at_ms: number | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

const DEFAULT_DIMENSION = "minecraft:overworld";
const RECENCY_HALF_LIFE_MS = 6 * 60 * 60 * 1_000;

export function canonicalDimension(value: string | null | undefined): string {
  const lower = value?.toLowerCase() ?? "";
  if (lower.includes("the_nether") || lower.includes("nether")) {
    return "minecraft:the_nether";
  }
  if (lower.includes("the_end") || lower === "end") {
    return "minecraft:the_end";
  }
  return DEFAULT_DIMENSION;
}

/**
 * Landmark store. Distance is applied at recall time rather than in SQL
 * because SQLite has no portable 3D distance operator and the bounded catalog
 * is small. The unique place index makes repeated body observations idempotent.
 */
export class WorldMemoryStore {
  private readonly db: DatabaseSync;
  private readonly context: SessionContext;
  private lastFactsSignature: string | null = null;

  constructor(db: DatabaseSync, context: SessionContext) {
    this.db = db;
    this.context = context;
  }

  observe(input: WorldMemoryDraft): WorldMemory {
    const draft = worldMemoryDraftSchema.parse(input);
    const now = Date.now();
    const existing = this.db
      .prepare(
        `SELECT * FROM world_memory
         WHERE session_id = ? AND kind = ? AND dimension = ? AND x = ? AND y = ? AND z = ?`,
      )
      .get(
        this.context.sessionId,
        draft.kind,
        draft.dimension,
        draft.x,
        draft.y,
        draft.z,
      ) as WorldMemoryRow | undefined;
    if (existing !== undefined) {
      // Operator corrections win over later body observations.
      if (existing.source !== "operator" || draft.source === "operator") {
        this.db
          .prepare(
            `UPDATE world_memory
             SET label = ?, payload_json = ?, confidence = ?, source = ?,
                 observed_at_ms = ?, expires_at_ms = ?, updated_at_ms = ?
             WHERE id = ?`,
          )
          .run(
            draft.label,
            JSON.stringify(draft.payload),
            draft.confidence,
            draft.source,
            draft.observedAt,
            draft.expiresAt,
            now,
            existing.id,
          );
      }
      return this.get(existing.id) ?? this.toMemory(existing);
    }
    const id = stableId([
      this.context.sessionId,
      draft.kind,
      draft.dimension,
      String(draft.x),
      String(draft.y),
      String(draft.z),
    ]);
    this.db
      .prepare(
        `INSERT INTO world_memory
           (id, session_id, kind, label, dimension, x, y, z, payload_json,
            confidence, source, observed_at_ms, expires_at_ms,
            created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.context.sessionId,
        draft.kind,
        draft.label,
        draft.dimension,
        draft.x,
        draft.y,
        draft.z,
        JSON.stringify(draft.payload),
        draft.confidence,
        draft.source,
        draft.observedAt,
        draft.expiresAt,
        now,
        now,
      );
    const stored = this.get(id);
    if (stored === null) throw new Error("world memory insert did not persist");
    return stored;
  }

  /**
   * Body facts are a cheap, idempotent source. A signature gate avoids a write
   * on every planning boundary while still recording a moved camp or new mine.
   */
  observeFacts(facts: WorldFacts, at = Date.now()): readonly WorldMemory[] {
    if (!facts.inWorld) return [];
    const dimension = canonicalDimension(facts.world ?? facts.dimension);
    const landmarks: WorldMemoryDraft[] = [];
    const add = (
      kind: WorldMemoryKind,
      label: string,
      point: { readonly x: number; readonly y: number; readonly z: number } | null | undefined,
      confidence = 0.9,
      payload: Record<string, unknown> = {},
    ): void => {
      if (point === null || point === undefined) return;
      landmarks.push({
        kind,
        label,
        dimension,
        x: point.x,
        y: point.y,
        z: point.z,
        payload,
        confidence,
        source: "body",
        observedAt: at,
        expiresAt: null,
      });
    };
    add("home", "营地", facts.shelter ?? facts.bed ?? facts.chest);
    add("bed", "床", facts.bed);
    add("container", "营地箱子", facts.chest, 0.95, {
      inventory: facts.inventory.map((slot) => ({
        section: slot.section,
        slot: slot.slot,
        item: slot.item,
        count: slot.count,
      })),
      chestEmptySlots: facts.chestEmptySlots ?? null,
      snapshotAt: at,
    });
    add("furnace", "熔炉", facts.furnace);
    add("crafting_table", "工作台", facts.craftingTable);
    add("mine", "矿洞入口", facts.mineEntrance);
    for (const block of facts.nearbyBlocks ?? []) {
      if (block.x === undefined || block.y === undefined || block.z === undefined) continue;
      const point = { x: block.x, y: block.y, z: block.z };
      if (block.id === "minecraft:iron_ore") {
        add("resource", "可见铁矿", point, 0.75);
      }
      if (block.id === "minecraft:lava") {
        add("hazard", "岩浆", point, 1);
      }
      if (block.id === "minecraft:crafting_table") {
        add("crafting_table", "工作台", point, 0.85);
      }
      if (block.id === "minecraft:nether_portal") {
        add("portal", "下界传送门", point, 0.9);
      }
    }
    if (landmarks.length === 0) return [];
    const signature = JSON.stringify(landmarks);
    if (signature === this.lastFactsSignature) return [];
    this.lastFactsSignature = signature;
    return landmarks.map((draft) => this.observe(draft));
  }

  recall(query: WorldMemoryQuery): readonly WorldMemory[] {
    const parsed = {
      ...query,
      limit: query.limit ?? 8,
    };
    const rows = this.db
      .prepare(
        `SELECT * FROM world_memory WHERE session_id = ?
         ORDER BY observed_at_ms DESC LIMIT 256`,
      )
      .all(this.context.sessionId) as unknown as WorldMemoryRow[];
    const now = Date.now();
    const kinds = parsed.kinds === undefined ? null : new Set(parsed.kinds);
    const dimension =
      parsed.dimension === undefined
        ? undefined
        : canonicalDimension(parsed.dimension);
    return rows
      .map((row) => this.toMemory(row))
      .filter(
        (memory) =>
          (dimension === undefined || memory.dimension === dimension) &&
          (kinds === null || kinds.has(memory.kind)),
      )
      .map((memory) => ({
        memory,
        score: recallScore(memory, parsed.position, now),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, parsed.limit)
      .map((entry) => entry.memory);
  }

  list(limit = 120): readonly WorldMemory[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM world_memory WHERE session_id = ?
         ORDER BY updated_at_ms DESC LIMIT ?`,
      )
      .all(this.context.sessionId, limit) as unknown as WorldMemoryRow[];
    return rows.map((row) => this.toMemory(row));
  }

  get(id: string): WorldMemory | null {
    const row = this.db
      .prepare("SELECT * FROM world_memory WHERE id = ? AND session_id = ?")
      .get(id, this.context.sessionId) as WorldMemoryRow | undefined;
    return row === undefined ? null : this.toMemory(row);
  }

  update(input: WorldMemoryUpdate): WorldMemory | null {
    const update = worldMemoryUpdateSchema.parse(input);
    const existing = this.get(update.id);
    if (existing === null) return null;
    const x = update.x ?? existing.x;
    const y = update.y ?? existing.y;
    const z = update.z ?? existing.z;
    const conflict = this.db
      .prepare(
        `SELECT id FROM world_memory
         WHERE session_id = ? AND kind = ? AND dimension = ? AND x = ? AND y = ? AND z = ?
           AND id <> ?`,
      )
      .get(
        this.context.sessionId,
        existing.kind,
        existing.dimension,
        x,
        y,
        z,
        existing.id,
      ) as { readonly id: string } | undefined;
    if (conflict !== undefined) {
      // An operator correction is authoritative. Moving a memory onto a stale
      // body-observed row replaces that row instead of throwing a UNIQUE error.
      this.db
        .prepare("DELETE FROM world_memory WHERE id = ? AND session_id = ?")
        .run(conflict.id, this.context.sessionId);
    }
    this.db
      .prepare(
        `UPDATE world_memory
         SET label = ?, x = ?, y = ?, z = ?, confidence = ?, source = 'operator',
             observed_at_ms = ?, expires_at_ms = NULL, updated_at_ms = ?
         WHERE id = ? AND session_id = ?`,
      )
      .run(
        update.label ?? existing.label,
        x,
        y,
        z,
        update.confidence ?? 1,
        Date.now(),
        Date.now(),
        update.id,
        this.context.sessionId,
      );
    return this.get(update.id);
  }

  forget(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM world_memory WHERE id = ? AND session_id = ?")
      .run(id, this.context.sessionId);
    return Number(result.changes) > 0;
  }

  private toMemory(row: WorldMemoryRow): WorldMemory {
    return worldMemorySchema.parse({
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      label: row.label,
      dimension: row.dimension,
      x: row.x,
      y: row.y,
      z: row.z,
      payload: parsePayload(row.payload_json),
      confidence: row.confidence,
      source: row.source,
      observedAt: row.observed_at_ms,
      expiresAt: row.expires_at_ms,
      createdAt: row.created_at_ms,
      updatedAt: row.updated_at_ms,
    });
  }
}

interface StrategyMemoryRow {
  readonly id: string;
  readonly session_id: string | null;
  readonly strategy_key: string;
  readonly stage: string;
  readonly card_id: string | null;
  readonly success_count: number;
  readonly failure_count: number;
  readonly last_failure_code: string | null;
  readonly last_failure_detail: string | null;
  readonly last_outcome_at_ms: number | null;
  readonly confidence: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export class StrategyMemoryStore {
  private readonly db: DatabaseSync;
  private readonly context: SessionContext;

  constructor(db: DatabaseSync, context: SessionContext) {
    this.db = db;
    this.context = context;
  }

  record(input: StrategyMemoryDraft): StrategyMemory {
    const draft = strategyMemoryDraftSchema.parse(input);
    const existing = this.db
      .prepare("SELECT * FROM strategy_memory WHERE session_id = ? AND strategy_key = ?")
      .get(this.context.sessionId, draft.strategyKey) as StrategyMemoryRow | undefined;
    const successes = (existing?.success_count ?? 0) + (draft.ok ? 1 : 0);
    const failures = (existing?.failure_count ?? 0) + (draft.ok ? 0 : 1);
    const confidence = Math.min(0.95, (successes + 1) / (successes + failures + 2));
    const id = existing?.id ?? stableId([this.context.sessionId, draft.strategyKey]);
    if (existing === undefined) {
      this.db
        .prepare(
          `INSERT INTO strategy_memory
             (id, session_id, strategy_key, stage, card_id, success_count,
              failure_count, last_failure_code, last_failure_detail,
              last_outcome_at_ms, confidence, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          this.context.sessionId,
          draft.strategyKey,
          draft.stage,
          draft.cardId,
          successes,
          failures,
          draft.failureCode,
          draft.failureDetail,
          draft.at,
          confidence,
          draft.at,
          draft.at,
        );
    } else {
      this.db
        .prepare(
          `UPDATE strategy_memory
           SET stage = ?, card_id = ?, success_count = ?, failure_count = ?,
               last_failure_code = ?, last_failure_detail = ?,
               last_outcome_at_ms = ?, confidence = ?, updated_at_ms = ?
           WHERE id = ?`,
        )
        .run(
          draft.stage,
          draft.cardId,
          successes,
          failures,
          draft.ok ? existing.last_failure_code : draft.failureCode,
          draft.ok ? existing.last_failure_detail : draft.failureDetail,
          draft.at,
          confidence,
          draft.at,
          id,
        );
    }
    const stored = this.get(id);
    if (stored === null) throw new Error("strategy memory write did not persist");
    return stored;
  }

  list(limit = 120): readonly StrategyMemory[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM strategy_memory WHERE session_id = ?
         ORDER BY updated_at_ms DESC LIMIT ?`,
      )
      .all(this.context.sessionId, limit) as unknown as StrategyMemoryRow[];
    return rows.map((row) => this.toMemory(row));
  }

  get(id: string): StrategyMemory | null {
    const row = this.db
      .prepare("SELECT * FROM strategy_memory WHERE id = ? AND session_id = ?")
      .get(id, this.context.sessionId) as StrategyMemoryRow | undefined;
    return row === undefined ? null : this.toMemory(row);
  }

  forget(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM strategy_memory WHERE id = ? AND session_id = ?")
      .run(id, this.context.sessionId);
    return Number(result.changes) > 0;
  }

  private toMemory(row: StrategyMemoryRow): StrategyMemory {
    return strategyMemorySchema.parse({
      id: row.id,
      sessionId: row.session_id,
      strategyKey: row.strategy_key,
      stage: row.stage,
      cardId: row.card_id,
      successCount: row.success_count,
      failureCount: row.failure_count,
      lastFailureCode: row.last_failure_code,
      lastFailureDetail: row.last_failure_detail,
      lastOutcomeAt: row.last_outcome_at_ms,
      confidence: row.confidence,
      createdAt: row.created_at_ms,
      updatedAt: row.updated_at_ms,
    });
  }
}

function recallScore(
  memory: WorldMemory,
  position: { readonly x: number; readonly y: number; readonly z: number } | undefined,
  now: number,
): number {
  const age = Math.max(0, now - memory.observedAt);
  const recency = 0.5 ** (age / RECENCY_HALF_LIFE_MS);
  const expired = memory.expiresAt !== null && memory.expiresAt <= now ? 0.25 : 1;
  const distance =
    position === undefined
      ? 1
      : 1 / (1 + Math.hypot(memory.x - position.x, memory.y - position.y, memory.z - position.z) / 64);
  return memory.confidence * recency * expired * distance;
}

function stableId(parts: readonly string[]): string {
  return `wm-${createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
