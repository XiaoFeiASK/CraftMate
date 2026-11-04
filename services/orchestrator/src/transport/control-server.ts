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

export interface SettingsWriter {
  /** Returns null when the payload failed validation and was not persisted. */
  saveSettings(next: unknown): unknown | null;
  /** Persists credentials and returns their public, redacted projection. */
  saveIntegrationSettings(update: unknown): {
    readonly settings: unknown;
    readonly runtime: RuntimeIntegrationConfig;
  } | null;
  readIntegrations?(): IntegrationSettingsView;
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
  publishBridgeHealth(health: BridgeHealth | null): void;
  /** A decision whose late outcome arrived from the body. */
  publishDecision(decision: Decision): void;
  /** One body event, already persisted by the host. */
  publishWorldEvent(event: { readonly name: string; readonly data: unknown; readonly at: number }): void;
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

/**
 * Transport adapter: wire messages in, application calls out. It owns no
 * business rules and no state beyond connection bookkeeping.
 */
export function createControlServer({
  show,
  settings,
  port,
  host = "127.0.0.1",
  allowedControlOrigins = DEFAULT_CONTROL_ORIGINS,
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
}: ControlServerOptions): ControlServer {
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
  const handleDecision = (raw: unknown): void => {
    const generation = controlGeneration;
    const decision = show.ingest(raw);
    if (!decision) return;
    broadcast({ type: "decision", payload: decision });
    broadcast({ type: "snapshot", payload: show.snapshot() });
    void planAndSpeak(decision, generation);
  };

  const injectDecision = (raw: unknown): void => handleDecision(raw);
  let planning = 0;

  const publishDecision = (decision: Decision): void => {
    broadcast({ type: "decision", payload: decision });
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
        if (failed) publishDecision(failed);
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

    send(socket, {
      type: "ready",
      payload: {
        persona: show.personaSummary(),
        snapshot: show.snapshot(),
        settings: show.currentSettings(),
        integrations: integrations(),
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
        if (command.kind === "takeover") voice?.stop("操作员接管");
        if (command.kind === "stop") voice?.stop("急停");
        if (command.kind === "takeover" || command.kind === "release" || command.kind === "stop") {
          controlBridge(command.kind);
        }
        show.applyOperator(command);
        if (bridge) publishBridgeHealth(bridge.health());
        broadcast({ type: "operator", payload: command });
        broadcast({ type: "snapshot", payload: show.snapshot() });
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
        broadcast({ type: "snapshot", payload: show.snapshot() });
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
        const validated = integrationSettingsUpdateSchema.safeParse(parsed.data.payload.integrations);
        if (!validated.success) {
          send(socket, {
            type: "error",
            payload: { code: "E_SETTINGS", detail: validated.error.message },
          });
          return;
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

      handleDecision(parsed.data.payload);
    });

    socket.on("close", () => connections.delete(connection));
  });

  // Ingress is a data source, not a human operator: it may only submit events
  // and health, never operator commands. It is also the only channel that
  // requires a shared secret.
  ingress.on("connection", (socket, request) => {
    let greeted = false;
    const remote = request.socket.remoteAddress ?? "unknown";

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
        return;
      }

      handleDecision(parsed.data.payload);
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
    publishSubtitle: (subtitle) => {
      broadcast({ type: "subtitle", payload: subtitle });
    },
    publishBridgeHealth,
    publishDecision,
    publishWorldEvent,
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
