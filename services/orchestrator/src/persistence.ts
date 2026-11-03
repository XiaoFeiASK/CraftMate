import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CommitmentLedger, Show, dafeiyu, type Persona } from "@craftmate/agent";
import { showSettingsSchema } from "@craftmate/contracts";
import {
  CommitmentStore,
  DecisionStore,
  SettingsStore,
  SessionStore,
  SourceStore,
  SqliteRecorder,
  openDatabase,
  type SessionContext,
} from "@craftmate/storage";
import type { Decision } from "@craftmate/contracts";

export interface PersistentShow {
  readonly show: Show;
  readonly context: SessionContext;
  /** Persists a settings edit, then applies it to the running show. */
  saveSettings(next: unknown): ReturnType<Show["currentSettings"]> | null;
  /** Purges expired raw text and writes one audit row per source. */
  expireRawText(now?: number): number;
  close(): void;
}

const DEFAULT_GOAL = "盖一间带床和箱子的海崖小屋";

/**
 * Builds the show on top of SQLite. Any failure here is fatal on purpose: a
 * live show that silently runs without its evidence trail is worse than a
 * show that refuses to start.
 */
export function createPersistentShow(options: {
  readonly persona?: Persona;
  readonly dbPath?: string;
  readonly goalText?: string;
} = {}): PersistentShow {
  const persona = options.persona ?? dafeiyu;
  const db = openDatabase({ file: options.dbPath ?? defaultDatabasePath() });
  const context = new SessionStore(db).bootstrap(persona, options.goalText ?? DEFAULT_GOAL);
  const decisions = new DecisionStore(db);
  const settingsStore = new SettingsStore(db);
  const commitments = new CommitmentStore(db, context);
  const sources = new SourceStore(db);
  const history = decisions.recent(context.sessionId, 50);
  const totals = decisions.counts(context.sessionId);
  const stored = showSettingsSchema.safeParse(settingsStore.read(context.sessionId));
  const ledger = new CommitmentLedger({ journal: commitments });
  ledger.restore(commitments.open());

  const show = new Show({
    persona,
    ...(stored.success ? { settings: stored.data } : {}),
    goalText: options.goalText ?? DEFAULT_GOAL,
    recorder: new SqliteRecorder(db, context),
    ledger,
    history: history.reverse(),
    totals: { ...totals, openCommitments: commitments.openCount() },
  });

  return {
    show,
    context,
    saveSettings: (next) => {
      const parsed = showSettingsSchema.safeParse(next);
      // A rejected edit must leave the running show untouched: silently
      // clamping a bad value makes the operator think it was applied.
      if (!parsed.success) return null;
      settingsStore.write(context.sessionId, parsed.data);
      return show.updateSettings(parsed.data);
    },
    expireRawText: (now) => sources.expireRawText(now),
    close: () => db.close(),
  };
}

/** `~/.craftmate/craftmate.db`, overridable for tests and Docker. */
export function defaultDatabasePath(): string {
  if (process.env.CRAFTMATE_DB) return process.env.CRAFTMATE_DB;
  if (process.env.CRAFTMATE_DB_DIR) {
    const dir = process.env.CRAFTMATE_DB_DIR;
    mkdirSync(dir, { recursive: true });
    return join(dir, "craftmate.db");
  }
  const dir = join(homedir(), ".craftmate");
  mkdirSync(dir, { recursive: true });
  return join(dir, "craftmate.db");
}
