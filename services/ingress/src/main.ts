import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";
import {
  ingressServerFrameSchema,
  type AudienceEvent,
  type DouyinRuntimeConfig,
  type SourceHealth,
} from "@craftmate/contracts";
import { defaultTokenPath, loadOrCreateToken } from "@craftmate/local-auth";
import { DyhubSource } from "./dyhub-source.ts";
import { EventGate } from "./gate.ts";
import { createRelay, type Relay } from "./relay.ts";

const roomId = process.env.DOUYIN_ROOM_ID ?? "";
const dyhubUrl = process.env.DYHUB_URL ?? "ws://127.0.0.1:8757";
const orchestratorUrl = process.env.CRAFTMATE_INGRESS ?? "ws://127.0.0.1:4321/ingress";
const healthPort = Number(process.env.INGRESS_HEALTH_PORT ?? 4322);
const healthHost = process.env.INGRESS_HEALTH_HOST ?? "127.0.0.1";
// Do not silently mint a different token: the orchestrator may deliberately
// run with `CRAFTMATE_TOKEN` while this process is launched separately.
if (!process.env.CRAFTMATE_TOKEN?.trim() && !existsSync(defaultTokenPath())) {
  console.error("ingress: no shared token found; start the orchestrator first or set CRAFTMATE_TOKEN");
  process.exit(1);
}
const token = loadOrCreateToken();

if (roomId.length === 0) {
  console.error("ingress: DOUYIN_ROOM_ID is required (the number in live.douyin.com/<id>)");
  process.exit(1);
}

const gate = new EventGate({
  onDrop: (kind, reason) => console.warn(`ingress: dropped ${kind} (${reason})`),
});

let health: SourceHealth = { state: "closed", detail: "启动中", lastEventAt: null };
const relay = createRelay({ gate });

const source = new DyhubSource({
  url: dyhubUrl,
  onHealth: (next) => {
    health = next;
    console.log(`ingress: ${next.state} — ${next.detail}`);
    sendHealth(next);
  },
  onDrop: (reason) => console.warn(`ingress: ignored frame (${reason})`),
});

let upstream: WebSocket | null = null;
let upstreamAttempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

function sendHealth(next: SourceHealth): void {
  if (upstream?.readyState !== WebSocket.OPEN) return;
  upstream.send(JSON.stringify({ type: "health", payload: next }));
  // Connection state is part of the metrics projection too. Send it on every
  // health transition so an idle room does not stay "connecting" until the
  // first comment arrives.
  upstream.send(metricsFrame(relay));
}

/** A bounded, secret-free projection of this process's own counters. */
function metricsFrame(relay: Relay): string {
  return relay.metrics({
    state: health.state,
    detail: health.detail,
    lastEventAt: health.lastEventAt,
    upstreamConnected: upstream?.readyState === WebSocket.OPEN,
  });
}

function connectOrchestrator(): void {
  const socket = new WebSocket(orchestratorUrl);
  upstream = socket;

  socket.on("open", () => {
    upstreamAttempt = 0;
    // A reconnect is a new listener. Re-sending the bounded window is
    // intentional: the orchestrator dedupes facts and can rebuild a missed
    // outcome, but the ordering must remain old-to-new.
    socket.send(JSON.stringify({ type: "hello", role: "ingress", token }));
    sendHealth(health);
    socket.send(metricsFrame(relay));
    const flushed = relay.flush((frame) => socket.send(frame));
    // Flushed events change `forwarded` (and drain the buffer), so the frame
    // sent before the flush is already stale. A post-flush metrics frame is
    // the operator's proof that the reconnect did not lose throughput.
    if (flushed > 0) socket.send(metricsFrame(relay));
    console.log("ingress: orchestrator connected");
  });

  socket.on("message", (raw) => {
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      console.warn("ingress: orchestrator sent invalid JSON");
      return;
    }
    const parsed = ingressServerFrameSchema.safeParse(payload);
    if (!parsed.success) {
      console.warn("ingress: orchestrator sent an unreadable frame");
      return;
    }
    if (parsed.data.type === "error") {
      console.error(`ingress: orchestrator rejected frame — ${parsed.data.payload.code}: ${parsed.data.payload.detail}`);
    }
  });

  socket.on("close", () => {
    if (upstream === socket) upstream = null;
    if (shuttingDown) return;
    const delay = Math.min(1_000 * 2 ** upstreamAttempt, 30_000);
    relay.noteReconnect();
    upstreamAttempt = Math.min(upstreamAttempt + 1, 5);
    // Deferred so the retry never runs inside the socket's own close stack.
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connectOrchestrator();
    }, delay);
  });

  socket.on("error", () => {
    /* close handler drives reconnection */
  });
}

function forward(event: AudienceEvent): void {
  // Admit returns false for a shed event, but the queue may still hold earlier
  // accepted ones, so draining must not depend on this result.
  const socket = upstream;
  const live = socket?.readyState === WebSocket.OPEN;
  const frames = relay.receive(event, live === true);
  if (live && socket !== null) {
    for (const frame of frames) socket.send(frame);
    socket.send(metricsFrame(relay));
  }
}

source.on(forward);
connectOrchestrator();
await source.connect(roomId).catch((error: unknown) => {
  console.error(`ingress: initial connect failed — ${error instanceof Error ? error.message : String(error)}`);
});

// The orchestrator supervises this process. Configuration commands avoid
// sending secrets and let a room change reconnect in place instead of leaving
// a stale health server behind during a child restart.
process.on("message", (raw) => {
  if (typeof raw !== "object" || raw === null) return;
  const message = raw as { type?: unknown; config?: unknown };
  if (message.type !== "configure") return;
  const config = message.config as Partial<DouyinRuntimeConfig> | undefined;
  if (
    !config ||
    typeof config.roomId !== "string" ||
    config.roomId.length === 0 ||
    typeof config.dyhubUrl !== "string"
  ) {
    return;
  }
  void source.reconfigure(config.roomId, config.dyhubUrl).catch((error: unknown) => {
    console.error(`ingress: reconfigure failed — ${error instanceof Error ? error.message : String(error)}`);
  });
  // A room change is a new ingestion domain. The relay resets its gate too, so
  // the old room's dedupe window and drop reasons cannot leak into the new one.
  relay.reset();
  sendHealth(health);
});

const healthServer = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      ok: health.state === "open",
      source: health,
      counters: {
        received: relay.state.received,
        forwarded: relay.state.forwarded,
        reconnects: relay.state.reconnects,
      },
      gate: relay.stats(),
      dropReasons: relay.stats().dropReasons,
      upstream: upstream?.readyState === WebSocket.OPEN,
      reconnects: relay.state.reconnects,
    }),
  );
});

// Kept for parity with the orchestrator: a WSS instance is not needed here,
// but the http server must stay referenced so the process does not exit.
const idle = new WebSocketServer({ noServer: true });
healthServer.on("upgrade", (request, socket, head) => {
  idle.handleUpgrade(request, socket, head, (ws) => ws.close());
});
healthServer.listen(healthPort, healthHost, () => {
  console.log(`ingress: health on http://${healthHost}:${healthPort}/health`);
});

const shutdown = async (): Promise<void> => {
  shuttingDown = true;
  if (retryTimer) clearTimeout(retryTimer);
  await source.close();
  upstream?.close();
  healthServer.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
