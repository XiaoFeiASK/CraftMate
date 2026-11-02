import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Show } from "@craftmate/application";
import { clientMessageSchema, type ServerMessage } from "@craftmate/protocol";

interface ControlServerOptions {
  readonly show: Show;
  readonly port: number;
}

export interface ControlServer {
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
export function createControlServer({ show, port }: ControlServerOptions): ControlServer {
  const http = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, stats: show.snapshot().stats }));
      return;
    }
    response.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http, path: "/control" });
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
      payload: { persona: show.personaSummary(), snapshot: show.snapshot() },
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

      const decision = show.ingest(parsed.data.payload);
      if (!decision) return;

      broadcast({ type: "decision", payload: decision });
      broadcast({ type: "snapshot", payload: show.snapshot() });
    });

    socket.on("close", () => connections.delete(connection));
  });

  http.listen(port, "127.0.0.1");

  return {
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
