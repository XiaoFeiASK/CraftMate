import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { BodySession, type BodyHealth, type BodySessionOptions } from "./coordinator.ts";
import { ControlAuthority } from "./control.ts";
import type { BridgeServerFrame } from "@craftmate/contracts";

export interface BridgeUpgradeOptions
  extends Omit<BodySessionOptions, "transport"> {
  /** Defaults to `/bridge`. Must be an exact path. */
  readonly path?: string;
  readonly maxPayloadBytes?: number;
  /**
   * A socket that has not completed a valid hello by then is closed. This
   * keeps an unauthenticated connection from owning the single body slot.
   */
  readonly handshakeTimeoutMs?: number;
}

export interface BridgeUpgrade {
  /** Wire into the existing HTTP server's `upgrade` event. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  readonly session: BodySession;
  /** Stable operator API; survives socket replacement. */
  takeOver(reason?: string): void;
  release(reason?: string): void;
  emergencyStop(reason?: string): void;
  control(): BodySession["control"];
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
  // Operator intent belongs to the body, not the socket. Keeping this outside
  // `newSession()` is what prevents reconnect from clearing takeover or stop.
  const control = options.control ?? new ControlAuthority();
  let session: BodySession | null = null;
  let socket: WebSocket | null = null;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;

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
  const newSession = (): BodySession => new BodySession({ ...options, transport, control });
  let current = newSession();

  wss.on("connection", (connected: WebSocket) => {
    if (session !== null) {
      connected.close(4409, "bridge already has a body");
      return;
    }
    // A new socket ends the previous session's slot even if it cannot
    // authenticate. Otherwise one silent socket keeps every real body out.
    session = current;
    socket = connected;
    const handshakeTimer = setTimeout(() => {
      if (current.negotiated === null) {
        connected.close(4401, "bridge hello timeout");
        setTimeout(() => {
          if (connected.readyState !== connected.CLOSED) connected.terminate();
        }, 250).unref();
      }
    }, handshakeTimeoutMs);
    handshakeTimer.unref();
    let frameReceived = false;
    connected.on("message", (raw) => {
      if (!frameReceived) {
        frameReceived = true;
        clearTimeout(handshakeTimer);
      }
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
      clearTimeout(handshakeTimer);
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
    takeOver(reason = "operator takeover"): void {
      current.takeOver(reason);
    },
    release(reason = "operator released control"): void {
      current.release(reason);
    },
    emergencyStop(reason = "operator emergency stop"): void {
      current.emergencyStop(reason);
    },
    control: () => current.control,
    health: () => current.health(),
    async close() {
      current.close("bridge server closing");
      const sockets = [...wss.clients];
      const finished = new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      for (const client of sockets) client.close();
      let terminateTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        terminateTimer = setTimeout(() => {
          for (const client of sockets) {
            if (client.readyState !== client.CLOSED) client.terminate();
          }
          resolve();
        }, 250);
      });
      await Promise.race([finished, deadline]);
      if (terminateTimer !== undefined) clearTimeout(terminateTimer);
      await finished;
    },
  };
}

/** Convenience for tests and tools; the product wires the upgrade from B. */
export function attachBridgeUpgrade(server: Server, bridge: BridgeUpgrade): void {
  server.on("upgrade", (request, socket, head) => bridge.handleUpgrade(request, socket, head));
}
