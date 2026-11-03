import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { BodySession, type BodyHealth, type BodySessionOptions } from "./coordinator.ts";
import type { BridgeServerFrame } from "@craftmate/contracts";

export interface BridgeUpgradeOptions
  extends Omit<BodySessionOptions, "transport"> {
  /** Defaults to `/bridge`. Must be an exact path. */
  readonly path?: string;
  readonly maxPayloadBytes?: number;
}

export interface BridgeUpgrade {
  /** Wire into the existing HTTP server's `upgrade` event. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  readonly session: BodySession;
  /** Cheap snapshot for `/health`; never triggers a command. */
  health(): BodyHealth;
  close(): Promise<void>;
}

/**
 * Registers one `/bridge` body. The owning HTTP server stays with B: this
 * module never creates a listener, so adding the bridge cannot steal `/control`.
 */
export function createBridgeUpgrade(options: BridgeUpgradeOptions): BridgeUpgrade {
  const path = options.path ?? "/bridge";
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 64 * 1024,
  });
  let session: BodySession | null = null;
  let socket: WebSocket | null = null;

  const transport = {
    send(frame: BridgeServerFrame): void {
      const currentSocket = socket;
      if (currentSocket !== null && currentSocket.readyState === currentSocket.OPEN) {
        currentSocket.send(JSON.stringify(frame));
      }
    },
    close(code: number, reason: string): void {
      const currentSocket = socket;
      if (currentSocket !== null && currentSocket.readyState === currentSocket.OPEN) {
        currentSocket.close(code, reason);
      }
    },
  };

  /**
   * A body must be usable again after a disconnect. `BodySession.close()` is
   * terminal, so a reconnect gets a fresh session; reusing the old one left
   * the bridge permanently unowned (`agent does not own the body (none)`).
   */
  const newSession = (): BodySession => new BodySession({ ...options, transport });
  let current = newSession();

  wss.on("connection", (connected: WebSocket) => {
    if (session !== null) {
      connected.close(4409, "bridge already has a body");
      return;
    }
    session = current;
    socket = connected;
    connected.on("message", (raw) => {
      const text = raw.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        transport.send({
          v: 1,
          type: "error",
          code: "E_SCHEMA",
          detail: "invalid JSON",
        });
        connected.close(4400, "invalid JSON");
        return;
      }
      current.handle(parsed);
    });
    connected.on("close", () => {
      current.close("socket closed");
      if (socket === connected) socket = null;
      session = null;
      current = newSession();
    });
  });

  return {
    handleUpgrade(request, upgradeSocket, head) {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== path) {
        upgradeSocket.destroy();
        return;
      }
      wss.handleUpgrade(request, upgradeSocket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    },
    get session() {
      return current;
    },
    health: () => current.health(),
    async close() {
      current.close("bridge server closing");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** Convenience for tests and tools; the product wires the upgrade from B. */
export function attachBridgeUpgrade(server: Server, bridge: BridgeUpgrade): void {
  server.on("upgrade", (request, socket, head) => bridge.handleUpgrade(request, socket, head));
}
