import { DatabaseSync } from "node:sqlite";

/**
 * Read-only proof that a commitment is still open.
 *
 * Voice runs in its own process, so "the orchestrator said so" is not
 * evidence. It opens the live database read-only and fails closed: a missing
 * file, a locked database, or an unknown id all refuse playback.
 */
export class SqliteCommitmentGate {
  private readonly file: string;
  private db: DatabaseSync | null = null;

  constructor(file: string) {
    this.file = file;
  }

  isReserved(commitmentId: string): boolean {
    try {
      const row = this.open()
        .prepare(
          `SELECT 1 AS ok FROM commitment
           WHERE id = ? AND status IN ('proposed', 'spoken', 'accepted', 'in_progress')`,
        )
        .get(commitmentId) as { ok: number } | undefined;
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private open(): DatabaseSync {
    if (this.db === null) {
      this.db = new DatabaseSync(this.file, { readOnly: true });
      this.db.exec("PRAGMA busy_timeout = 2000");
    }
    return this.db;
  }
}
