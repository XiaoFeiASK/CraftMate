import { createControlServer } from "./transport/control-server.ts";
import { createPersistentShow } from "./persistence.ts";
import { createRetentionSweep } from "./retention.ts";
import { loadOrCreateToken } from "@craftmate/local-auth";
import { connectVoice } from "./transport/voice-link.ts";
import { createOps } from "./ops.ts";
import { createBridgeUpgrade, SqliteActionPort } from "@craftmate/bridge";
import { loadOrCreateBridgeToken } from "@craftmate/bridge";

const port = Number(process.env.CRAFTMATE_PORT ?? 4321);
// Loopback by default. Set CRAFTMATE_HOST=0.0.0.0 only when another device
// or a container needs to reach the socket.
const host = process.env.CRAFTMATE_HOST ?? "127.0.0.1";
const ingressToken = loadOrCreateToken();
const persistent = createPersistentShow();
const retention = createRetentionSweep({ expire: (now) => persistent.expireRawText(now) });
retention.start();
let voiceLink: ReturnType<typeof connectVoice> | null = null;

// A body is optional: without one the bridge reports "not connected" and no
// skill is issued. Mounting the route early keeps the console honest.
const bridgeToken = loadOrCreateBridgeToken();
const bridge = createBridgeUpgrade({
  token: bridgeToken,
  sessionId: persistent.context.sessionId,
  actions: {
    // Commands carry their own decisionId, so the port never has to guess.
    begin: (command) =>
      new SqliteActionPort(persistent.db, { sessionId: persistent.context.sessionId }).begin(command),
    settle: (attemptId, status, errorCode, result) =>
      new SqliteActionPort(persistent.db, { sessionId: persistent.context.sessionId }).settle(
        attemptId,
        status,
        errorCode,
        result,
      ),
  },
  audit: {
    record: (event) => {
      console.log(
        `bridge: ${event.type} ${event.op} ${event.status ?? ""}`.trim(),
      );
    },
  },
});

const ops = createOps({
  show: persistent.show,
  memory: persistent.memory,
  personas: persistent.personas,
  replay: persistent.replay,
  costs: persistent.costs,
  personaKey: "dafeiyu",
  onSettings: (next) => persistent.saveSettings(next),
  hourlyLimit: Number(process.env.CRAFTMATE_MODEL_HOURLY_LIMIT ?? 0),
});

const server = createControlServer({
  show: persistent.show,
  settings: { saveSettings: (next) => persistent.saveSettings(next) },
  port,
  host,
  ingressToken,
  allowRemoteIngress: process.env.CRAFTMATE_ALLOW_REMOTE_INGRESS === "1",
  voice: {
    speak: (command) => voiceLink?.speak(command),
    stop: (reason) => voiceLink?.stop(reason),
  },
  speech: {
    speak: (input) =>
      voiceLink?.speak({
        text: input.text,
        priority: input.priority,
        decisionId: input.decisionId,
        commitmentId: input.commitmentId,
      }),
  },
  ops,
  bridge,
  dispatchSkill: (decision) => {
    if (decision.skill === null) return;
    // Ownership is enforced by the coordinator: no body, no agent control, or
    // an operator takeover all reject here instead of at the game.
    bridge.session.issue({
      v: 1,
      type: "cmd",
      id: crypto.randomUUID(),
      decisionId: decision.id,
      op: decision.skill.name,
      args: decision.skill.args,
      priority: decision.priority,
      idempotencyKey: decision.skill.idempotencyKey,
      ...(decision.skill.deadlineTicks === undefined
        ? {}
        : { deadlineTick: decision.skill.deadlineTicks }),
    });
    server.publishBridgeHealth(bridge.health());
  },
});

voiceLink = connectVoice({
  url: process.env.CRAFTMATE_VOICE ?? "ws://127.0.0.1:4323/voice",
  token: ingressToken,
  onStatus: (status) => server.publishVoiceStatus(status),
  onSubtitle: (subtitle) => {
    server.publishSubtitle(subtitle);
    // A failed utterance must not leave a promise marked as merely "spoken".
    if (subtitle.commitmentId && subtitle.state === "failed") {
      try {
        // `spoken` cannot move to `broken`; an undelivered line is cancelled.
        persistent.show.ledger.transition(subtitle.commitmentId, "cancelled", "voice failed");
      } catch (error) {
        console.warn(
          `orchestrator: could not close commitment ${subtitle.commitmentId} — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  },
  onError: (detail) => console.warn(`orchestrator: voice error — ${detail}`),
});

const bridgePoll = setInterval(() => {
  server.publishBridgeHealth(bridge.health());
}, 2_000);

const shutdown = async (): Promise<void> => {
  clearInterval(bridgePoll);
  retention.stop();
  voiceLink?.close();
  await server.close();
  persistent.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
