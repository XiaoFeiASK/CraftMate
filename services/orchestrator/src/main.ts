import { createControlServer } from "./transport/control-server.ts";
import { createPersistentShow } from "./persistence.ts";
import { createRetentionSweep } from "./retention.ts";
import { loadOrCreateToken } from "@craftmate/local-auth";
import { connectVoice } from "./transport/voice-link.ts";
import { GoalSpeechGate } from "./transport/goal-speech.ts";
import { createOps } from "./ops.ts";
import { createBridgeUpgrade, SqliteActionPort } from "@craftmate/bridge";
import { loadOrCreateBridgeToken } from "@craftmate/bridge";
import { createIngressSupervisor } from "./ingress-supervisor.ts";
import {
  AgentTelemetry,
  dispatchDirectSkill,
  failDirectDispatch,
  notConfiguredIngress,
  projectIngressFacts,
  taskProgressSummary,
  taskSettledSummary,
  TaskTelemetry,
  TaskDispatchError,
  unknownIngress,
} from "./telemetry.ts";
import {
  completionEvidenceProblem,
  type GoalChange,
  type GoalInterruption,
} from "@craftmate/agent/application";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { skillOutcomeSchema } from "@craftmate/contracts";

const port = Number(process.env.CRAFTMATE_PORT ?? 4321);
// Loopback by default. Set CRAFTMATE_HOST=0.0.0.0 only when another device
// or a container needs to reach the socket.
const host = process.env.CRAFTMATE_HOST ?? "127.0.0.1";
const ingressToken = loadOrCreateToken();
// The bridge is assigned before the HTTP server starts accepting traffic.
// The planner reads only the last semantic heartbeat snapshot from it.
let bridge: ReturnType<typeof createBridgeUpgrade>;
const persistent = createPersistentShow({
  world: () => bridge?.health().world ?? null,
  availableSkills: () => bridge?.health().skills ?? [],
});
const retention = createRetentionSweep({ expire: (now) => persistent.expireRawText(now) });
retention.start();
const telemetry = new AgentTelemetry({
  store: persistent.agentEvents,
  history: persistent.agentEvents.recent(160),
});
/** Ingress facts already projected, so a metrics reconnect is not replayed. */
const ingressSeenAt = new Set<string>();
let voiceLink: ReturnType<typeof connectVoice> | null = null;
const goalSpeechGate = new GoalSpeechGate();
const ingressSupervisor = createIngressSupervisor({
  publishHealth: (health) => server.publishSourceHealth(health),
  onError: (detail) => console.warn(`orchestrator: ingress — ${detail}`),
});

/**
 * The supervisor knows the saved room, but the child owns the counters. Until
 * the child sends a metrics frame, this stays a truthful "not configured" or
 * "unknown" projection instead of a zero that looks healthy.
 */
