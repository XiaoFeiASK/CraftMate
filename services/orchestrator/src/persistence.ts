import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CommitmentLedger, Show, dafeiyu, type Persona } from "@craftmate/agent";
import {
  GoalRuntime,
  OpenAICompatibleProvider,
  Planner,
  SurvivalGoalPlanner,
  SurvivalProposalEvaluator,
  type GoalPlanner,
} from "@craftmate/agent/application";
import { showSettingsSchema } from "@craftmate/contracts";
import {
  createRuntimeConfigStore,
  publicRuntimeConfig,
  type RuntimeConfigStore,
} from "@craftmate/local-config";
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
  WorldEventStore,
  AgentEventStore,
  GoalRuntimeSqliteStore,
  SqliteProposalRepository,
  SqliteRecorder,
  openDatabase,
  type SessionContext,
} from "@craftmate/storage";
import type { SeasonGoal } from "@craftmate/contracts";

export interface PersistentShow {
  readonly show: Show;
  readonly context: SessionContext;
  readonly db: ReturnType<typeof openDatabase>;
  readonly memory: MemoryStore;
  readonly personas: PersonaVersionStore;
  readonly replay: ReplayStore;
  readonly costs: CostStore;
  readonly worldEvents: WorldEventStore;
  readonly agentEvents: AgentEventStore;
  readonly runtimeConfig: RuntimeConfigStore;
  readonly goals: GoalRuntime;
  /** Persists a settings edit, then applies it to the running show. */
  saveSettings(next: unknown): ReturnType<Show["currentSettings"]> | null;
  saveIntegrationSettings(update: unknown): {
    readonly settings: ReturnType<Show["currentSettings"]>;
    readonly runtime: ReturnType<RuntimeConfigStore["read"]>;
  } | null;
  readIntegrations(): ReturnType<typeof publicRuntimeConfig>;
  /** Purges expired raw text and writes one audit row per source. */
  expireRawText(now?: number): number;
  /** Records a model call so the hourly budget is a query, not a counter. */
  recordCost(provider: string, model: string, cost: number): void;
  /** Records a GoalRuntime decision without pretending it was an audience event. */
  recordGoalDecision(decision: import("@craftmate/contracts").Decision): void;
  resetActivity(): void;
  reconcileCommitments(): void;
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
  readonly world?: () => unknown;
  readonly availableSkills?: () => readonly string[];
  /** Injected in tests; absent means "read the environment". */
  readonly env?: NodeJS.ProcessEnv;
  /** Tests and previews may replace the goal engine; production uses #42. */
  readonly goalPlanner?: GoalPlanner;
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
  const worldEvents = new WorldEventStore(db);
  const agentEvents = new AgentEventStore(db, context);
  const proposalRepository = new SqliteProposalRepository(db, context);
  const goalStore = new GoalRuntimeSqliteStore(db, context);
  const runtimeConfig = options.env?.CRAFTMATE_INTEGRATIONS_FILE
    ? createRuntimeConfigStore({
        env: options.env,
        path: options.env.CRAFTMATE_INTEGRATIONS_FILE,
      })
    : options.env === undefined
      ? createRuntimeConfigStore()
      : createRuntimeConfigStore({ env: options.env });
  const runtime = runtimeConfig.read();
  const history = decisions.recent(context.sessionId, 50);
  let activitySince = (db.prepare("SELECT since_ms FROM dashboard_activity WHERE session_id = ?")
    .get(context.sessionId) as { since_ms: number } | undefined)?.since_ms ?? 0;
  const totals = decisions.counts(context.sessionId, activitySince);
  const stored = showSettingsSchema.safeParse(settingsStore.read(context.sessionId));
  // Normalise rows written before a setting existed. Validating supplies the
  // defaults, but leaving them only in memory makes the next read disagree
  // with what the console just displayed. Write the complete shape once.
  if (stored.success) {
    const raw = settingsStore.read(context.sessionId);
    if (JSON.stringify(raw) !== JSON.stringify(stored.data)) {
      settingsStore.write(context.sessionId, stored.data);
    }
  }
  const ledger = new CommitmentLedger({ journal: commitments });
  ledger.restore(commitments.open());
  const expiredCommitments = ledger.expireOverdue();
  if (expiredCommitments > 0) {
    console.warn(`orchestrator: expired ${expiredCommitments} overdue commitment(s) during startup recovery`);
  }

  let provider = modelProvider(runtime);
  const goalRecord = goalStore.load();

