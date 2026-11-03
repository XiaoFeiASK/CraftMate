import { WebSocket } from "ws";
import type { BridgeClientFrame, BridgeServerFrame } from "@craftmate/contracts";
import { SimBody, type SimBodyOptions } from "./sim-body.ts";
import type { Clock, TimerScheduler } from "./types.ts";

export interface BridgeClientOptions
  extends Omit<SimBodyOptions, "send" | "clock" | "scheduler"> {
  readonly url: string;
  readonly clock?: Clock;
  readonly scheduler?: TimerScheduler;
  /** Called once the socket closes, whoever initiated it. */
  readonly onClose?: (code: number, reason: string) => void;
}

export interface ConnectedBridgeClient {
  readonly body: SimBody;
  /** Resolves on socket open; rejects on connection failure. */
  readonly open: Promise<void>;
  close(): Promise<void>;
}

/**
 * Thin socket adapter around SimBody. The body owns all game-side safety;
 * this file only translates frames and guarantees a local stop on close.
 */
export function connectBridgeClient(options: BridgeClientOptions): ConnectedBridgeClient {
  const socket = new WebSocket(options.url);
  let body: SimBody | null = null;
  const pending: BridgeServerFrame[] = [];

  const open = new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      body = new SimBody({
        ...options,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
        send: (frame: BridgeClientFrame) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
        },
      });
      body.start();
      for (const frame of pending.splice(0)) body.handle(frame);
      resolve();
    });
    socket.once("error", reject);
  });

  socket.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (body) body.handle(parsed);
    else pending.push(parsed as BridgeServerFrame);
  });
  socket.on("close", (code, reason) => {
    body?.onDisconnect();
    options.onClose?.(code, reason.toString());
  });

  return {
    get body() {
      if (!body) throw new Error("bridge client is not open yet");
      return body;
    },
    open,
    async close() {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
        socket.close(1000, "client shutdown");
      }
    },
  };
}
