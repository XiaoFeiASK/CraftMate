import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export interface OpenOptions {
  /** Absolute path, or `:memory:` for tests. */
  readonly file: string;
  /** Directory holding `*.sql` migrations. Defaults to the repo's `db/migrations`. */
  readonly migrationsDir?: string;
  /** Open an already-migrated database read-only without applying migrations. */
  readonly skipMigrations?: boolean;
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const DEFAULT_MIGRATIONS = join(
  dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))),
  "db",
  "migrations",
);

/**
 * Opens the database, applies pending migrations, and fails loudly on drift.
 *
 * Silently tolerating a checksum mismatch is the one failure mode that turns a
 * schema change into a corrupted money trail, so it throws instead.
 */
export function openDatabase(options: OpenOptions): DatabaseSync {
  const db = new DatabaseSync(options.file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (options.file !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  if (!options.skipMigrations) migrate(db, options.migrationsDir ?? DEFAULT_MIGRATIONS);
  return db;
}

export function loadMigrations(dir: string): readonly Migration[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), "utf8");
      const version = Number(name.slice(0, 4));
      if (!Number.isInteger(version) || version <= 0) {
        throw new Error(`migration ${name} must start with a positive 4-digit version`);
      }
      return {
        version,
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

function migrate(db: DatabaseSync, dir: string): void {
  const migrations = loadMigrations(resolve(dir));

  const applied = new Map<number, string>();
  // The first migration creates `schema_migration` itself, so the table is
  // absent on a fresh database. Absent means "nothing applied yet", not "broken".
  const hasLedger =
    db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'")
      .get() as { n: number };
  if (hasLedger.n > 0) {
    for (const row of db.prepare("SELECT version, checksum FROM schema_migration").all() as {
      version: number;
      checksum: string;
    }[]) {
      applied.set(row.version, row.checksum);
    }
  }

  for (const migration of migrations) {
    const existing = applied.get(migration.version);
    if (existing !== undefined) {
      if (existing !== migration.checksum) {
        throw new Error(
          `migration ${migration.name} changed after being applied ` +
            `(stored ${existing.slice(0, 12)}, file ${migration.checksum.slice(0, 12)})`,
        );
      }
      continue;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migration (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)",
      ).run(migration.version, migration.name, migration.checksum, Date.now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
