import { createControlServer } from "./transport/control-server.ts";
import { createPersistentShow } from "./persistence.ts";
import { createRetentionSweep } from "./retention.ts";
import { loadOrCreateToken } from "@craftmate/local-auth";
import { connectVoice } from "./transport/voice-link.ts";
import { createOps } from "./ops.ts";
import { createBridgeUpgrade, SqliteActionPort } from "@craftmate/bridge";
import { loadOrCreateBridgeToken } from "@craftmate/bridge";
import { createIngressSupervisor } from "./ingress-supervisor.ts";
import {
  nextAutonomousAction,
} from "@craftmate/agent/application";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { skillOutcomeSchema } from "@craftmate/contracts";
import { skillCallSchema } from "@craftmate/contracts";

const port = Number(process.env.CRAFTMATE_PORT ?? 4321);
// Loopback by default. Set CRAFTMATE_HOST=0.0.0.0 only when another device
// or a container needs to reach the socket.
const host = process.env.CRAFTMATE_HOST ?? "127.0.0.1";
const ingressToken = loadOrCreateToken();
// The bridge is assigned before the HTTP server starts accepting traffic.
// The planner reads only the last semantic heartbeat snapshot from it.
let bridge: ReturnType<typeof createBridgeUpgrade>;
let autonomousInFlight: string | null = null;
let autonomousCommandId: string | null = null;
let autonomousStartedAt = 0;
let lastAutonomousAt = 0;
let autonomyConsecutiveFailures = 0;
let autonomyMiningBlockedUntil = 0;
const persistent = createPersistentShow({
  world: () => bridge?.health().world ?? null,
  availableSkills: () => bridge?.health().skills ?? [],
});
const retention = createRetentionSweep({ expire: (now) => persistent.expireRawText(now) });
retention.start();
let voiceLink: ReturnType<typeof connectVoice> | null = null;
const ingressSupervisor = createIngressSupervisor({
  publishHealth: (health) => server.publishSourceHealth(health),
  onError: (detail) => console.warn(`orchestrator: ingress — ${detail}`),
});

function loadOperatorCliAction():
  | { readonly command: string; readonly actor: "agent" | "operator" }
  | null {
  const path = join(homedir(), ".craftmate", "test-command.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as {
    readonly command?: unknown;
    readonly actor?: unknown;
  };
  if (
    typeof parsed.command !== "string" ||
    !["agent", "operator"].includes(parsed.actor as string) ||
    parsed.command.length > 2_000
  ) {
    throw new Error("test-command.json must contain command and actor=agent|operator");
  }
  return { command: parsed.command, actor: parsed.actor as "agent" | "operator" };
}

async function injectOperatorCliAction(
  action: { readonly command: string; readonly actor: "agent" | "operator" },
): Promise<void> {
  const path = join(homedir(), ".craftmate", "test-command.json");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const health = bridge.health();
    if (
      health.connected &&
      health.owner === "agent" &&
      health.world?.inWorld === true
    ) {
      server.injectDecision?.({
        id: `headless-${crypto.randomUUID()}`,
        kind: "chat",
        roomId: "headless-smoke",
        userId: action.actor === "agent" ? "craftmate-agent" : "craftmate-operator",
        nickname: action.actor === "agent" ? "本地验收" : "操作员验收",
        text: action.command,
        at: Date.now(),
      });
      try {
        unlinkSync(path);
      } catch {
        // The command was already accepted; a cleanup failure must not replay it.
      }
      console.log("orchestrator: injected local acceptance command after the world became ready");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.warn("orchestrator: local acceptance command was not injected; game body was not ready within 30 seconds");
}

// A body is optional: without one the bridge reports "not connected" and no
// skill is issued. Mounting the route early keeps the console honest.
const bridgeToken = loadOrCreateBridgeToken();
bridge = createBridgeUpgrade({
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
        `bridge: ${event.type} ${event.op} ${event.status ?? ""} ${event.detail ?? ""}`.trim(),
      );
    },
  },
  onOutcome: (outcome) => {
    if (outcome.decisionId === autonomousInFlight) {
      autonomousInFlight = null;
      autonomousCommandId = null;
      if (outcome.status !== "completed") {
        autonomyConsecutiveFailures += 1;
        const decision = persistent.show
          .recent()
          .find((entry) => entry.id === outcome.decisionId);
        // A nearby log can stay visible while every visible face is blocked.
        // Back off for one exploration step instead of re-selecting the same
        // tree on the next cooldown.
        if (decision?.intent === "mine") {
          autonomyMiningBlockedUntil = Date.now() + 6_000;
        }
      } else {
        autonomyConsecutiveFailures = 0;
        autonomyMiningBlockedUntil = 0;
      }
    }
    // The decision id is the join between "it was asked to" and "what happened".
    // Without it the console would show two unrelated rows.
    const decision = persistent.show
      .recent()
      .find((entry) => entry.id === outcome.decisionId);
    // The body is untrusted input even after the bridge validated its frame.
    // Keep a malformed result as a bare outcome instead of persisting it.
    const parsedOutcome = outcome.outcome
      ? skillOutcomeSchema.safeParse(outcome.outcome)
      : null;
    const settled = decision
      ? persistent.show.settleDecision(decision.id, {
          status: outcome.status,
          ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          outcome: parsedOutcome?.success ? parsedOutcome.data : null,
          at: outcome.at,
        })
      : null;
    if (settled) server.publishDecision(settled);
    // A body-originated failure is the only place some reasons survive. Give
    // the planner the game fact so the next line can be about what actually
    // happened rather than a generic apology.
    if (outcome.status !== "failed" || outcome.detail === undefined) return;
    persistent.show.recordIncident({
      kind: "blocked",
      detail: outcome.detail,
      at: outcome.at,
    });
    // The console must not wait for the 2-second health poll: a safety stop is
    // exactly the moment an operator wants to see the reason.
    server.publishBridgeHealth(bridge.health());
  },
  onEvent: (event) => {
    persistent.worldEvents.append(persistent.context.sessionId, {
      name: event.name,
      tick: bridge.health().tick,
      data: event.data,
      at: Date.now(),
    });
    server.publishWorldEvent({
      name: event.name,
      data: event.data,
      at: Date.now(),
    });
    if (event.name !== "reflex") return;
    const data = event.data as { kind?: unknown; detail?: unknown };
    if (typeof data.kind !== "string" || typeof data.detail !== "string") return;
    persistent.show.recordIncident({
      kind: data.kind,
      detail: data.detail,
      at: Date.now(),
    });
    server.publishBridgeHealth(bridge.health());
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
  settings: {
    saveSettings: (next) => persistent.saveSettings(next),
    saveIntegrationSettings: (next) => persistent.saveIntegrationSettings(next),
    readIntegrations: () => persistent.readIntegrations(),
  },
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
  onIntegrationsChanged: (config) => {
    voiceLink?.configure(config.voice);
    void ingressSupervisor.configure(config.douyin);
  },
});

