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
  sourceHealthSchema,
  showSettingsSchema,
  voiceStatusSchema,
  type IngressServerFrame,
  type ServerMessage,
  type VoiceSubtitle,
} from "@craftmate/contracts";
import { isLoopbackAddress, tokenMatches } from "@craftmate/local-auth";

export interface SettingsWriter {
  /** Returns null when the payload failed validation and was not persisted. */
  saveSettings(next: unknown): unknown | null;
}

interface ControlServerOptions {
  readonly show: Show;
  readonly settings?: SettingsWriter;
  readonly port: number;
  /** Defaults to loopback. Containers must widen it to receive host traffic. */
  readonly host?: string;
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
}

export interface VoiceHooks {
  speak(text: string): void;
  stop(reason?: string): void;
}

export interface ControlServer {
  /** Resolves once listening, with the bound port (differs from 0). */
  readonly listening: Promise<number>;
  /** Health pushes broadcast to every connected console. */
  publishSourceHealth(health: unknown): void;
  publishVoiceStatus(status: unknown): void;
  publishSubtitle(subtitle: VoiceSubtitle): void;
  close(): Promise<void>;
}

interface Connection {
  readonly socket: WebSocket;
  greeted: boolean;
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
  ingressToken = "",
  allowRemoteIngress = false,
  ingressFailureLimit = 10,
  voice,
}: ControlServerOptions): ControlServer {
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
    const target = path === "/control" ? wss : path === "/ingress" ? ingress : null;
    if (!target) {
      socket.destroy();
      return;
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

  wss.on("connection", (socket) => {
    const connection: Connection = { socket, greeted: false };
    connections.add(connection);

    send(socket, {
      type: "ready",
      payload: {
        persona: show.personaSummary(),
        snapshot: show.snapshot(),
        settings: show.currentSettings(),
      },
    });
    const voiceStatus = show.currentVoiceStatus();
    if (voiceStatus) send(socket, { type: "voice", payload: voiceStatus });

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
        show.applyOperator(parsed.data.payload);
        if (parsed.data.payload.kind === "stop") voice?.stop("急停");
        broadcast({ type: "operator", payload: parsed.data.payload });
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

      if (parsed.data.type === "speak") {
        if (!voice) {
          send(socket, {
            type: "error",
            payload: { code: "E_VOICE", detail: "语音服务未连接，无法朗读" },
          });
          return;
        }
        voice.speak(parsed.data.payload.text);
        return;
      }

      const decision = show.ingest(parsed.data.payload);
      if (!decision) return;

      broadcast({ type: "decision", payload: decision });
      broadcast({ type: "snapshot", payload: show.snapshot() });
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

      const decision = show.ingest(parsed.data.payload);
      if (!decision) return;
      broadcast({ type: "decision", payload: decision });
      broadcast({ type: "snapshot", payload: show.snapshot() });
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
    close: async () => {
      for (const { socket } of connections) socket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => ingress.close(() => resolve()));
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
