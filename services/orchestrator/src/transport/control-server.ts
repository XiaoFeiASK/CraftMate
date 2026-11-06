import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Show } from "@craftmate/agent/application";
import {
  audienceEventSchema,
  clientMessageSchema,
  ingressClientFrameSchema,
  INGRESS_CLOSE_REMOTE,
  INGRESS_CLOSE_UNAUTHORIZED,
  opsSnapshotSchema,
  replayResponseSchema,
  sourceHealthSchema,
  showSettingsSchema,
  integrationSettingsUpdateSchema,
  integrationSettingsViewSchema,
  voiceStatusSchema,
  type BridgeHealth,
  type Decision,
  type IngressServerFrame,
  type OpsRequest,
  type Proposal,
  type ProposalStatus,
  type SeasonGoal,
  type ServerMessage,
  type VoiceSubtitle,
} from "@craftmate/contracts";
import type {
  IntegrationSettingsUpdate,
  IntegrationSettingsView,
  RuntimeIntegrationConfig,
} from "@craftmate/contracts";
import { isLoopbackAddress, tokenMatches } from "@craftmate/local-auth";
import type { BridgeUpgrade } from "@craftmate/bridge";
import { speakDecision as deliverSpeech, type SpeechHooks } from "./speech.ts";
import { AgentTelemetry } from "../telemetry.ts";

export interface SettingsWriter {
  /** Returns null when the payload failed validation and was not persisted. */
  saveSettings(next: unknown): unknown | null;
  /** Persists credentials and returns their public, redacted projection. */
  saveIntegrationSettings(update: unknown): {
    readonly settings: unknown;
    readonly runtime: RuntimeIntegrationConfig;
  } | null;
  readIntegrations?(): IntegrationSettingsView;
  /**
   * Lists models for an OpenAI-compatible endpoint. The key stays inside the
   * kernel: the console never talks to the provider directly.
   */
  listModels?(input: {
    readonly baseUrl: string;
    readonly apiKey?: string;
  }): Promise<readonly string[]>;
  resetActivity?(): void;
}

interface ControlServerOptions {
  readonly show: Show;
  readonly settings?: SettingsWriter;
  readonly port: number;
  /** Defaults to loopback. Containers must widen it to receive host traffic. */
  readonly host?: string;
  /** Exact browser origins allowed to open `/control`. */
  readonly allowedControlOrigins?: readonly string[];
  /** Containers may deliberately expose the console beyond loopback. */
  readonly allowRemoteControl?: boolean;
  /**
   * Shared secret for `/ingress`. An empty value disables ingress entirely;
   * the orchestrator never accepts an unauthenticated data source.
   */
  readonly ingressToken?: string;
  /** Only for containers or a deliberate remote-ingress setup. */
  readonly allowRemoteIngress?: boolean;
  /** Failed handshakes allowed per minute before new ingress is refused. */
  readonly ingressFailureLimit?: number;
  /** Optional voice link. Without it, speak commands are rejected readably. */
  readonly voice?: VoiceHooks;
  /** Planned speech path; omitted in tests that only exercise arbitration. */
  readonly speech?: SpeechHooks;
  /** Memory / persona / replay pages. */
  readonly ops?: OpsHooks;
  /** C-owned `/bridge` module, mounted here because B owns the HTTP server. */
  readonly bridge?: BridgeUpgrade;
  /** Turns a validated SkillCall into a bridge command. Throws are reported. */
  readonly dispatchSkill?: (decision: Decision) => void | Promise<void>;
  /** Replaces the live voice connection after settings change. */
  readonly onIntegrationsChanged?: (config: RuntimeIntegrationConfig) => void;
  /** Fired after settings are applied and broadcast, for runtime projections. */
  readonly onSettingsApplied?: () => void;
  /** Operator-only goal control. Absent means the runtime is not wired. */
  readonly goalRuntime?: GoalRuntimeHooks;
  /** Control ownership changes must interrupt or resume the goal runtime. */
  readonly onOperator?: (kind: "takeover" | "release" | "stop") => void;
  /**
   * The telemetry projection. When absent a local one is created so a plain
   * test server still answers with a well-formed empty snapshot.
   */
  readonly telemetry?: AgentTelemetry;
  /** Called after a metrics frame arrives so the host can augment it. */
  readonly onIngressMetrics?: (metrics: import("@craftmate/contracts").IngressMetricsFrame) => void;
}

export interface GoalRuntimeHooks {
  setGoal(input: {
    readonly title: string;
    readonly description: string;
  }): SeasonGoal | null;
  pause(): void;
  resume(): void;
  decideProposal(
    proposalId: string,
    status: Exclude<ProposalStatus, "pending">,
    reason: string,
  ): Proposal | null;
  queryProposals(status: ProposalStatus | null, limit: number): readonly Proposal[];
}