function primeIngressProjection(): void {
  const config = persistent.runtimeConfig.read().douyin;
  if (config.roomId.length === 0) {
    telemetry.setIngress(notConfiguredIngress());
    server.publishTelemetry();
  }
}

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
    const changes = confirmedChanges(outcome.outcome);
    // The decision log is the operator-facing truth. A body "completed" with
    // no confirmed change must not be persisted as success just because its
    // goal runtime later refuses to advance.
    const missingEvidence =
      outcome.status === "completed" && decision !== undefined
        ? completionEvidenceProblem(decision, changes ?? [])
        : null;
    const status = missingEvidence === null ? outcome.status : "failed";
    const detail = missingEvidence ?? outcome.detail;
    const settled = decision
      ? persistent.show.settleDecision(decision.id, {
          status,
          ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
          ...(detail === undefined ? {} : { detail }),
          outcome: parsedOutcome?.success ? parsedOutcome.data : null,
          at: outcome.at,
        })
      : null;
    if (settled) server.publishDecision(settled);
    const taskId =
      outcome.decisionId === undefined
        ? outcome.taskId
        : taskTelemetry.taskId(outcome.decisionId) ?? outcome.taskId;
    // GoalRuntime settles independently of the audience decision stream so a
    // restart, takeover, or late frame cannot leave a goal task "running".
    if (outcome.decisionId !== undefined) {
      if (
        persistent.goals.settle(outcome.decisionId, {
          status,
          ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
          ...(detail === undefined ? {} : { detail }),
          at: outcome.at,
          ...(changes === undefined ? {} : { changes }),
          ...(parsedOutcome?.success && parsedOutcome.data.progress !== undefined
            ? { progress: parsedOutcome.data.progress }
            : {}),
          ...(parsedOutcome?.success && parsedOutcome.data.remaining !== undefined
            ? { remaining: parsedOutcome.data.remaining }
            : {}),
          ...(parsedOutcome?.success && parsedOutcome.data.resumable !== undefined
            ? { resumable: parsedOutcome.data.resumable }
            : {}),
          ...(parsedOutcome?.success && parsedOutcome.data.nextHint !== undefined
            ? { nextHint: parsedOutcome.data.nextHint }
            : {}),
        })
      ) {
        publishGoalSnapshot();
        if (
          persistent.show.recent().some((entry) => entry.id === outcome.decisionId)
        ) {
          server.publishAgentEvent({
            stage: "progress",
            status: status === "completed" ? "ok" : "failed",
            traceId: decision?.eventId ?? null,
            taskId,
            decisionId: outcome.decisionId,
            goalId: persistent.goals.currentGoal?.id ?? null,
            summary:
              status === "completed"
                ? "目标运行时观察到任务终态，准备重新规划"
                : "目标运行时已记录失败，进入退避与恢复",
            source: "goal",
          });
        }
      }
    }
    taskTelemetry.settled({
      decisionId: outcome.decisionId ?? null,
      traceId: settled?.eventId ?? decision?.eventId ?? null,
      taskId,
      status: status === "completed" ? "ok" : "failed",
      durationMs:
        settled?.outcome != null
          ? Math.max(0, settled.outcome.at - settled.at)
          : null,
      // Body detail stays in the durable decision evidence. The operator feed
      // gets only a fixed status label plus the closed error-code enum.
      summary: taskSettledSummary(status),
      errorCode: outcome.errorCode ?? null,
      source: "bridge",
    });
    // A body-originated failure is the only place some reasons survive. Give
    // the planner the game fact so the next line can be about what actually
    // happened rather than a generic apology.
    if (status !== "failed" || detail === undefined) return;
    persistent.show.recordIncident({
      kind: "blocked",
      detail,
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
    const reaction = persistent.show.reactToIncident({
      kind: data.kind,
      detail: data.detail,
      at: Date.now(),
    });
    if (reaction !== null) {
      server.publishDecision(reaction);
      voiceLink?.speak({
        text: reaction.speech,
        priority: "safety",
        decisionId: reaction.id,
        commitmentId: null,
      });
    }
    server.publishBridgeHealth(bridge.health());
  },
  onProgress: (progress) => {
    persistent.goals.noteProgress(progress.commandId);
    const decision = progress.decisionId === undefined
      ? null
      : persistent.show.recent().find((entry) => entry.id === progress.decisionId) ?? null;
    server.publishAgentEvent({
      stage: "progress",
      status: "ok",
      traceId: decision?.eventId ?? null,
      taskId:
        progress.decisionId === undefined
          ? progress.taskId
          : taskTelemetry.taskId(progress.decisionId) ?? progress.taskId,
      decisionId: progress.decisionId ?? null,
      goalId: persistent.goals.currentGoal?.id ?? null,
      summary: taskProgressSummary(progress.phase, progress.done, progress.total),
      source: decision?.eventId.startsWith("goal:") === true ? "goal" : "bridge",
    });
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

function publishGoalSnapshot(): void {
  const progress = persistent.goals.currentProgress;
  // The settings document stays the durable, operator-visible switch. The
  // runtime's enabled flag can additionally be false when no goal exists.
  persistent.show.setGoalMode(
    persistent.goals.isEnabled && persistent.show.currentSettings().goalMode,
  );
  persistent.show.setGoalProgress(progress);
  persistent.show.setSeasonGoal(persistent.goals.currentGoal);
  if (progress !== null) server.publishGoal?.(progress);
  server.publishProposals(persistent.show.proposals(null, 50));
}

/**
 * The bridge result record is untrusted. Only the typed `changes` array can
 * become completion evidence; free-form fields and `unconfirmed` never do.
 */
function confirmedChanges(
  value: Readonly<Record<string, unknown>> | undefined,
): readonly GoalChange[] | undefined {
  if (value === undefined || !Array.isArray(value["changes"])) return undefined;
  const parsed = skillOutcomeSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return parsed.data.changes;
}

function interruptGoal(
  interruption: GoalInterruption | null,
  reason: string,
  status: "cancelled" | "timeout" = "cancelled",
): void {
  if (interruption === null) return;
  try {
    bridge.session.cancel(interruption.commandId, reason);
  } catch (error) {
    console.warn(
      `orchestrator: could not cancel goal task — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const settled = persistent.show.settleDecision(interruption.decisionId, {
    status,
    errorCode: status === "timeout" ? "E_TIMEOUT" : "E_CANCELLED",
    detail: reason,
    outcome: null,
    at: Date.now(),
  });
  if (settled) server.publishDecision(settled);
  taskTelemetry.settled({
    decisionId: interruption.decisionId,
    traceId: settled?.eventId ?? interruption.decision.eventId,
    status: "skipped",
    summary: `${status === "timeout" ? "任务超时" : "任务被取消"}：${reason}`,
    errorCode: status === "timeout" ? "E_TIMEOUT" : "E_CANCELLED",
    source: "goal",
  });
}

function goalContext() {
  return {
    mode: persistent.show.snapshot().mode,
    bridge: bridge.health(),
    world: bridge.health().world,
  };
}

/**
 * Issues one goal task. The command id comes from GoalRuntime so takeover can
 * cancel exactly the command it observed, not a later replacement.
 */
let goalStepPlanning = false;

async function dispatchGoalStep(): Promise<void> {
  if (goalStepPlanning || server.isPlanning()) return;
  goalStepPlanning = true;
  try {
    const dispatch = await persistent.goals.beginStepAsync(goalContext());
    if (dispatch === null) {
      publishGoalSnapshot();
      return;
    }
    server.publishDecision(dispatch.decision);
    taskTelemetry.queued({
      decisionId: dispatch.decision.id,
      traceId: dispatch.decision.eventId,
      taskId: dispatch.taskId,
      goalId: persistent.goals.currentGoal?.id ?? null,
      summary: `目标任务已排队：${dispatch.decision.skill?.name ?? "未知动作"}`,
      source: "goal",
    });
    try {
      bridge.session.issue({
        v: 1,
        type: "cmd",
        id: dispatch.commandId,
        decisionId: dispatch.decision.id,
        op: dispatch.decision.skill!.name,
        args: dispatch.decision.skill!.args,
        priority: dispatch.decision.priority,
        idempotencyKey: dispatch.decision.skill!.idempotencyKey,
        ...(dispatch.decision.skill!.deadlineTicks === undefined
          ? {}
          : { deadlineTick: dispatch.decision.skill!.deadlineTicks }),
      });
      taskTelemetry.running({
        decisionId: dispatch.decision.id,
        traceId: dispatch.decision.eventId,
        taskId: dispatch.taskId,
        goalId: persistent.goals.currentGoal?.id ?? null,
        summary: `动作已下达：${dispatch.decision.skill!.name}`,
        source: "goal",
      });
      const speech = goalSpeechGate.take(dispatch.decision);
      if (speech !== null) {
        voiceLink?.speak({
          text: speech,
          priority:
            dispatch.decision.intent === "danger"
              ? "safety"
              : dispatch.decision.priority,
          decisionId: dispatch.decision.id,
          commitmentId: null,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      persistent.goals.failDispatch(dispatch.taskId, dispatch.strategyKey, detail);
      const failed = persistent.show.settleDecision(dispatch.decision.id, {
        status: "failed",
        errorCode:
          error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : "E_INTERNAL",
        detail,
        outcome: null,
        at: Date.now(),
      });
      if (failed) server.publishDecision(failed);
      taskTelemetry.settled({
        decisionId: dispatch.decision.id,
        traceId: dispatch.decision.eventId,
        taskId: dispatch.taskId,
        status: "failed",
        // The dispatch message can originate from the body; only the closed
        // error code is an operator-safe fact here.
        summary: "动作未下达",
        errorCode: "E_DISPATCH",
        source: "goal",
      });
    }
    publishGoalSnapshot();
    server.publishBridgeHealth(bridge.health());
  } finally {
    goalStepPlanning = false;
  }
}

const server = createControlServer({
  show: persistent.show,
  telemetry,
  settings: {
    saveSettings: (next) => persistent.saveSettings(next),
    saveIntegrationSettings: (next) => persistent.saveIntegrationSettings(next),
    readIntegrations: () => persistent.readIntegrations(),
    listModels: (input) => persistent.listModels(input),
    resetActivity: () => persistent.resetActivity(),
    // The save path applies title/goalMode and the runtime's own progress is
    // pushed through publishGoalSnapshot; a second projection here could race
    // with a pause or takeover that happened during the write.
  },
  port,
  host,
  ingressToken,
  allowRemoteIngress: process.env.CRAFTMATE_ALLOW_REMOTE_INGRESS === "1",
  allowRemoteControl: process.env.CRAFTMATE_ALLOW_REMOTE_CONTROL === "1",
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
  onSettingsApplied: () => publishGoalSnapshot(),
  ops,
  bridge,
  goalRuntime: {
    setGoal: (input) => {
      const result = persistent.goals.setGoal(input);
      const saved = persistent.saveSettings({
        ...persistent.show.currentSettings(),
        goal: input.title,
        goalDescription: input.description,
        goalMode: true,
      });
      if (saved === null) {
        // The settings document is the durable authority. If it rejects the
        // title, do not leave a goal the console will forget on restart.
        persistent.goals.pause("目标设置未通过校验");
        return null;
      }
      interruptGoal(result.interruption, "目标已更换");
      publishGoalSnapshot();
      return result.goal;
    },
    pause: () => {
      const interruption = persistent.goals.pause();
      persistent.saveSettings({
        ...persistent.show.currentSettings(),
        goalMode: false,
      });
      interruptGoal(interruption, "操作员暂停目标模式");
      publishGoalSnapshot();
    },
    resume: () => {
      persistent.saveSettings({
        ...persistent.show.currentSettings(),
        goalMode: true,
      });
      persistent.goals.resume();
      publishGoalSnapshot();
    },
    decideProposal: (proposalId, status, reason) =>
      persistent.show.decideProposal(proposalId, status, reason),
    queryProposals: (status, limit) => persistent.show.proposals(status, limit),
  },
  onOperator: (kind) => {
    if (kind === "takeover" || kind === "stop") {
      const interruption = persistent.goals.hold(
        kind === "takeover" ? "操作员接管，目标运行时暂停" : "急停，目标运行时暂停",
      );
      interruptGoal(interruption, kind === "takeover" ? "操作员接管" : "急停");
    } else {
      persistent.goals.resume();
    }
    publishGoalSnapshot();
  },
  dispatchSkill: (decision) => {
    if (decision.skill === null) return;
    const goalTask = persistent.goals.snapshot().currentDecisionId === decision.id;
    if (goalTask) return;
    // The body assigns its wire task id in the ack, after this call returns.
    // Until then the command id is the only stable operator join, so publish
    // it as the task id and never invent an id the body did not send.
    try {
      dispatchDirectSkill({
        decision: {
          id: decision.id,
          eventId: decision.eventId,
          skill: decision.skill,
          priority: decision.priority,
        },
        taskTelemetry,
        goalId: persistent.goals.currentGoal?.id ?? null,
        // Ownership is enforced by the coordinator: no body, no agent control,
        // or an operator takeover all reject here instead of at the game.
        issue: (command) => bridge.session.issue(command),
      });
    } catch (error) {
      if (!(error instanceof TaskDispatchError)) throw error;
      failDirectDispatch({
        taskTelemetry,
        decision: { id: decision.id, eventId: decision.eventId },
        error,
      });
      // Re-throw the typed bridge error so the control server persists the
      // decision outcome; the telemetry terminal row was already emitted.
      throw error;
    }
    server.publishBridgeHealth(bridge.health());
  },
  onIntegrationsChanged: (config) => {
    voiceLink?.configure(config.voice);
    // The old child's counters and fact keys describe a different room. Do not
    // relabel them as the new room while the supervisor reconnects.
    ingressSeenAt.clear();
    if (config.douyin.roomId.length === 0) telemetry.setIngress(notConfiguredIngress());
    else telemetry.setIngress(unknownIngress("Ingress 正在连接新配置"));
    server.publishTelemetry();
    void ingressSupervisor.configure(config.douyin);
  },
  onIngressMetrics: (metrics) => {
    // The child frame carries no room id; the orchestrator is the only process
    // that knows the saved configuration, so the join happens here.
    telemetry.setIngress({
      ...metrics,
      roomId: persistent.runtimeConfig.read().douyin.roomId || null,
      updatedAt: Date.now(),
    });
    // The child reports one bounded fact per admitted/dropped event. Its
    // projection is deduped in one place so a reconnect cannot replay history
    // and a drop never masquerades as an admitted fact.
    for (const event of projectIngressFacts(metrics.recent, ingressSeenAt)) {
      const recent = persistent.show.recent();
      const decision = recent.find((entry) => entry.eventId === event.traceId);
      server.publishAgentEvent({
        ...event,
        decisionId: decision?.id ?? null,
        taskId:
          decision === undefined ? null : taskTelemetry.taskId(decision.id),
      });
    }
  },
});

/**
 * The map is shared by dispatch, progress and terminal paths. It is created
 * after the server because publishing is a server operation, but the bridge
 * callbacks only run after the event loop starts.
 */
const taskTelemetry = new TaskTelemetry((event) => server.publishAgentEvent(event));

persistent.goals.setExpiryHandler((interruption) => {
  interruptGoal(interruption, "任务长时间没有终态，已取消身体上的旧动作", "timeout");
  publishGoalSnapshot();
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
    // `decisionId` is an internal id, not the audience trace. Resolve it so
    // voice events join the same replay row as the comment and its plan.
    const voiceDecision =
      subtitle.decisionId === null
        ? null
        : persistent.show.recent().find((entry) => entry.id === subtitle.decisionId) ?? null;
    server.publishAgentEvent({
      stage: subtitle.state === "speaking" ? "voice_started" : "voice_settled",
      status:
        subtitle.state === "spoken"
          ? "ok"
          : subtitle.state === "speaking"
            ? "ok"
            : subtitle.state === "cancelled"
              ? "skipped"
              : "failed",
      decisionId: subtitle.decisionId,
      traceId: voiceDecision?.eventId ?? null,
      taskId:
        subtitle.decisionId === null
          ? null
          : taskTelemetry.taskId(subtitle.decisionId),
      summary:
        subtitle.state === "speaking"
          ? "语音开始播放"
          : subtitle.state === "spoken"
            ? "语音播放完成"
            : `语音${subtitle.state === "cancelled" ? "已取消" : "失败"}`,
      errorCode: subtitle.code,
      source: "voice",
    });
    
    persistent.show.applyPlaybackFeedback(subtitle);
    server.publishStats();

  },
  onError: (detail) => console.warn(`orchestrator: voice error — ${detail}`),
});

const bridgePoll = setInterval(() => {
  const openBefore = persistent.show.snapshot().stats.openCommitments;
  persistent.reconcileCommitments();
  if (persistent.show.snapshot().stats.openCommitments !== openBefore) server.publishStats();
  server.publishBridgeHealth(bridge.health());
}, 2_000);

// Goal mode is the only unattended loop. It asks the runtime for one task at a
// time; the runtime refuses while paused, busy, backing off, or unverified.
const goalLoop = setInterval(() => {
  if (!persistent.goals.isEnabled) return;
  void dispatchGoalStep();
}, 250);

// Empty rooms used to mean silence. This ambient loop keeps the character
// present between comments; goal mode already narrates verified transitions.
const downtimeLoop = setInterval(() => {
  // Opt-in: a completely empty room can start the same kind of standing goal
  // dsh-mc-agent uses. Off by default because goal mode changes comment
  // handling from direct execution to the proposal inbox.
  if (
    process.env.CRAFTMATE_IDLE_GOAL === "1" &&
    !persistent.goals.isEnabled &&
    persistent.goals.currentGoal === null &&
    persistent.show.quietForMs() >= 90_000 &&
    bridge.health().connected &&
    bridge.health().world?.inWorld === true
  ) {
    const current = persistent.show.currentSettings();
    persistent.saveSettings({
      ...current,
      goalMode: true,
      goal: "空场自由生存",
      goalDescription: "没有观众指令时按生存阶段自己发展；观众评论仍然优先。",
    });
    publishGoalSnapshot();
  }
  const beat = persistent.show.downtimeBeat();
  if (beat === null) return;
  server.publishDecision(beat);
  voiceLink?.speak({
    text: beat.speech,
    priority: "ambient",
    decisionId: beat.id,
    commitmentId: null,
  });
}, 5_000);

const shutdown = async (): Promise<void> => {
  clearInterval(bridgePoll);
  clearInterval(goalLoop);
  clearInterval(downtimeLoop);
  retention.stop();
  voiceLink?.close();
  await ingressSupervisor.close();
  await server.close();
  persistent.close();
  process.exit(0);
};

void ingressSupervisor.configure(persistent.runtimeConfig.read().douyin);
primeIngressProjection();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
