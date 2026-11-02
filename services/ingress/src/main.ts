import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { AudienceEvent, SourceHealth } from "@craftmate/contracts";
import { DyhubSource } from "./dyhub-source.ts";
import { EventGate } from "./gate.ts";

const roomId = process.env.DOUYIN_ROOM_ID ?? "";
const dyhubUrl = process.env.DYHUB_URL ?? "ws://127.0.0.1:8757";
const orchestratorUrl = process.env.CRAFTMATE_INGRESS ?? "ws://127.0.0.1:4321/ingress";
const token = process.env.CRAFTMATE_TOKEN ?? "";
const healthPort = Number(process.env.INGRESS_HEALTH_PORT ?? 4322);
const healthHost = process.env.INGRESS_HEALTH_HOST ?? "127.0.0.1";

if (roomId.length === 0) {
  console.error("ingress: DOUYIN_ROOM_ID is required (the number in live.douyin.com/<id>)");
  process.exit(1);
}

const gate = new EventGate({
  onDrop: (kind, reason) => console.warn(`ingress: dropped ${kind} (${reason})`),
});

let health: SourceHealth = { state: "closed", detail: "启动中", lastEventAt: null };
const counters = { received: 0, forwarded: 0 };

const source = new DyhubSource({
  url: dyhubUrl,
  onHealth: (next) => {
    health = next;
    console.log(`ingress: ${next.state} — ${next.detail}`);
    sendHealth(next);
  },
  onDrop: (reason) => console.warn(`ingress: ignored frame (${reason})`),
});

/** Buffered until the orchestrator link is open, so a restart loses nothing. */
const pending: string[] = [];
let upstream: WebSocket | null = null;
let upstreamAttempt = 0;

function sendHealth(next: SourceHealth): void {
  const frame = JSON.stringify({ type: "health", payload: next });
  if (upstream?.readyState === WebSocket.OPEN) upstream.send(frame);
}

function connectOrchestrator(): void {
  const socket = new WebSocket(orchestratorUrl);
  upstream = socket;

  socket.on("open", () => {
    upstreamAttempt = 0;
    socket.send(JSON.stringify({ type: "hello", role: "ingress", token }));
    sendHealth(health);
    for (const frame of pending.splice(0)) socket.send(frame);
    console.log("ingress: orchestrator connected");
  });

  socket.on("close", () => {
    if (upstream === socket) upstream = null;
    const delay = Math.min(1_000 * 2 ** upstreamAttempt, 30_000);
    upstreamAttempt = Math.min(upstreamAttempt + 1, 5);
    // Deferred so the retry never runs inside the socket's own close stack.
    setTimeout(() => connectOrchestrator(), delay);
  });

  socket.on("error", () => {
    /* close handler drives reconnection */
  });
}

function forward(event: AudienceEvent): void {
  counters.received += 1;
  // Admit returns false for a shed event, but the queue may still hold earlier
  // accepted ones, so draining must not depend on this result.
  gate.admit(event);

  for (const admitted of gate.drain()) {
    const frame = JSON.stringify({ type: "event", payload: admitted });
    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(frame);
      counters.forwarded += 1;
    } else if (pending.length < 64) {
      pending.push(frame);
    }
  }
}

source.on(forward);
connectOrchestrator();
await source.connect(roomId).catch((error: unknown) => {
  console.error(`ingress: initial connect failed — ${error instanceof Error ? error.message : String(error)}`);
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
      counters,
      gate: gate.stats(),
      upstream: upstream?.readyState === WebSocket.OPEN,
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
  await source.close();
  upstream?.close();
  healthServer.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