export interface VoiceHooks {
  speak(command: {
    readonly text: string;
    readonly priority: Decision["priority"];
    readonly decisionId: string | null;
    readonly commitmentId: string | null;
  }): void;
  stop(reason?: string): void;
}

/** Operator pages read and write through the orchestrator, never through SQL. */
export interface OpsHooks {
  snapshot(): unknown;
  apply(request: OpsRequest): void;
  timeline(traceId: string): unknown;
}

export interface ControlServer {
  /** Resolves once listening, with the bound port (differs from 0). */
  readonly listening: Promise<number>;
  /** Health pushes broadcast to every connected console. */
  publishSourceHealth(health: unknown): void;
  publishVoiceStatus(status: unknown): void;
  publishSubtitle(subtitle: VoiceSubtitle): void;
  publishStats(): void;
  publishBridgeHealth(health: BridgeHealth | null): void;
  /** A decision whose late outcome arrived from the body. */
  publishDecision(decision: Decision): void;
  /** Goal evidence and the proposal inbox are pushed after every change. */
  publishProposals(proposals: readonly Proposal[]): void;
  /** Goal progress is evidence from the runtime, not a settings slider. */
  publishGoal(progress: import("@craftmate/contracts").GoalProgress): void;
  /** One body event, already persisted by the host. */
  publishWorldEvent(event: { readonly name: string; readonly data: unknown; readonly at: number }): void;
  /** Records an operator fact, persists it, and broadcasts the bounded view. */
  publishAgentEvent(input: import("../telemetry.ts").AgentEventInput): void;
  publishTelemetry(): void;
  readonly telemetry: AgentTelemetry;
  /** Local single-shot acceptance path; disabled unless wired by the host. */
  injectDecision?(raw: unknown): void;
  /** True while an audience decision is being planned or dispatched. */
  isPlanning(): boolean;
  close(): Promise<void>;
}

interface Connection {
  readonly socket: WebSocket;
  greeted: boolean;
}

const DEFAULT_CONTROL_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
] as const;

function controlOrigins(): readonly string[] {
  // The default stays a fixed allow-list. A second local preview port has to
  // be opt-in, so a typo in the console URL cannot silently accept any origin.
  const extra = process.env.CRAFTMATE_CONTROL_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0) ?? [];
  return [...DEFAULT_CONTROL_ORIGINS, ...extra];
}

/**
 * Transport adapter: wire messages in, application calls out. It owns no
 * business rules and no state beyond connection bookkeeping.
 */
