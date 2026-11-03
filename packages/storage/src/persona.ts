import type { DatabaseSync } from "node:sqlite";
import type { PersonaVersion } from "@craftmate/contracts";

/**
 * Append-only persona history. A rollback retires the current row and reactivates
 * an older revision; it never overwrites content, so the text that produced a
 * past decision stays inspectable.
 */
export class PersonaVersionStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  active(personaId: string): { version: PersonaVersion; content: Record<string, unknown> } | null {
    const row = this.db
      .prepare(
        `SELECT id, persona_id, revision, state, created_at_ms, content_json
         FROM persona_version WHERE persona_id = ? AND state = 'active'`,
      )
      .get(personaId) as
      | {
          id: string;
          persona_id: string;
          revision: number;
          state: "active";
          created_at_ms: number;
          content_json: string;
        }
      | undefined;
    if (!row) return null;
    return {
      version: toVersion(row),
      content: JSON.parse(row.content_json) as Record<string, unknown>,
    };
  }

  /**
   * Writes a new draft revision and immediately activates it. The caller is
   * responsible for validating content; storage never guesses at persona shape.
   */
  publish(personaKey: string, content: Record<string, unknown>): PersonaVersion {
    const persona = this.db
      .prepare("SELECT id FROM persona WHERE persona_key = ?")
      .get(personaKey) as { id: string } | undefined;
    if (!persona) throw new Error(`unknown persona ${personaKey}`);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const next = this.db
        .prepare("SELECT coalesce(max(revision), 0) + 1 AS n FROM persona_version WHERE persona_id = ?")
        .get(persona.id) as { n: number };
      this.db
        .prepare("UPDATE persona_version SET state = 'retired' WHERE persona_id = ? AND state = 'active'")
        .run(persona.id);
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO persona_version
             (id, persona_id, revision, content_json, state, created_at_ms)
           VALUES (?, ?, ?, ?, 'active', ?)`,
        )
        .run(id, persona.id, next.n, JSON.stringify(content), Date.now());
      this.db.exec("COMMIT");
      return { id, personaId: persona.id, revision: next.n, state: "active", createdAt: Date.now() };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Creates a retired draft without touching the active row, so the operator
   * can preview it before publishing.
   */
  draft(personaKey: string, content: Record<string, unknown>): PersonaVersion {
    const persona = this.db
      .prepare("SELECT id FROM persona WHERE persona_key = ?")
      .get(personaKey) as { id: string } | undefined;
    if (!persona) throw new Error(`unknown persona ${personaKey}`);
    const next = this.db
      .prepare("SELECT coalesce(max(revision), 0) + 1 AS n FROM persona_version WHERE persona_id = ?")
      .get(persona.id) as { n: number };
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO persona_version
           (id, persona_id, revision, content_json, state, created_at_ms)
         VALUES (?, ?, ?, ?, 'retired', ?)`,
      )
      .run(id, persona.id, next.n, JSON.stringify(content), now);
    return { id, personaId: persona.id, revision: next.n, state: "retired", createdAt: now };
  }

  /** Activates an existing revision. History rows are never deleted. */
  activate(personaKey: string, versionId: string): PersonaVersion {
    const persona = this.db
      .prepare("SELECT id FROM persona WHERE persona_key = ?")
      .get(personaKey) as { id: string } | undefined;
    if (!persona) throw new Error(`unknown persona ${personaKey}`);
    const target = this.db
      .prepare("SELECT id, revision, created_at_ms FROM persona_version WHERE id = ? AND persona_id = ?")
      .get(versionId, persona.id) as { id: string; revision: number; created_at_ms: number } | undefined;
    if (!target) throw new Error(`unknown persona version ${versionId}`);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE persona_version SET state = 'retired' WHERE persona_id = ? AND state = 'active'")
        .run(persona.id);
      this.db.prepare("UPDATE persona_version SET state = 'active' WHERE id = ?").run(versionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      id: target.id,
      personaId: persona.id,
      revision: target.revision,
      state: "active",
      createdAt: target.created_at_ms,
    };
  }

  history(personaKey: string): readonly (PersonaVersion & { content: Record<string, unknown> })[] {
    const rows = this.db
      .prepare(
        `SELECT v.id, v.persona_id, v.revision, v.state, v.created_at_ms, v.content_json
         FROM persona_version v
         JOIN persona p ON p.id = v.persona_id
         WHERE p.persona_key = ?
         ORDER BY v.revision DESC`,
      )
      .all(personaKey) as {
      id: string;
      persona_id: string;
      revision: number;
      state: "active" | "retired";
      created_at_ms: number;
      content_json: string;
    }[];
    return rows.map((row) => ({
      ...toVersion(row),
      content: JSON.parse(row.content_json) as Record<string, unknown>,
    }));
  }
}

function toVersion(row: {
  id: string;
  persona_id: string;
  revision: number;
  state: "active" | "retired";
  created_at_ms: number;
}): PersonaVersion {
  return {
    id: row.id,
    personaId: row.persona_id,
    revision: row.revision,
    state: row.state,
    createdAt: row.created_at_ms,
  };
}
