import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CommitmentLedger, Show, dafeiyu, type Persona } from "@craftmate/agent";
import { OpenAICompatibleProvider, Planner } from "@craftmate/agent/application";
import { showSettingsSchema } from "@craftmate/contracts";
import {
  CostStore,
  CommitmentStore,
  DecisionStore,
  MemoryStore,
  PersonaVersionStore,
  ReplayStore,
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
  readonly db: ReturnType<typeof openDatabase>;
  readonly memory: MemoryStore;
  readonly personas: PersonaVersionStore;
  readonly replay: ReplayStore;
  readonly costs: CostStore;
  /** Persists a settings edit, then applies it to the running show. */
  saveSettings(next: unknown): ReturnType<Show["currentSettings"]> | null;
  /** Purges expired raw text and writes one audit row per source. */
  expireRawText(now?: number): number;
  /** Records a model call so the hourly budget is a query, not a counter. */
  recordCost(provider: string, model: string, cost: number): void;
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
  /** Injected in tests; absent means "read the environment". */
  readonly env?: NodeJS.ProcessEnv;
} = {}): PersistentShow {
  const persona = options.persona ?? dafeiyu;
  const env = options.env ?? process.env;
  const db = openDatabase({ file: options.dbPath ?? defaultDatabasePath() });
  const context = new SessionStore(db).bootstrap(persona, options.goalText ?? DEFAULT_GOAL);
  const decisions = new DecisionStore(db);
  const settingsStore = new SettingsStore(db);
  const commitments = new CommitmentStore(db, context);
  const sources = new SourceStore(db);
  const memory = new MemoryStore(db, context.sessionId);
  const personas = new PersonaVersionStore(db);
  const replay = new ReplayStore(db);
  const costs = new CostStore(db);
  const history = decisions.recent(context.sessionId, 50);
  const totals = decisions.counts(context.sessionId);
  const stored = showSettingsSchema.safeParse(settingsStore.read(context.sessionId));
  const ledger = new CommitmentLedger({ journal: commitments });
  ledger.restore(commitments.open());

  const provider = modelProvider(env);

  const show = new Show({
    persona,
    ...(stored.success ? { settings: stored.data } : {}),
    goalText: options.goalText ?? DEFAULT_GOAL,
    recorder: new SqliteRecorder(db, context),
    ledger,
    memory,
    planner: new Planner({
      provider,
      deadlineMs: positiveInteger(env.CRAFTMATE_MODEL_TIMEOUT_MS, 1_000),
      overBudget: () => {
        if (provider === null) return false;
        const budget = costs.budget({
          hourlyLimit: Number(env.CRAFTMATE_MODEL_HOURLY_LIMIT ?? 0),
          keyLimit: Number(env.CRAFTMATE_MODEL_KEY_LIMIT ?? 0),
          provider: provider.id,
        });
        return budget.degraded;
      },
      onUsage: ({ provider: providerId, model, prompt, completion }) => {
        const price = provider?.pricePerMillion ?? { input: 0, output: 0 };
        const cost =
          (prompt / 1_000_000) * price.input + (completion / 1_000_000) * price.output;
        if (cost > 0) {
          costs.record({ sessionId: context.sessionId, provider: providerId, model, cost });
        }
      },
      onDegraded: (detail) => {
        console.warn(`orchestrator: planner degraded — ${detail}`);
      },
      onIncident: (incident) => {
        db.prepare(
          `INSERT INTO incident (id, session_id, severity, code, detail_json, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          crypto.randomUUID(),
          context.sessionId,
          incident.severity,
          incident.code,
          JSON.stringify(incident.detail),
          Date.now(),
        );
      },
    }),
    history: history.reverse(),
    totals: { ...totals, openCommitments: commitments.openCount() },
  });

  return {
    show,
    context,
    db,
    memory,
    personas,
    replay,
    costs,
    saveSettings: (next) => {
      const parsed = showSettingsSchema.safeParse(next);
      // A rejected edit must leave the running show untouched: silently
      // clamping a bad value makes the operator think it was applied.
      if (!parsed.success) return null;
      settingsStore.write(context.sessionId, parsed.data);
      return show.updateSettings(parsed.data);
    },
    expireRawText: (now) => sources.expireRawText(now),
    recordCost: (providerId, model, cost) => {
      if (cost <= 0) return;
      costs.record({ sessionId: context.sessionId, provider: providerId, model, cost });
    },
    close: () => db.close(),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A single OpenAI-compatible provider. Absent credentials mean "no model":
 * the show keeps running deterministically instead of failing to boot.
 */
function modelProvider(env: NodeJS.ProcessEnv): OpenAICompatibleProvider | null {
  const apiKey = env.CRAFTMATE_MODEL_KEY?.trim();
  const model = env.CRAFTMATE_MODEL?.trim();
  if (!apiKey || !model) return null;
  return new OpenAICompatibleProvider({
    id: env.CRAFTMATE_MODEL_PROVIDER?.trim() || "deepseek",
    baseUrl: env.CRAFTMATE_MODEL_URL?.trim() || "https://api.deepseek.com/v1",
    apiKey,
    model,
    pricePerMillion: {
      input: Number(env.CRAFTMATE_MODEL_PRICE_IN ?? 0),
      output: Number(env.CRAFTMATE_MODEL_PRICE_OUT ?? 0),
    },
  });
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