  const show = new Show({
    persona,
    ...(stored.success ? { settings: stored.data } : {}),
    goalText: options.goalText ?? DEFAULT_GOAL,
    recorder: new SqliteRecorder(db, context),
    ledger,
    memory,
    proposals: proposalRepository,
    proposalEvaluator: new SurvivalProposalEvaluator(),
    ...(options.world ? { world: options.world } : {}),
    ...(options.availableSkills
      ? { availableSkills: options.availableSkills }
      : {}),
    planner: new Planner({
      provider,
      deadlineMs: runtime.model.timeoutMs,
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
    activity: {
      since: () => activitySince,
      counts: () => decisions.counts(context.sessionId, activitySince),
    },
    ...(goalRecord === null
      ? {}
      : {
          goalState: {
            goal: goalRecord.goal,
            progress: goalRecord.progress,
            enabled: goalRecord.enabled,
          },
        }),
  });
  const reconcileCommitments = (): void => {
    show.reconcileCommitments((id) => decisions.commitmentEvidence(id));
  };
  reconcileCommitments();
  const goals = new GoalRuntime({
    store: goalStore,
    planner: options.goalPlanner ?? new SurvivalGoalPlanner(),
    proposals: () => show.proposals(null, 20),
    recordDecision: (decision) => recordGoalDecision(decision),
    onUpdate: (progress) => show.setGoalProgress(progress),
  });
  goals.restore();
  show.setSeasonGoal(goals.currentGoal);
  show.setGoalMode(goals.isEnabled);
  show.setGoalProgress(goals.currentProgress);

  /**
   * Goal tasks need a source row for the decision log, but this is an
   * agent-authored source. Storing it as an audience comment would corrupt
   * viewer statistics, so it carries the `system` kind and a goal trace id.
   */
  function recordGoalDecision(decision: import("@craftmate/contracts").Decision): void {
    const eventId = `goal:${decision.eventId}`;
    const source = sources.appendInternal(context.sessionId, {
      id: eventId,
      kind: "system",
      actorRef: "craftmate-goal",
      text: decision.text,
      at: decision.at,
    });
    decisions.append(context, source.id, decision, eventId);
    show.recordRuntimeDecision(decision);
  }

  return {
    show,
    context,
    db,
    reconcileCommitments,
    resetActivity: () => {
      const since = Date.now();
      db.prepare(`INSERT INTO dashboard_activity (session_id, since_ms) VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET since_ms = excluded.since_ms`)
        .run(context.sessionId, since);
      activitySince = since;
      reconcileCommitments();
    },
    memory,
    personas,
    replay,
    costs,
    worldEvents,
    agentEvents,
    runtimeConfig,
    goals,
    saveSettings: (next) => {
      const parsed = showSettingsSchema.safeParse(next);
      // A rejected edit must leave the running show untouched: silently
      // clamping a bad value makes the operator think it was applied.
      if (!parsed.success) return null;
      settingsStore.write(context.sessionId, parsed.data);
      const previous = show.currentSettings();
      const applied = show.updateSettings(parsed.data);
      if (parsed.data.goal !== previous.goal) {
        goals.setGoal({
          title: parsed.data.goal,
          description: parsed.data.goalDescription,
        });
      }
      goals.syncMode(parsed.data.goalMode);
      return applied;
    },
    saveIntegrationSettings: (update) => {
      let saved;
      try {
        saved = runtimeConfig.save(update as never);
      } catch {
        return null;
      }
      const current = show.currentSettings();
      const withModel = show.updateSettings({
        ...current,
        integrations: {
          ...current.integrations,
          deepseekModel: saved.model.model,
          douyinRoomId: saved.douyin.roomId,
        },
        persona: {
          ...current.persona,
          voice: {
            ...current.persona.voice,
            provider: saved.voice.provider,
            voiceId: saved.voice.voiceId,
          },
        },
      });
      settingsStore.write(context.sessionId, withModel);
      provider = modelProvider(saved);
      show.updatePlannerProvider(provider);
      show.updatePlannerDeadline(saved.model.timeoutMs);
      return { settings: withModel, runtime: saved };
    },
    readIntegrations: () => publicRuntimeConfig(runtimeConfig.read()),
    expireRawText: (now) => sources.expireRawText(now),
    recordCost: (providerId, model, cost) => {
      if (cost <= 0) return;
      costs.record({ sessionId: context.sessionId, provider: providerId, model, cost });
    },
    recordGoalDecision,
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
function modelProvider(config: {
  readonly model: {
    readonly provider: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey: string;
  };
}): OpenAICompatibleProvider | null {
  const apiKey = config.model.apiKey.trim();
  const model = config.model.model.trim();
  if (!apiKey || !model) return null;
  return new OpenAICompatibleProvider({
    id: config.model.provider,
    baseUrl: config.model.baseUrl,
    apiKey,
    model,
    pricePerMillion: {
      input: Number(process.env.CRAFTMATE_MODEL_PRICE_IN ?? 0),
      output: Number(process.env.CRAFTMATE_MODEL_PRICE_OUT ?? 0),
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
