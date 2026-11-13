import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CommitmentLedger,
  Show,
  dafeiyu,
  type Persona,
} from "@craftmate/agent";
import {
  GoalRuntime,
  OpenAICompatibleProvider,
  PlaybookGoalPlanner,
  Planner,
  SurvivalProposalEvaluator,
  type GoalPlanner,
} from "@craftmate/agent/application";
import {
  showSettingsSchema,
  type Decision,
  type WorldMemoryKind,
} from "@craftmate/contracts";
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
  RouteBlacklistStore,
  StrategyMemoryStore,
  WorldEventStore,
  WorldMemoryStore,
  canonicalDimension,
  AgentEventStore,
  GoalRuntimeSqliteStore,
  SqliteProposalRepository,
  SqliteRecorder,
  openDatabase,
  type SessionContext,
} from "@craftmate/storage";
import type { SeasonGoal } from "@craftmate/contracts";
import { fetchModelIds } from "./model-catalog.ts";

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
  readonly worldMemory: WorldMemoryStore;
  readonly strategyMemory: StrategyMemoryStore;
  readonly routeBlacklist: RouteBlacklistStore;
  readonly runtimeConfig: RuntimeConfigStore;
  readonly goals: GoalRuntime;
  /** Persists a settings edit, then applies it to the running show. */
  saveSettings(next: unknown): ReturnType<Show["currentSettings"]> | null;
  saveIntegrationSettings(update: unknown): {
    readonly settings: ReturnType<Show["currentSettings"]>;
    readonly runtime: ReturnType<RuntimeConfigStore["read"]>;
  } | null;
  readIntegrations(): ReturnType<typeof publicRuntimeConfig>;
  listModels(input: {
    readonly baseUrl: string;
    readonly apiKey?: string;
  }): Promise<readonly string[]>;
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
  const worldMemory = new WorldMemoryStore(db, context);
  const strategyMemory = new StrategyMemoryStore(db, context);
  const routeBlacklist = new RouteBlacklistStore(db, context);
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
  const overModelBudget = (): boolean => {
    if (provider === null) return false;
    const budget = costs.budget({
      hourlyLimit: Number(env.CRAFTMATE_MODEL_HOURLY_LIMIT ?? 0),
      keyLimit: Number(env.CRAFTMATE_MODEL_KEY_LIMIT ?? 0),
      provider: provider.id,
    });
    return budget.degraded;
  };
  const recordModelUsage = (entry: {
    readonly provider: string;
    readonly model: string;
    readonly prompt: number;
    readonly completion: number;
  }): void => {
    const price = provider?.pricePerMillion ?? { input: 0, output: 0 };
    const cost =
      (entry.prompt / 1_000_000) * price.input +
      (entry.completion / 1_000_000) * price.output;
    costs.record({
      sessionId: context.sessionId,
      provider: entry.provider,
      model: entry.model,
      cost,
      promptTokens: entry.prompt,
      completionTokens: entry.completion,
    });
  };
  const recordModelIncident = (incident: {
    readonly code: string;
    readonly severity: "info" | "warn" | "error";
    readonly detail: Record<string, unknown>;
  }): void => {
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
  };
  const goalRecord = goalStore.load();
  const envMs = (name: string, fallback: number): number => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 1_000 ? value : fallback;
  };

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
    reactionCooldownMs: envMs("CRAFTMATE_REACTION_COOLDOWN_MS", 30_000),
    downtimeCooldownMs: envMs("CRAFTMATE_IDLE_BEAT_MS", 45_000),
    planner: new Planner({
      provider,
      deadlineMs: runtime.model.timeoutMs,
      overBudget: overModelBudget,
      onUsage: recordModelUsage,
      onDegraded: (detail) => {
        console.warn(`orchestrator: planner degraded — ${detail}`);
      },
      onIncident: recordModelIncident,
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
    planner: options.goalPlanner ?? new PlaybookGoalPlanner({
      provider,
      deadlineMs: runtime.model.timeoutMs,
      overBudget: overModelBudget,
      onUsage: recordModelUsage,
      onIncident: recordModelIncident,
      readStrategy: () => show.currentSettings().goalStrategy,
      readMemory: (facts) => {
        worldMemory.observeFacts(facts);
        const dimension = facts.dimension;
        const position = facts.position;
        return worldMemory.recall({
          ...(dimension === null || dimension === undefined ? {} : { dimension }),
          ...(position === null || position === undefined ? {} : { position }),
          limit: 8,
        });
      },
      readRouteBlacklist: (facts) =>
        routeBlacklist.active(
          {
            ...(facts.dimension === null || facts.dimension === undefined
              ? {}
              : { dimension: canonicalDimension(facts.dimension) }),
            ...(facts.position === null || facts.position === undefined
              ? {}
              : { position: facts.position }),
            limit: 32,
          },
          Date.now(),
        ),
      onDegraded: (detail) => {
        console.warn(`orchestrator: goal planner degraded — ${detail}`);
      },
    }),
    proposals: () => show.proposals(null, 20),
    recordDecision: (decision) => recordGoalDecision(decision),
    onUpdate: (progress) => show.setGoalProgress(progress),
    onIncident: recordModelIncident,
    onSettlement: (event) => {
      try {
        const stage = show.currentGoal()?.stage.id ?? "unknown";
        const snapshot = options.world?.() as
          | { readonly world?: string | null | undefined }
          | null
          | undefined;
        const dimension = canonicalDimension(snapshot?.world);
        /*
         * Death and safety handoffs end the skill without judging the
         * strategy. Recording them as failures would teach the strategy
         * memory that mining at night or walking into a zombie is a bad
         * plan, even though the body correctly interrupted it.
         */
        if (event.status !== "preempted" && event.status !== "cancelled") {
          strategyMemory.record({
            strategyKey: event.strategyKey,
            stage,
            cardId: event.decision.playbook?.id ?? null,
            ok: event.status === "completed",
            failureCode:
              event.status === "completed"
                ? null
                : event.errorCode ?? event.status,
            failureDetail: event.status === "completed" ? null : event.detail,
            at: event.at,
          });
        }
        for (const change of event.changes) {
          if (change.kind !== "block_placed" || change.position === undefined) continue;
          const landmark = landmarkForBlock(change.detail);
          if (landmark === null) continue;
          worldMemory.observe({
            kind: landmark.kind,
            label: landmark.label,
            dimension,
            x: change.position.x,
            y: change.position.y,
            z: change.position.z,
            payload: { block: change.detail },
            confidence: 1,
            source: "body",
            observedAt: event.at,
            expiresAt: null,
          });
        }
        const target = routeTarget(event.decision);
        if (
          target !== null &&
          event.decision.skill?.name === "goto" &&
          (event.errorCode === "E_UNREACHABLE" ||
            event.errorCode === "E_ENCLOSED" ||
            event.errorCode === "E_STUCK")
        ) {
          const cardId = event.decision.playbook?.id ?? "";
          const entity =
            cardId === "food.hunt" || cardId === "combat.engage";
          const region =
            cardId === "explore.surface" ||
            cardId === "recovery.reobserve";
          const kind = entity ? "entity" : region ? "region" : "point";
          const ttl = entity || region ? 5 * 60_000 : 10 * 60_000;
          routeBlacklist.record(
            {
              dimension,
              kind,
              x: target.x,
              y: target.y,
              z: target.z,
              radius: entity ? 2.5 : region ? 12 : 1.5,
              targetRef: event.decision.playbook?.id ?? null,
              reasonCode: event.errorCode,
              reasonDetail: event.detail,
              source: "agent",
              expiresAt: event.at + ttl,
            },
            event.at,
          );
        }
        if (
          target !== null &&
          event.status === "completed" &&
          event.decision.skill?.name === "goto"
        ) {
          routeBlacklist.clearCovering(dimension, target, event.at);
        }
      } catch (error) {
        // Memory is an optimization. A storage error must never prevent the
        // body from settling a task or planning the next safe action.
        recordModelIncident({
          code: "GOAL_MEMORY_WRITE_FAILED",
          severity: "warn",
          detail: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    },
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
    worldMemory,
    strategyMemory,
    routeBlacklist,
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
      goals.updatePlannerProvider(provider);
      show.updatePlannerDeadline(saved.model.timeoutMs);
      goals.updatePlannerDeadline(saved.model.timeoutMs);
      return { settings: withModel, runtime: saved };
    },
    readIntegrations: () => publicRuntimeConfig(runtimeConfig.read()),
    listModels: ({ baseUrl, apiKey }) => {
      const current = runtimeConfig.read();
      const sameEndpoint =
        normalizeUrl(current.model.baseUrl) === normalizeUrl(baseUrl);
      const key = apiKey?.trim() || (sameEndpoint ? current.model.apiKey : "");
      return fetchModelIds({ baseUrl, apiKey: key });
    },
    expireRawText: (now) => sources.expireRawText(now),
    recordCost: (providerId, model, cost) => {
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

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function routeTarget(
  decision: Decision,
): { readonly x: number; readonly y: number; readonly z: number } | null {
  const skill = decision.skill;
  if (skill === null || skill.name !== "goto") return null;
  const target = skill.args.target;
  if (
    target === null ||
    typeof target !== "object" ||
    !("x" in target) ||
    !("y" in target) ||
    !("z" in target) ||
    typeof target.x !== "number" ||
    typeof target.y !== "number" ||
    typeof target.z !== "number" ||
    !Number.isFinite(target.x) ||
    !Number.isFinite(target.y) ||
    !Number.isFinite(target.z)
  ) {
    return null;
  }
  return { x: target.x, y: target.y, z: target.z };
}

function landmarkForBlock(
  detail: string,
): { readonly kind: WorldMemoryKind; readonly label: string } | null {
  const id = detail.toLowerCase();
  if (/_bed$/u.test(id)) return { kind: "bed", label: "床" };
  if (id.includes("chest")) return { kind: "container", label: "箱子" };
  if (id.includes("furnace")) return { kind: "furnace", label: "熔炉" };
  if (id.includes("crafting_table")) {
    return { kind: "crafting_table", label: "工作台" };
  }
  if (id.includes("nether_portal")) return { kind: "portal", label: "下界传送门" };
  return null;
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