// Headless smoke-test ingress. This reads only a caller-owned local file,
// waits for the real game body and world, and then enters through the same
// event pipeline as a live comment. It never simulates an action result.
const smoke = loadOperatorCliAction();
if (smoke) {
  void server.listening.then(() => injectOperatorCliAction(smoke));
}

voiceLink = connectVoice({
  url: process.env.CRAFTMATE_VOICE ?? "ws://127.0.0.1:4323/voice",
  token: ingressToken,
  onStatus: (status) => server.publishVoiceStatus(status),
  onSubtitle: (subtitle) => {
    server.publishSubtitle(subtitle);
    
    // Forward playback events to the commitment ledger when a commitmentId is present.
    // The ledger tracks promise fulfillment, so real playback state must be reflected.
    
    // speaking: real playback has started, transition from proposed to spoken
    if (subtitle.commitmentId && subtitle.state === "speaking") {
      try {
        const commitment = persistent.show.ledger.get(subtitle.commitmentId);
        // Only transition from proposed to spoken; avoid re-transitioning if already spoken.
        if (commitment && commitment.status === "proposed") {
          persistent.show.ledger.transition(subtitle.commitmentId, "spoken", "voice speaking");
        }
      } catch (error) {
        console.warn(
          `orchestrator: could not mark commitment ${subtitle.commitmentId} as spoken — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    
    // spoken: playback completed successfully, commitment is already in spoken state
    if (subtitle.commitmentId && subtitle.state === "spoken") {
      // Verify the commitment exists and log completion for observability.
      const commitment = persistent.show.ledger.get(subtitle.commitmentId);
      if (commitment) {
        console.log(`orchestrator: commitment ${subtitle.commitmentId} playback completed`);
      }
    }
    
    // cancelled: utterance was cancelled before or during playback
    if (subtitle.commitmentId && subtitle.state === "cancelled") {
      try {
        const commitment = persistent.show.ledger.get(subtitle.commitmentId);
        if (commitment && commitment.status !== "cancelled" && commitment.status !== "expired") {
          persistent.show.ledger.transition(subtitle.commitmentId, "cancelled", "voice cancelled");
        }
      } catch (error) {
        console.warn(
          `orchestrator: could not cancel commitment ${subtitle.commitmentId} — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    
    // failed: playback failed, cancel the commitment
    if (subtitle.commitmentId && subtitle.state === "failed") {
      try {
        const commitment = persistent.show.ledger.get(subtitle.commitmentId);
        if (commitment && commitment.status !== "cancelled" && commitment.status !== "expired") {
          // `spoken` cannot move to `broken`; an undelivered line is cancelled.
          persistent.show.ledger.transition(subtitle.commitmentId, "cancelled", "voice failed");
        }
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

// One bounded step at a time, and only when the operator turned autonomy on.
// The default is intentionally silent: normal play responds to comments and
// operator commands, not to a timer that invents a destination.
const autonomousLoop = setInterval(() => {
  // Keep the environment escape hatch for headless checks, but a setting is
  // the source of truth for normal play.
  const autonomyEnabled =
    process.env.CRAFTMATE_AUTONOMY !== "0" &&
    persistent.show.currentSettings().autonomy.enabled === true;
  if (!autonomyEnabled) {
    // Turning the switch off must stop the current idle action, not only the
    // next one. Audience/operator commands are deliberately not tracked here.
    if (autonomousInFlight !== null) {
      const stopped = autonomousInFlight;
      const commandId = autonomousCommandId;
      autonomousInFlight = null;
      autonomousCommandId = null;
      if (commandId !== null) {
        try {
          bridge.session.cancel(commandId, "autonomy turned off");
        } catch (error) {
          console.warn(
            `orchestrator: could not cancel autonomous step — ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      const settled = persistent.show.settleDecision(stopped, {
        status: "cancelled",
        errorCode: "E_CANCELLED",
        detail: "自主行动已关闭",
        outcome: null,
        at: Date.now(),
      });
      if (settled) server.publishDecision(settled);
    }
    return;
  }
  const health = bridge.health();
  if (autonomousInFlight !== null && Date.now() - autonomousStartedAt > 35_000) {
    // A lost terminal frame must not permanently freeze an always-on agent.
    // Cancel by command id, not by health counters: the bridge can hold a
    // task whose running count has already been lost in an older snapshot.
    const stale = autonomousInFlight;
    console.warn(`orchestrator: reclaiming stale autonomous step ${stale}`);
    try {
      // The bridge cancels by command id, so keep the exact id that was sent
      // instead of reusing the decision id.
      if (autonomousCommandId !== null) {
        bridge.session.cancel(autonomousCommandId, "autonomous step lost its terminal frame");
      }
    } catch (error) {
      console.warn(
        `orchestrator: stale cancel failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const failed = persistent.show.settleDecision(stale, {
      status: "failed",
      errorCode: "E_TIMEOUT",
      detail: "autonomous step lost its terminal frame",
      outcome: null,
      at: Date.now(),
    });
    if (failed) server.publishDecision(failed);
    autonomousInFlight = null;
    autonomousCommandId = null;
    autonomyConsecutiveFailures += 1;
  }
  if (autonomousInFlight !== null) return;
  if (server.isPlanning()) return;
  const action = nextAutonomousAction({
    now: Date.now(),
    mode: persistent.show.snapshot().mode,
    bridge: health,
    enabled: true,
    lastAttemptAt: lastAutonomousAt,
    miningBlockedUntil: autonomyMiningBlockedUntil,
    consecutiveFailures: autonomyConsecutiveFailures,
  });
  if (action === null) return;
  const skill = skillCallSchema.safeParse(action.skill);
  if (!skill.success) return;
  // The autonomous loop owns one decision at a time, but an audience command
  // may have been dispatched after the health snapshot. Do not append a second
  // cmd that would sit behind it and look like a frozen agent.
  const latest = bridge.health();
  if (latest.queued > 0 || latest.running > 0 || latest.connected !== true) return;
  const decision = persistent.show.recordAutonomous({
    ...action,
    skill: skill.data,
    recorder: {
      record: (entry) => persistent.recordAutonomousDecision(entry),
    },
  });
  if (decision === null) return;
  autonomousInFlight = decision.id;
  const commandId = crypto.randomUUID();
  autonomousCommandId = commandId;
  autonomousStartedAt = Date.now();
  lastAutonomousAt = Date.now();
  server.publishDecision(decision);
  try {
    bridge.session.issue({
      v: 1,
      type: "cmd",
      id: commandId,
      decisionId: decision.id,
      op: decision.skill!.name,
      args: decision.skill!.args,
      priority: decision.priority,
      idempotencyKey: decision.skill!.idempotencyKey,
    });
  } catch (error) {
    autonomousInFlight = null;
    autonomousCommandId = null;
    const failed = persistent.show.settleDecision(decision.id, {
      status: "failed",
      errorCode:
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "E_INTERNAL",
      detail: error instanceof Error ? error.message : String(error),
      outcome: null,
      at: Date.now(),
    });
    if (failed) server.publishDecision(failed);
  }
  server.publishBridgeHealth(bridge.health());
}, 1_000);

const shutdown = async (): Promise<void> => {
  clearInterval(bridgePoll);
  clearInterval(autonomousLoop);
  retention.stop();
  voiceLink?.close();
  await ingressSupervisor.close();
  await server.close();
  persistent.close();
  process.exit(0);
};

void ingressSupervisor.configure(persistent.runtimeConfig.read().douyin);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
