import { performance } from "node:perf_hooks";
import { SimBody, createVirtualScheduler } from "../../packages/bridge/src/sim-body.ts";
import { BodySession } from "../../packages/bridge/src/coordinator.ts";
import { MemoryActionPort } from "../../packages/bridge/src/memory-action-port.ts";

const durationMs = Number(process.env.BRIDGE_LONG_RUN_MS ?? 30_000);
const intervalMs = Number(process.env.BRIDGE_SAMPLE_MS ?? 1_000);
let now = 1_000;
const scheduler = createVirtualScheduler(() => now);
const clock = { now: () => now };
const actions = new MemoryActionPort();
const samples = [];
let heapStart = 0;

const body = new SimBody({
  token: "long-run-token",
  clock,
  scheduler,
  ticksPerCommand: 4,
  send: (frame) => coordinator.handle(frame),
});
const coordinator = new BodySession({
  token: "long-run-token",
  sessionId: "long-run",
  clock,
  scheduler,
  actions,
  queueCapacity: 16,
  transport: {
    send: (frame) => body.handle(frame),
    close: () => {},
  },
});

body.start();
global.gc?.();
heapStart = process.memoryUsage().heapUsed;
const started = performance.now();
let issued = 0;
let nextSample = 1_000;

while (now - 1_000 < durationMs) {
  issued += 1;
  try {
    coordinator.issue({
      v: 1,
      type: "cmd",
      id: `long-${issued}`,
      op: issued % 2 === 0 ? "goto" : "mine_block",
      args: {},
      priority: "ambient",
      idempotencyKey: `long-key-${issued}`,
    });
  } catch {
    issued -= 1;
  }
  now += 100;
  scheduler.advance(100);

  if (now >= nextSample) {
    const health = coordinator.health();
    samples.push({
      atMs: now - 1_000,
      ...health,
      settled: actions.snapshot().filter((attempt) => attempt.settledAt !== null).length,
      attempts: actions.snapshot().length,
      heapUsed: process.memoryUsage().heapUsed,
    });
    nextSample += intervalMs;
  }
}

coordinator.close("long run finished");
body.onDisconnect();
const elapsed = performance.now() - started;
const first = samples[0];
const last = samples.at(-1);
console.log(
  JSON.stringify(
    {
      durationMs,
      samples: samples.length,
      wallMs: Math.round(elapsed),
      issued,
      first: first ?? null,
      last: last ?? null,
      queueGrowth: (last?.queued ?? 0) - (first?.queued ?? 0),
      attemptsGrowth: (last?.attempts ?? 0) - (first?.attempts ?? 0),
      heapGrowthBytes: (last?.heapUsed ?? 0) - heapStart,
    },
    null,
    2,
  ),
);
