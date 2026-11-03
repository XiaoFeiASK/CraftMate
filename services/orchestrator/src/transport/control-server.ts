import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Show } from "@craftmate/agent/application";
import {
  audienceEventSchema,
  clientMessageSchema,
  sourceHealthSchema,
  showSettingsSchema,
  type ServerMessage,
} from "@craftmate/contracts";

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
}

export interface ControlServer {
  /** Resolves once listening, with the bound port (differs from 0). */
  readonly listening: Promise<number>;
  /** Health pushes broadcast to every connected console. */
  publishSourceHealth(health: unknown): void;
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
    target.handleUpgrade(request, socket, head, (ws) => target.emit("connection", ws, request));
  });
  const connections = new Set<Connection>();

  const send = (socket: WebSocket, message: ServerMessage): void => {
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

      const decision = show.ingest(parsed.data.payload);
      if (!decision) return;

      broadcast({ type: "decision", payload: decision });
      broadcast({ type: "snapshot", payload: show.snapshot() });
    });

    socket.on("close", () => connections.delete(connection));
  });

  // Ingress is a data source, not a human operator: it may only submit events
  // and health, never operator commands.
  ingress.on("connection", (socket) => {
    let greeted = false;
    socket.on("message", (raw) => {
      const parsed = parseJson(raw.toString());
      if (parsed === null || typeof parsed !== "object") {
        send(socket, { type: "error", payload: { code: "E_SCHEMA", detail: "invalid frame" } });
        return;
      }
      const frame = parsed as { type?: unknown };

      if (frame.type === "hello") {
        greeted = true;
        return;
      }
      if (!greeted) {
        send(socket, { type: "error", payload: { code: "E_PERMISSION", detail: "hello required" } });
        return;
      }

      if (frame.type === "health") {
        const health = sourceHealthSchema.safeParse((parsed as { payload?: unknown }).payload);
        if (!health.success) return;
        show.setSourceHealth(health.data);
        broadcast({ type: "source", payload: health.data });
        return;
      }

      if (frame.type === "event") {
        const event = audienceEventSchema.safeParse((parsed as { payload?: unknown }).payload);
        if (!event.success) {
          send(socket, { type: "error", payload: { code: "E_SCHEMA", detail: event.error.message } });
          return;
        }
        const decision = show.ingest(event.data);
        if (!decision) return;
        broadcast({ type: "decision", payload: decision });
        broadcast({ type: "snapshot", payload: show.snapshot() });
      }
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
    close: async () => {
      for (const { socket } of connections) socket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
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