export function createControlServer({
  show,
  settings,
  port,
  host = "127.0.0.1",
  allowedControlOrigins = controlOrigins(),
  allowRemoteControl = false,
  ingressToken = "",
  allowRemoteIngress = false,
  ingressFailureLimit = 10,
  voice,
  speech,
  ops,
  bridge,
  dispatchSkill,
  onIntegrationsChanged,
  onSettingsApplied,
  goalRuntime,
  onOperator,
  telemetry: providedTelemetry,
  onIngressMetrics,
}: ControlServerOptions): ControlServer {
  const telemetry = providedTelemetry ?? new AgentTelemetry();
  const integrations = (): IntegrationSettingsView =>
    settings?.readIntegrations?.() ?? disabledIntegrations();
  const http = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, stats: show.snapshot().stats }));
      return;
    }
    response.writeHead(404).end();
  });

  // Both endpoints share one HTTP server, so upgrades are routed by path here.
  // Two `WebSocketServer({ server, path })` instances would fight: the first
  // one aborts a handshake whose path it does not own.
  const wss = new WebSocketServer({ noServer: true });
  const ingress = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/bridge" && bridge) {
      // C owns the protocol and the session; B only routes the upgrade, so
      // adding a body can never steal `/control` or `/ingress`.
      bridge.handleUpgrade(request, socket, head);
      return;
    }
    const target = path === "/control" ? wss : path === "/ingress" ? ingress : null;
    if (!target) {
      socket.destroy();
      return;
    }
    if (target === wss) {
      if (!allowRemoteControl && !isLoopbackAddress(request.socket.remoteAddress)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        console.warn("orchestrator: rejected non-loopback control connection");
        return;
      }
      const origin = request.headers.origin;
      if (origin === undefined) {
        // Non-browser tools omit Origin. Local acceptance scripts use this
        // path; a browser always sends one, including from a foreign site.
      } else if (!allowedControlOrigins.includes(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        console.warn(`orchestrator: rejected control origin ${origin}`);
        return;
      }
    }
    if (
      target === ingress &&
      (!allowRemoteIngress || ingressToken.length === 0) &&
      !isLoopbackAddress(request.socket.remoteAddress)
    ) {
      // Reject before the WebSocket handshake so a remote process cannot even
      // establish a channel and guess tokens against it.
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      console.warn("orchestrator: rejected non-loopback ingress connection");
      return;
    }
    target.handleUpgrade(request, socket, head, (ws) => target.emit("connection", ws, request));
  });
  const connections = new Set<Connection>();
  let ingressFailures: number[] = [];
  /**
   * Increments whenever an operator changes control. A plan that was already
   * in flight belongs to the old generation and may not produce speech or a
   * bridge command after the operator took over, released, or stopped.
   */
  let controlGeneration = 0;

  const pruneIngressFailures = (): void => {
    const now = Date.now();
    ingressFailures = ingressFailures.filter((at) => now - at < 60_000);
  };

  const recordIngressFailure = (): void => {
    pruneIngressFailures();
    ingressFailures.push(Date.now());
  };

  const ingressThrottled = (): boolean => {
    pruneIngressFailures();
    return ingressFailures.length >= ingressFailureLimit;
  };

  const send = (socket: WebSocket, message: ServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  const sendIngress = (socket: WebSocket, message: IngressServerFrame): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  const broadcast = (message: ServerMessage): void => {
    for (const connection of connections) send(connection.socket, message);
  };

  const publishBridgeHealth = (health: BridgeHealth | null): void => {
    show.setBridgeHealth(health);
    if (health !== null) broadcast({ type: "bridge", payload: health });
  };

  /**
   * Persistence lives in the telemetry projection; this server only owns the
   * wire. Replacing the snapshot on every event keeps a reconnect and a live
   * tab on the same bounded window.
   */
  const publishTelemetry = (): void => {
    broadcast({ type: "telemetry", payload: telemetry.snapshot() });
  };

  const publishAgentEvent = (input: import("../telemetry.ts").AgentEventInput): void => {
    const event = telemetry.record(input);
    broadcast({ type: "event", payload: event });
    publishTelemetry();
  };

  const controlBridge = (kind: "takeover" | "release" | "stop"): void => {
    if (!bridge) return;
    try {
      switch (kind) {
        case "takeover":
          bridge.session.takeOver("operator takeover");
          break;
        case "release":
          bridge.session.release();
          break;
        case "stop":
          bridge.session.emergencyStop("operator emergency stop");
          break;
      }
    } catch (error) {
      console.warn(
        `orchestrator: bridge ${kind} failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  /**
   * Ingest → broadcast → plan. The scored decision reaches the console
   * immediately; the planned rewrite replaces it in place once the model
   * answers, so a slow provider never delays the visible decision stream.
   */
  const handleDecision = (raw: unknown, origin: "control" | "ingress"): void => {
    const generation = controlGeneration;
    const received = audienceEventSchema.safeParse(raw);
    const decision = show.ingest(raw);
    if (!decision) return;
    if (origin === "control" && received.success) {
      publishAgentEvent({
        stage: "ingress_received",
        traceId: decision.eventId,
        decisionId: decision.id,
        summary: `接入 ${received.data.kind}，已交给闸门`,
        source: "ingress",
      });
      publishAgentEvent({
        stage: "gated",
        traceId: decision.eventId,
        decisionId: decision.id,
        summary: "去重、限流与队列闸门已通过",
        source: "ingress",
      });
    }
    // Rules-only decisions keep the same object through planning, so relying
    // on the `planned` branch below would leave this panel showing a previous
    // comment's judgement. Every arbitration gets a fresh, safe summary.
    telemetry.setJudgement(judgementFor(decision, false));
    publishTelemetry();
    publishAgentEvent({
      stage: "arbitrated",
      traceId: decision.eventId,
      decisionId: decision.id,
      summary: `仲裁：${decisionLabel(decision.decision)}`,
      status: decision.decision === "REFUSE" ? "skipped" : "ok",
      source: decision.eventId.startsWith("goal:") ? "goal" : "agent",
    });
    broadcast({ type: "decision", payload: decision });
    if (goalRuntime) {
      broadcast({
        type: "proposals",
        payload: { proposals: goalRuntime.queryProposals(null, 50) },
      });
    }
    broadcast({ type: "snapshot", payload: show.snapshot() });
    void planAndSpeak(decision, generation);
  };

  const injectDecision = (raw: unknown): void => handleDecision(raw, "control");
  let planning = 0;

  const publishDecision = (decision: Decision): void => {
    broadcast({ type: "decision", payload: decision });
    broadcast({ type: "snapshot", payload: show.snapshot() });
  };

  const publishProposals = (proposals: readonly Proposal[]): void => {
    broadcast({ type: "proposals", payload: { proposals } });
    broadcast({ type: "snapshot", payload: show.snapshot() });
  };

  const publishGoal = (progress: import("@craftmate/contracts").GoalProgress): void => {
    broadcast({ type: "goal", payload: progress });
    broadcast({ type: "snapshot", payload: show.snapshot() });
  };

  const publishWorldEvent = (event: {
    readonly name: string;
    readonly data: unknown;
    readonly at: number;
  }): void => {
    broadcast({ type: "world", payload: event });
  };

  const planAndSpeak = async (decision: Decision, generation: number): Promise<void> => {
    if (generation !== controlGeneration || show.snapshot().mode !== "agent") return;
    planning += 1;
    const planningStarted = Date.now();
    try {
    let planned: Decision;
    try {
      planned = await show.plan(decision);
    } catch (error) {
      console.warn(
        `orchestrator: planning failed for ${decision.id} — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    // The operator may have acted while the model was answering. Releasing
    // control does not revive this plan: only a new decision may act.
    if (generation !== controlGeneration || show.snapshot().mode !== "agent") return;
    if (planned !== decision) {
      broadcast({ type: "decision", payload: planned });
      broadcast({ type: "snapshot", payload: show.snapshot() });
      publishAgentEvent({
        stage: "planned",
        traceId: planned.eventId,
        decisionId: planned.id,
        durationMs: Math.max(0, Date.now() - planningStarted),
        summary: plannedSummary(planned),
        status: planned.trace?.degraded === true ? "degraded" : "ok",
        source: "agent",
      });
      telemetry.setJudgement(judgementFor(planned, true));
      publishTelemetry();
    }
    if (planned.skill !== null && dispatchSkill) {
      try {
        await dispatchSkill(planned);
      } catch (error) {
        console.warn(
          `orchestrator: skill for ${planned.id} was not issued — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // A missing body, lost ownership, or queue rejection happens before
        // the body can send a result. Settle the decision here so the console
        // and durable log do not leave it looking as though it is still
        // running forever.
        const failed = show.settleDecision(planned.id, {
          status: "failed",
          errorCode: error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : "E_INTERNAL",
          detail: error instanceof Error ? error.message : String(error),
          outcome: null,
          at: Date.now(),
        });
        if (failed) {
          publishDecision(failed);
          publishAgentEvent({
            stage: "failed",
            status: "failed",
            traceId: failed.eventId,
            decisionId: failed.id,
            durationMs: Math.max(0, Date.now() - planningStarted),
            // The dispatch error message may contain local or body text. The
            // code is allowlisted; the detail stays in the durable decision.
            summary: "动作未下达",
            errorCode: failed.outcome?.errorCode ?? "E_INTERNAL",
            source: "agent",
          });
        }
      }
    }
    if (!speech) return;
    try {
      deliverSpeech(show, planned, speech);
    } catch (error) {
      console.warn(
        `orchestrator: refusing to speak ${planned.id} — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    } finally {
      planning -= 1;
    }
  };

  wss.on("connection", (socket) => {
    const connection: Connection = { socket, greeted: false };
    connections.add(connection);
    // A protocol error is emitted on the socket itself. Node re-throws an
    // unhandled `error` event, which would take the whole orchestrator down on
    // one malformed frame.
    socket.on("error", (error) => {
      connections.delete(connection);
      console.warn(`orchestrator: control socket error — ${describeError(error)}`);
    });

    send(socket, {
      type: "ready",
      payload: {
        persona: show.personaSummary(),
        snapshot: show.snapshot(),
        settings: show.currentSettings(),
        integrations: integrations(),
        telemetry: telemetry.snapshot(),
      },
    });
    const voiceStatus = show.currentVoiceStatus();
    if (voiceStatus) send(socket, { type: "voice", payload: voiceStatus });
    const bridgeHealth = show.currentBridgeHealth();
    if (bridgeHealth) send(socket, { type: "bridge", payload: bridgeHealth });
    if (ops) {
      const snapshot = opsSnapshotSchema.safeParse(ops.snapshot());
      if (snapshot.success) send(socket, { type: "ops", payload: snapshot.data });
    }

    socket.on("message", (raw) => {
      const parsed = clientMessageSchema.safeParse(parseJson(raw.toString()));
      if (!parsed.success) {
        send(socket, { type: "error", payload: { code: "E_SCHEMA", detail: parsed.error.message } });
        return;
      }

      if (parsed.data.type === "hello") {
        connection.greeted = true;
        return;
      }

      if (!connection.greeted) {
        send(socket, { type: "error", payload: { code: "E_PERMISSION", detail: "hello required" } });
        return;
      }

      if (parsed.data.type === "operator") {
        const command = parsed.data.payload;
        if (command.kind !== "whisper") controlGeneration += 1;
        if (command.kind === "takeover" || command.kind === "stop") {
          telemetry.setJudgement({
            summary:
              command.kind === "takeover"
                ? "操作员已接管，Agent 暂停自主动作"
                : "急停已生效，Agent 不再下达动作",
            intent: "operator",
            reason: "控制权状态由操作员明确变更",
            nextStep:
              command.kind === "takeover" ? "等待操作员交还控制" : "等待操作员恢复运行",
            confidence: "observed",
          });
        } else if (command.kind === "release") {
          telemetry.setJudgement({
            summary: "控制权已交还 Agent，等待新的观察结果",
            intent: "observe",
            reason: "操作员主动交还控制",
            nextStep: "等待下一条评论或目标运行时任务",
            confidence: "observed",
          });
        }
        if (command.kind === "takeover") voice?.stop("操作员接管");
        if (command.kind === "stop") voice?.stop("急停");
        if (command.kind === "takeover" || command.kind === "release" || command.kind === "stop") {
          controlBridge(command.kind);
        }
        show.applyOperator(command);
        if (command.kind !== "whisper") onOperator?.(command.kind);
        if (bridge) publishBridgeHealth(bridge.health());
        broadcast({ type: "operator", payload: command });
        broadcast({ type: "snapshot", payload: show.snapshot() });
        publishAgentEvent({
          stage: "connection_changed",
          status: command.kind === "stop" ? "failed" : "ok",
          summary: operatorSummary(command.kind),
          source: "control",
        });
        return;
      }

      if (parsed.data.type === "goalSet") {
        if (!goalRuntime) {
          send(socket, {
            type: "error",
            payload: { code: "E_GOAL", detail: "本次运行未启用目标运行时" },
          });
          return;
        }
        const goal = goalRuntime.setGoal(parsed.data.payload);
        if (goal === null) {
          send(socket, {
            type: "error",
            payload: { code: "E_GOAL", detail: "目标未保存：请检查标题和说明" },
          });
          return;
        }
        const progress = show.snapshot().goal;
        if (progress !== null) broadcast({ type: "goal", payload: progress });
        broadcast({ type: "snapshot", payload: show.snapshot() });
        return;
      }

      if (parsed.data.type === "goalPause" || parsed.data.type === "goalResume") {
        if (!goalRuntime) {
          send(socket, {
            type: "error",
            payload: { code: "E_GOAL", detail: "本次运行未启用目标运行时" },
          });
          return;
        }
        if (parsed.data.type === "goalPause") goalRuntime.pause();
        else goalRuntime.resume();
        const progress = show.snapshot().goal;
        if (progress !== null) broadcast({ type: "goal", payload: progress });
        broadcast({ type: "snapshot", payload: show.snapshot() });
        return;
      }

      if (parsed.data.type === "proposalDecision") {
        if (!goalRuntime) {
          send(socket, {
            type: "error",
            payload: { code: "E_PROPOSAL", detail: "本次运行未启用提议收件箱" },
          });
          return;
        }
        const decided = goalRuntime.decideProposal(
          parsed.data.payload.proposalId,
          parsed.data.payload.status,
          parsed.data.payload.reason,
        );
        if (decided === null) {
          send(socket, {
            type: "error",
            payload: { code: "E_PROPOSAL", detail: "提议不存在或已经决定" },
          });
          return;
        }
        publishProposals(goalRuntime.queryProposals(null, 50));
        return;
      }

      if (parsed.data.type === "proposalQuery") {
        if (!goalRuntime) {
          send(socket, {
            type: "error",
            payload: { code: "E_PROPOSAL", detail: "本次运行未启用提议收件箱" },
          });
          return;
        }
        send(socket, {
          type: "proposals",
          payload: {
            proposals: goalRuntime.queryProposals(
              parsed.data.payload.status ?? null,
              parsed.data.payload.limit,
            ),
          },
        });
        return;
      }

      if (parsed.data.type === "settings") {
        // An in-memory Show (tests, previews) has no persistence layer, so the
        // edit still applies to the running show instead of being dropped.
        const applied = settings
          ? settings.saveSettings(parsed.data.payload)
          : show.updateSettings(parsed.data.payload);
        if (!applied) {
          send(socket, {
            type: "error",
            payload: { code: "E_SETTINGS", detail: "设置未保存，请检查后重试" },
          });
          return;
        }
        const current = showSettingsSchema.safeParse(applied);
        if (!current.success) {
          send(socket, {
            type: "error",
            payload: { code: "E_SETTINGS", detail: "设置已读取但格式不合法" },
          });
          return;
        }
        broadcast({ type: "settings", payload: current.data });
        try {
          onSettingsApplied?.();
        } catch (error) {
          console.warn(
            `orchestrator: settings applied but runtime projection failed — ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        broadcast({ type: "snapshot", payload: show.snapshot() });
        publishAgentEvent({
          stage: "settings_applied",
          status: "ok",
          summary: "直播设置已写入并应用到运行中的 Agent",
          source: "control",
        });
        return;
      }

      if (parsed.data.type === "activityReset") {
        if (!settings?.resetActivity) {
          send(socket, { type: "error", payload: { code: "E_SETTINGS", detail: "当前内核不支持重置统计" } });
          return;
        }
        settings.resetActivity();
        broadcast({ type: "snapshot", payload: show.snapshot() });
        publishAgentEvent({ stage: "settings_applied", status: "ok", summary: "统计与决策视图已重置，历史仍可回放", source: "control" });
        return;
      }

      if (parsed.data.type === "modelList") {
        const { baseUrl, apiKey } = parsed.data.payload;
        if (!settings?.listModels) {
          send(socket, {
            type: "models",
            payload: {
              baseUrl,
              ok: false,
              models: [],
              detail: "当前内核不支持读取模型列表，请手动填写模型名称",
            },
          });
          return;
        }
        void Promise.resolve()
          .then(() =>
            settings.listModels!({
              baseUrl,
              ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
            }),
          )
          .then((models) => {
            send(socket, {
              type: "models",
              payload: { baseUrl, ok: true, models, detail: "" },
            });
          })
          .catch((error: unknown) => {
            send(socket, {
              type: "models",
              payload: {
                baseUrl,
                ok: false,
                models: [],
                // Provider errors never echo request headers, so the key cannot
                // be reflected back through this message.
                detail: describeError(error),
              },
            });
          });
        return;
      }

      if (parsed.data.type === "settingsSave") {
        if (!settings?.saveIntegrationSettings) {
          send(socket, {
            type: "error",
            payload: { code: "E_SETTINGS", detail: "当前内核不支持持久化接入配置" },
          });
          return;
        }
        // Validate both halves before writing anything: a rejected integrations
        // block must not leave the show settings half-applied.
        const desired = showSettingsSchema.safeParse(parsed.data.payload.settings);
        if (!desired.success) {
          send(socket, {
            type: "error",
            payload: { code: "E_SETTINGS", detail: desired.error.message },
          });
          return;
        }
        const validated = integrationSettingsUpdateSchema.safeParse(parsed.data.payload.integrations);
        if (!validated.success) {
          send(socket, {
            type: "error",
            payload: { code: "E_SETTINGS", detail: validated.error.message },
          });
          return;
        }
        // The console sends both halves of the form in one frame. Persisting
        // only `integrations` silently dropped every goal / persona edit the
        // operator had just made, so the show settings go first and the
        // integration merge then builds on top of them.
        if (settings.saveSettings) {
          const applied = settings.saveSettings(desired.data);
          if (!applied) {
            send(socket, {
              type: "error",
              payload: { code: "E_SETTINGS", detail: "设置未保存，请检查后重试" },
            });
            return;
          }
        } else {
          show.updateSettings(desired.data);
        }
        const update: IntegrationSettingsUpdate = validated.data;
        const saved = settings.saveIntegrationSettings(update);
        if (!saved) {
          send(socket, {
            type: "error",
            payload: { code: "E_SETTINGS", detail: "接入配置未保存，请检查后重试" },
          });
          return;
        }
        const current = showSettingsSchema.safeParse(saved.settings);
        if (!current.success) {
          send(socket, {
            type: "error",
            payload: { code: "E_SETTINGS", detail: "接入配置已保存但设置格式不合法" },
          });
          return;
        }
        try {
          onIntegrationsChanged?.(saved.runtime);
        } catch (error) {
          console.warn(
            `orchestrator: integrations saved but live reload failed — ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        broadcast({ type: "settings", payload: current.data });
        broadcast({
          type: "integrations",
          payload: integrationSettingsViewSchema.parse(settings.readIntegrations?.()),
        });
        broadcast({ type: "snapshot", payload: show.snapshot() });
        publishAgentEvent({
          stage: "settings_applied",
          status: "ok",
          summary: "接入配置已保存，模型、语音与 Ingress 已按新配置重载",
          source: "control",
        });
        return;
      }

      if (parsed.data.type === "speak") {
        if (!voice) {
          send(socket, {
            type: "error",
            payload: { code: "E_VOICE", detail: "语音服务未连接，无法朗读" },
          });
          return;
        }
        voice.speak({
          text: parsed.data.payload.text,
          priority: "operator",
          decisionId: null,
          commitmentId: null,
        });
        publishAgentEvent({
          stage: "voice_started",
          status: "ok",
          summary: "操作员朗读已进入语音队列",
          source: "voice",
        });
        return;
      }

      if (parsed.data.type === "ops") {
        if (!ops) {
          send(socket, {
            type: "error",
            payload: { code: "E_OPS", detail: "本次运行未启用运营数据接口" },
          });
          return;
        }
        try {
          ops.apply(parsed.data.payload);
        } catch (error) {
          send(socket, {
            type: "error",
            payload: {
              code: "E_OPS",
              detail: error instanceof Error ? error.message : String(error),
            },
          });
          return;
        }
        const snapshot = opsSnapshotSchema.safeParse(ops.snapshot());
        if (snapshot.success) broadcast({ type: "ops", payload: snapshot.data });
        return;
      }

      if (parsed.data.type === "replay") {
        if (!ops) {
          send(socket, {
            type: "error",
            payload: { code: "E_OPS", detail: "本次运行未启用回放查询" },
          });
          return;
        }
        const entries = replayResponseSchema.safeParse({
          traceId: parsed.data.payload.traceId,
          entries: ops.timeline(parsed.data.payload.traceId),
        });
        if (!entries.success) {
          send(socket, { type: "error", payload: { code: "E_OPS", detail: "回放数据格式不合法" } });
          return;
        }
        send(socket, { type: "replay", payload: entries.data });
        return;
      }

      handleDecision(parsed.data.payload, "control");
    });

    socket.on("close", () => connections.delete(connection));
  });

  // Ingress is a data source, not a human operator: it may only submit events
  // and health, never operator commands. It is also the only channel that
  // requires a shared secret.
  ingress.on("connection", (socket, request) => {
    let greeted = false;
    const remote = request.socket.remoteAddress ?? "unknown";
    socket.on("error", (error) => {
      console.warn(`orchestrator: ingress socket error from ${remote} — ${describeError(error)}`);
    });

    if (ingressThrottled()) {
      socket.close(INGRESS_CLOSE_UNAUTHORIZED, "too many failed handshakes");
      console.warn(`orchestrator: ingress throttled from ${remote}`);
      return;
    }

    if (!isLoopbackAddress(remote) && !allowRemoteIngress) {
      socket.close(INGRESS_CLOSE_REMOTE, "remote ingress is disabled");
      console.warn(`orchestrator: ingress rejected from ${remote} (remote disabled)`);
      return;
    }
    if (ingressToken.length === 0) {
      socket.close(INGRESS_CLOSE_UNAUTHORIZED, "ingress token is not configured");
      console.warn("orchestrator: ingress rejected because no token is configured");
      return;
    }

    socket.on("message", (raw) => {
      const parsed = ingressClientFrameSchema.safeParse(parseJson(raw.toString()));
      if (!parsed.success) {
        sendIngress(socket, { type: "error", payload: { code: "E_SCHEMA", detail: "invalid frame" } });
        return;
      }

      if (parsed.data.type === "hello") {
        if (greeted) {
          sendIngress(socket, { type: "error", payload: { code: "E_SCHEMA", detail: "already greeted" } });
          return;
        }
        if (!tokenMatches(ingressToken, parsed.data.token)) {
          recordIngressFailure();
          socket.close(INGRESS_CLOSE_UNAUTHORIZED, "invalid ingress token");
          console.warn(`orchestrator: ingress authentication failed from ${remote}`);
          return;
        }
        greeted = true;
        sendIngress(socket, {
          type: "ready",
          payload: { sessionId: randomUUID(), heartbeatMs: 15_000 },
        });
        return;
      }
      if (!greeted) {
        socket.close(INGRESS_CLOSE_UNAUTHORIZED, "hello required");
        console.warn(`orchestrator: ingress frame before hello from ${remote}`);
        return;
      }

      if (parsed.data.type === "health") {
        show.setSourceHealth(parsed.data.payload);
        broadcast({ type: "source", payload: parsed.data.payload });
        publishTelemetry();
        return;
      }

      if (parsed.data.type === "metrics") {
        const metrics = parsed.data.payload;
        onIngressMetrics?.(metrics);
        // The host callback owns the full projection when present. Applying
        // the raw frame again here would race it with a roomId-less update.
        if (!onIngressMetrics) {
          const current = telemetry.currentIngress();
          telemetry.setIngress({
            ...metrics,
            roomId: current.roomId,
            updatedAt: Date.now(),
          });
        }
        publishTelemetry();
        return;
      }

      // Ingress facts arrive twice: once as this event frame, and again in the
      // bounded metrics `recent` list. The child is the only process that can
      // see gate drops, so it owns ingress_received/dropped; this socket must
      // not synthesize a second copy. `gated` is likewise emitted from the
      // metrics projection so both outcomes have one source of truth.
      handleDecision(parsed.data.payload, "ingress");
    });
  });

  const listening = new Promise<number>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.off("error", reject);
      const address = http.address();
      if (address === null || typeof address === "string") {
        reject(new Error("control server is not bound to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    listening,
    publishSourceHealth: (health) => {
      const parsed = sourceHealthSchema.safeParse(health);
      if (!parsed.success) return;
      show.setSourceHealth(parsed.data);
      broadcast({ type: "source", payload: parsed.data });
    },
    publishVoiceStatus: (status) => {
      const parsed = voiceStatusSchema.safeParse(status);
      if (!parsed.success) return;
      show.setVoiceStatus(parsed.data);
      broadcast({ type: "voice", payload: parsed.data });
    },
    publishStats: () => broadcast({ type: "stats", payload: show.snapshot().stats }),
    publishSubtitle: (subtitle) => {
      broadcast({ type: "subtitle", payload: subtitle });
    },
    publishBridgeHealth,
    publishDecision,
    publishProposals,
    publishGoal,
    publishWorldEvent,
    publishAgentEvent,
    publishTelemetry,
    telemetry,
    injectDecision,
    isPlanning: () => planning > 0,
    close: async () => {
      const closeWithDeadline = async (server: WebSocketServer): Promise<void> => {
        const sockets = [...server.clients];
        const finished = new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        for (const socket of sockets) socket.close();
        let terminateTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<void>((resolve) => {
          terminateTimer = setTimeout(() => {
            for (const socket of sockets) {
              if (socket.readyState !== socket.CLOSED) socket.terminate();
            }
            resolve();
          }, 250);
        });
        await Promise.race([finished, deadline]);
        if (terminateTimer !== undefined) clearTimeout(terminateTimer);
        await finished;
      };
      await closeWithDeadline(wss);
      await closeWithDeadline(ingress);
      if (bridge) await bridge.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Readable one-liner for a caught value, used by socket `error` handlers. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decisionLabel(kind: Decision["decision"]): string {
  switch (kind) {
    case "EXECUTE":
      return "执行";
    case "REFUSE":
      return "拒绝";
    case "QUEUE":
      return "排队";
    case "ACK_ONLY":
      return "回应";
    case "OBSERVE":
      return "观察";
    default:
      return "忽略";
  }
}

/**
 * A judgement is a structured projection, never planner prose. The reason is
 * kept generic so a model-authored rationale cannot become a chain-of-thought
 * substitute in the admin UI.
 */
function judgementFor(
  decision: Decision,
  planned: boolean,
): import("@craftmate/contracts").AgentJudgement {
  return {
    summary: judgementSummary(decision),
    intent: decision.intent,
    reason: planned
      ? decision.trace?.degraded === true
        ? "模型不可用或超时，使用确定性模板"
        : decision.trace === null
          ? "仲裁规则给出的确定性判断"
          : "模型基于结构化上下文完成规划"
      : "仲裁与安全闸门给出的确定性判断",
    nextStep:
      decision.skill !== null
        ? `准备执行 ${decision.skill.name}`
        : decision.decision === "QUEUE"
          ? "等待闸门与当前阶段"
          : "只记录判断，不下达动作",
    confidence: decision.trace === null ? "observed" : "inferred",
  };
}

/**
 * The arbiter stores its rationale in `reason`, but the planner may replace it
 * only for a planned decision. This summary is built from the decision itself,
 * never from the audience text or model prose.
 */
function judgementSummary(decision: Decision): string {
  if (decision.decision === "EXECUTE" && decision.skill !== null) {
    return `决定执行 ${decision.skill.name}`;
  }
  if (decision.decision === "IGNORE" || decision.decision === "OBSERVE") {
    return `没有动作，${decisionLabel(decision.decision)}`;
  }
  if (decision.decision === "QUEUE") return "决定排队，等待当前阶段";
  if (decision.decision === "ACK_ONLY") return "决定回应，不下达动作";
  if (decision.decision === "REFUSE") return "决定拒绝，不执行这个请求";
  return `决定${decisionLabel(decision.decision)}`;
}

/**
 * The planned event is built only from structured decision fields. The
 * planner's `reason` is model-authored prose, so it must never be copied into
 * the telemetry boundary even though the decision row still carries it.
 */
function plannedSummary(decision: Decision): string {
  if (decision.skill !== null) {
    return `规划完成：执行 ${decision.skill.name}`;
  }
  if (decision.decision === "QUEUE") return "规划完成：排队等待";
  if (decision.decision === "ACK_ONLY") return "规划完成：只回应";
  if (decision.decision === "REFUSE") return "规划完成：拒绝";
  return `规划完成：${decisionLabel(decision.decision)}`;
}

function operatorSummary(kind: "whisper" | "takeover" | "release" | "stop"): string {
  switch (kind) {
    case "takeover":
      return "操作员已接管，Agent 退到旁白";
    case "release":
      return "控制权已交还 Agent";
    case "stop":
      return "已急停，目标运行时暂停";
    default:
      return "耳语已记录";
  }
}

function disabledIntegrations(): IntegrationSettingsView {
  return {
    model: {
      provider: "deepseek",
      baseUrl: "https://www.yyapi.cloud/v1",
      model: "",
      apiKeyConfigured: false,
      timeoutMs: 10_000,
    },
    voice: {
      provider: "volcengine-realtime",
      url: "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue",
      voiceId: "zh_female_vv_uranus_bigtts",
      apiKeyConfigured: false,
      instructions: "忠实朗读提供给你的台词。",
      timeoutMs: 300_000,
    },
    douyin: { roomId: "", dyhubUrl: "ws://127.0.0.1:8757" },
  };
}
