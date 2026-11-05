import type {
  BridgeCapability,
  BridgeClientFrame,
  BridgeErrorCode,
  BridgeServerFrame,
  Ownership,
  SkillCommand,
  SkillName,
  WorldSnapshot,
} from "@craftmate/contracts";
import { bridgeClientFrameSchema } from "@craftmate/contracts";
import {
  ControlAuthority,
  ownerFor,
  type ControlPermission,
  type ControlSnapshot,
} from "./control.ts";
import { BridgeError } from "./errors.ts";
import { CommandQueue, type TaskRecord } from "./queue.ts";
import {
  isTerminal,
  type ActionPort,
  type AuditEvent,
  type AuditSink,
  type BridgeTerminalStatus,
  type Clock,
  type CommandOutcome,
  type CommandProgress,
  type NegotiatedBody,
  type OwnershipState,
  type TimerScheduler,
} from "./types.ts";
import { systemTimers } from "./types.ts";
import {
  REFLEX_EVENT_NAME,
  reflexEventSchema,
  type BridgeHealth,
} from "@craftmate/contracts";

export const BRIDGE_LIMITS = {
  /** The body declares the heartbeat period; the coordinator enforces a ceiling. */
  heartbeatMs: 250,
  /** A missing body heartbeat for this long releases control locally. */
  watchdogMs: 2_000,
} as const;

export interface BodyTransport {
  send(frame: BridgeServerFrame): void;
  close(code: number, reason: string): void;
}

/**
 * The console contract is the single definition of this shape. Deriving it
 * here means a new incident kind cannot compile on one side and fail to parse
 * on the other.
 */
export type BodyHealth = BridgeHealth;
export type BodyIncident = BridgeHealth["incidents"][number];

export interface BodySessionOptions {
  readonly token: string;
  readonly sessionId: string;
  readonly transport: BodyTransport;
  readonly clock?: Clock;
  readonly scheduler?: TimerScheduler;
  readonly actions: ActionPort;
  readonly audit?: AuditSink;
  readonly queueCapacity?: number;
  readonly heartbeatMs?: number;
  readonly watchdogMs?: number;
  /** Shared across reconnects; omit to create a session-local authority. */
  readonly control?: ControlAuthority;
  readonly onOwnership?: (state: OwnershipState) => void;
  readonly onOutcome?: (outcome: CommandOutcome) => void;
  /** One body-reported progress fact, after its command was matched. */
  readonly onProgress?: (progress: CommandProgress) => void;
  /** Every body event, before the coordinator reacts to it. */
  readonly onEvent?: (event: { readonly name: string; readonly data: unknown }) => void;
}

export interface IssueOptions {
  /** Rejects work authorised before a takeover, stop or reconnect. */
  readonly expectedGeneration?: number;
}

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_PROTOCOL = 4400;
const CLOSE_REPLACED = 4409;

const OWNER_RANK: Record<Ownership, number> = { agent: 1, operator: 2, none: 0 };

/**
 * One connected game body. The coordinator is transport-agnostic so the same
 * logic drives the simulator and the real Minecraft adapter.
 */
export class BodySession {
  private readonly options: BodySessionOptions;
  private readonly clock: Clock;
  private readonly scheduler: TimerScheduler;
  private readonly queue: CommandQueue;
  private readonly authority: ControlAuthority;
  private body: NegotiatedBody | null = null;
  private world: WorldSnapshot | null = null;
  private ownership: OwnershipState;
  private readonly capabilities = new Set<BridgeCapability>();
  private readonly skills = new Set<SkillName>();
  private readonly sentCommands = new Set<string>();
  private readonly outcomes = new Set<string>();
  private readonly incidents: BodyIncident[] = [];
  private heartbeatTimer: unknown = null;
  private tickTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private closed = false;
  private tick = 0;
  private lastSeenAt: number;

  constructor(options: BodySessionOptions) {
    this.options = options;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.scheduler = options.scheduler ?? systemTimers;
    // A reconnect creates a new session with a fresh queue. The body ack
    // adopts its own task id, but there is a window between welcome and ack
    // where a delayed old frame could otherwise match a reused `task-1`.
    this.queue = new CommandQueue({
      capacity: options.queueCapacity ?? 32,
      taskPrefix: `task-${crypto.randomUUID()}`,
    });
    this.authority = options.control ?? new ControlAuthority();
    this.ownership = { owner: "none", reason: "awaiting handshake", at: this.clock.now() };
    this.lastSeenAt = this.clock.now();
  }

  get negotiated(): NegotiatedBody | null {
    return this.body;
  }

  get currentOwnership(): OwnershipState {
    return this.ownership;
  }

  get control(): ControlSnapshot {
    return this.authority.current;
  }

  health(): BodyHealth {
    const active = this.queue.active();
    return {
      connected: !this.closed && this.body !== null,
      client: this.body?.client ?? null,
      owner: this.ownership.owner,
      skills: [...this.skills],
      world: this.world,
      queued: this.queue.queuedCount(),
      running: active.filter((record) => record.status === "running").length,
      tick: this.tick,
      lastSeenAt: this.lastSeenAt,
      watchdogMs: this.options.watchdogMs ?? BRIDGE_LIMITS.watchdogMs,
      permission: this.authority.current.permission,
      generation: this.authority.current.generation,
      incidents: [...this.incidents],
    };
  }

  /** Drives the heartbeat/tick loop in tests with a fake scheduler. */
  poll(now = this.clock.now()): void {
    if (this.closed || !this.body) return;
    const watchdogMs = this.options.watchdogMs ?? BRIDGE_LIMITS.watchdogMs;
    // The Minecraft client thread can block while creating or loading a world,
    // so its first heartbeat may arrive many seconds after hello. Do not turn
    // that expected startup pause into a sticky emergency stop. Once the body
    // has reported an in-world snapshot, the normal 2-second safety watchdog
    // applies to every missed heartbeat.
    if (this.world?.inWorld === true && now - this.lastSeenAt >= watchdogMs) {
      this.releaseToNone("body heartbeat missed");
    }
    this.pump(now);
  }

  handle(raw: unknown): void {
    if (this.closed) return;
    const parsed = bridgeClientFrameSchema.safeParse(raw);
    if (!parsed.success) {
      this.fail("E_SCHEMA", parsed.error.issues[0]?.message ?? "invalid frame", undefined);
      this.transport.close(CLOSE_PROTOCOL, "invalid frame");
      return;
    }

    if (parsed.data.type === "hello") {
      this.negotiate(parsed.data);
      return;
    }
    if (!this.body) {
      this.fail("E_PERMISSION", "hello required", parsed.data.type);
      this.transport.close(CLOSE_UNAUTHORIZED, "hello required");
      return;
    }
    this.lastSeenAt = this.clock.now();

    switch (parsed.data.type) {
      case "ack":
        this.onAck(parsed.data);
        break;
      case "progress":
        this.onProgress(parsed.data);
        break;
      case "result":
        this.onResult(parsed.data);
        break;
      case "event":
        // Events are acknowledged by sequence in the transport layer; the
        // coordinator keeps only the last tick for deadline checks.
        this.tick = Math.max(this.tick, parsed.data.tick);
        this.onBodyEvent(parsed.data);
        break;
      case "ownership":
        this.onBodyOwnership(parsed.data.owner, parsed.data.reason);
        break;
      case "heartbeat":
        this.tick = Math.max(this.tick, parsed.data.tick);
        this.resumeAfterLivenessStop();
        // A null/omitted world is an explicit delta, not evidence that no
        // snapshot exists. Only a fresh snapshot replaces the planner view.
        if (parsed.data.world !== null && parsed.data.world !== undefined) {
          this.world = parsed.data.world;
        }
        break;
      default:
        break;
    }
    this.pump(this.clock.now());
  }

  /** Returns the command id, or throws a typed BridgeError. */
  issue(command: SkillCommand, options: IssueOptions = {}): string {
    if (this.closed) throw new BridgeError("E_CANCELLED", "bridge session is closed");
    if (
      options.expectedGeneration !== undefined &&
      options.expectedGeneration !== this.authority.current.generation
    ) {
      throw new BridgeError(
        "E_PERMISSION",
        `stale control generation ${options.expectedGeneration} (current ${this.authority.current.generation})`,
      );
    }
    if (!this.body) throw new BridgeError("E_PERMISSION", "body has not completed hello");
    if (this.authority.current.permission !== "agent") {
      throw new BridgeError(
        "E_PERMISSION",
        `agent control is not permitted (${this.authority.current.permission})`,
      );
    }
    if (this.ownership.owner !== "agent") {
      throw new BridgeError("E_PERMISSION", `agent does not own the body (${this.ownership.owner})`);
    }
    if (!this.skills.has(command.op)) {
      throw new BridgeError("E_UNKNOWN_OP", `body did not advertise ${command.op}`);
    }
    const existing = this.queue.lookup(command.id);
    if (existing) {
      this.audit("rejected", existing, undefined, "command id replay");
      return command.id;
    }
    const deadlineTick = command.deadlineTick ?? this.tick + 20 * 30;
    if (command.deadlineTick !== undefined && command.deadlineTick <= this.tick) {
      throw new BridgeError("E_TIMEOUT", `deadline tick ${command.deadlineTick} already passed`);
    }

    let attempt: { id: string; created: boolean };
    try {
      attempt = this.options.actions.begin({ ...command, deadlineTick });
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : "E_INTERNAL";
      throw error instanceof BridgeError
        ? error
        : new BridgeError(code, error instanceof Error ? error.message : String(error));
    }

    let accepted: ReturnType<CommandQueue["accept"]>;
    try {
      accepted = this.queue.accept(
        { ...command, deadlineTick },
        attempt.id,
        this.clock.now(),
        command.deadlineTick === undefined,
      );
    } catch (error) {
      // The action port may have created a row before the queue rejected the
      // command. Closing it as failed is honest: no body side effect happened.
      this.options.actions.settle(attempt.id, "failed", "E_BUSY");
      throw error;
    }
    if (!attempt.created) {
      // A durable attempt row can outlive this in-memory task. Replaying it
      // must not reach the body again; the previous side effect is unknown,
      // so the honest answer is the original command id with no new send.
      this.audit("rejected", accepted.record, undefined, "idempotency replay");
      return command.id;
    }
    for (const victim of accepted.preempted) {
      this.audit("settled", victim, "preempted", "queue capacity");
      this.options.actions.settle(victim.attemptId, "preempted", "E_BUSY");
    }
    this.audit("accepted", accepted.record, undefined, attempt.created ? undefined : "duplicate");

    this.pump(this.clock.now());
    return command.id;
  }

  cancel(commandId: string, reason = "cancelled by orchestrator"): void {
    const record = this.queue.cancelCommand(commandId);
    if (!record) return;
    this.settle(record, "cancelled", "E_CANCELLED", reason, true);
    this.transport.send({ v: 1, type: "cancel", taskId: record.taskId, id: record.command.id, reason });
  }

  /**
   * Operator takeover invalidates everything authorised for the Agent. Queued
   * work is cancelled too: replaying a pre-takeover plan after release is
   * indistinguishable from a late model result.
   */
  takeOver(reason = "operator takeover"): void {
    this.cancelAuthorisedWork(reason);
    this.authority.takeOver(reason);
    this.setOwnership("operator", reason, "orchestrator");
  }

  release(reason = "operator released control"): void {
    this.authority.release(reason);
    this.setOwnership(ownerFor("agent"), reason, "orchestrator");
    this.pump(this.clock.now());
  }

  emergencyStop(reason = "operator emergency stop"): void {
    this.cancelAuthorisedWork(reason);
    this.authority.emergencyStop(reason);
    this.setOwnership(ownerFor("stopped"), reason, "orchestrator");
  }

  close(reason = "orchestrator closing"): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimers();
    this.authority.transportLost(reason);
    for (const record of this.queue.active()) {
      this.settle(record, "cancelled", "E_CANCELLED", reason, false);
    }
    this.transport.close(1001, reason);
  }

  private negotiate(hello: Extract<BridgeClientFrame, { type: "hello" }>): void {
    if (this.body) {
      this.fail("E_PERMISSION", "duplicate hello", "hello");
      this.transport.close(CLOSE_PROTOCOL, "duplicate hello");
      return;
    }
    if (!safeTokenEqual(hello.token, this.options.token)) {
      this.fail("E_PERMISSION", "invalid bridge token", "hello");
      this.transport.close(CLOSE_UNAUTHORIZED, "invalid token");
      return;
    }
    this.body = {
      client: hello.client,
      capabilities: [...hello.capabilities],
      skills: [...hello.skills],
    };
    for (const capability of hello.capabilities) this.capabilities.add(capability);
    for (const skill of hello.skills) this.skills.add(skill);
    this.lastSeenAt = this.clock.now();
    const permission = this.authority.current.permission;
    const owner = ownerFor(permission);
    const reason =
      permission === "agent" ? "handshake accepted" : this.authority.current.reason;
    this.installOwnership(owner, reason);
    this.transport.send({
      v: 1,
      type: "welcome",
      sessionId: this.options.sessionId,
      owner,
      generation: this.authority.current.generation,
      capabilities: [...this.capabilities],
      skills: [...this.skills],
      heartbeatMs: this.options.heartbeatMs ?? BRIDGE_LIMITS.heartbeatMs,
      watchdogMs: this.options.watchdogMs ?? BRIDGE_LIMITS.watchdogMs,
    });
    if (owner !== "agent") {
      this.transport.send({ v: 1, type: "ownership", owner, reason });
    }
    this.startTimers();
  }

  private onAck(frame: Extract<BridgeClientFrame, { type: "ack" }>): void {
    const record = this.queue.lookup(frame.id);
    if (!record) {
      this.fail("E_PRECONDITION", `ack for unknown command ${frame.id}`, frame.id);
      return;
    }
    if (isTerminal(record.status)) {
      // A duplicate ack after a result is harmless.
      return;
    }
    if (!frame.accepted) {
      this.settle(record, "failed", frame.code ?? "E_PRECONDITION", frame.detail ?? "rejected", true);
      return;
    }
    if (frame.taskId === undefined) {
      this.settle(record, "failed", "E_SCHEMA", "accepted ack requires taskId", true);
      return;
    }
    const adopted = this.queue.adopt(record.command.id, frame.taskId);
    // The body may ack a command the orchestrator already timed out or
    // cancelled while it was queued. Stop it before it produces a side effect.
    if (adopted.status === "cancelled" || adopted.status === "timeout" || adopted.status === "preempted") {
      this.transport.send({
        v: 1,
        type: "cancel",
        taskId: frame.taskId,
        id: frame.id,
        reason: `already ${adopted.status} before ack`,
      });
      return;
    }
    try {
      this.queue.start(frame.taskId, this.clock.now());
    } catch (error) {
      this.fail("E_PRECONDITION", error instanceof Error ? error.message : String(error), frame.id);
    }
  }

  private onProgress(frame: Extract<BridgeClientFrame, { type: "progress" }>): void {
    this.tick = Math.max(this.tick, frame.tick ?? 0);
    const record = this.task(frame.taskId);
    if (!record || isTerminal(record.status)) return;
    this.queue.progress(record.taskId, this.clock.now());
    this.queue.extend(record.taskId, this.tick + 20 * 30);
    this.audit("progress", record, undefined, `${frame.phase} ${frame.done}/${frame.total ?? "?"}`);
    this.options.onProgress?.({
      commandId: record.command.id,
      taskId: record.taskId,
      ...(record.command.decisionId === undefined
        ? {}
        : { decisionId: record.command.decisionId }),
      phase: frame.phase,
      done: frame.done,
      ...(frame.total === undefined ? {} : { total: frame.total }),
      at: this.clock.now(),
    });
  }

  /**
   * A reflex event means the body is taking damage now. Continuing a queued
   * walk or dig through that would be the same mistake a human player makes
   * when they keep mining while standing in lava, so it outranks every skill
   * the agent issued. The body has already stopped its own input; this only
   * keeps the orchestrator's book honest and visible.
   */
  private onBodyEvent(frame: Extract<BridgeClientFrame, { type: "event" }>): void {
    this.options.onEvent?.({ name: frame.name, data: frame.data });
    if (frame.name !== REFLEX_EVENT_NAME) return;
    // A body that has not been granted control is not allowed to make the
    // orchestrator cancel an operator's work under the name "safety".
    if (this.ownership.owner === "operator" || this.authority.current.permission !== "agent") {
      return;
    }
    const parsed = reflexEventSchema.safeParse(frame.data);
    if (!parsed.success) {
      this.fail("E_SCHEMA", `invalid reflex event: ${parsed.error.issues[0]?.message ?? "unknown"}`, undefined);
      return;
    }
    const detail = parsed.data.detail;
    this.rememberIncident(parsed.data.kind, detail);
    for (const record of this.queue.active()) {
      const reachedBody = record.status === "running" || this.sentCommands.has(record.command.id);
      this.settle(record, "failed", "E_PRECONDITION", `safety: ${detail}`, true);
      if (reachedBody) {
        this.transport.send({
          v: 1,
          type: "cancel",
          taskId: record.taskId,
          id: record.command.id,
          reason: `safety: ${detail}`,
        });
      }
    }
  }

  private rememberIncident(kind: BodyIncident["kind"], detail: string): void {
    this.incidents.push({ kind, detail, at: this.clock.now() });
    // The console only needs the recent past; an unbounded list would grow
    // for the whole show and make every health broadcast heavier.
    if (this.incidents.length > 24) this.incidents.splice(0, this.incidents.length - 24);
  }

  private onResult(frame: Extract<BridgeClientFrame, { type: "result" }>): void {
    const record = this.task(frame.taskId);
    if (!record) return;
    if (isTerminal(record.status)) return;
    if (!isTerminal(frame.status)) {
      this.settle(record, "failed", "E_SCHEMA", `invalid result status ${frame.status}`, true);
      return;
    }
    this.settle(record, frame.status, frame.code, frame.detail, false, frame.data);
  }

  /**
   * Send the next waiting command only when the body has nothing running.
   * The body also enforces this, but keeping the orchestrator side single-flight
   * makes ACK/progress/result ordering testable.
   */
  private pump(now: number): void {
    if (
      this.closed ||
      !this.body ||
      this.authority.current.permission !== "agent" ||
      this.ownership.owner !== "agent"
    ) {
      return;
    }
    if (this.queue.active().some((record) => record.status === "running")) return;
    const next = this.queue.peek();
    if (!next || this.sentCommands.has(next.command.id)) return;
    this.sentCommands.add(next.command.id);
    const frame: BridgeServerFrame = {
      v: 1,
      type: "cmd",
      id: next.command.id,
      ...(next.command.decisionId === undefined ? {} : { decisionId: next.command.decisionId }),
      op: next.command.op,
      args: next.command.args,
      priority: next.command.priority,
      idempotencyKey: next.command.idempotencyKey,
      ...(next.command.deadlineTick === undefined ? {} : { deadlineTick: next.command.deadlineTick }),
    };
    try {
      this.transport.send(frame);
    } catch (error) {
      this.settle(
        next,
        "failed",
        "E_INTERNAL",
        `could not deliver command: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    void now;
  }

  private task(taskId: string): TaskRecord | null {
    return this.queue.lookupTask(taskId);
  }

  private settle(
    record: TaskRecord,
    status: BridgeTerminalStatus,
    code?: BridgeErrorCode,
    detail?: string,
    notifyBody = false,
    result?: Readonly<Record<string, unknown>>,
  ): void {
    let settled: TaskRecord;
    try {
      settled = this.queue.settle(record.taskId, status);
    } catch {
      // `expire()` and `cancelCommand()` settle the queue before the caller
      // reports the outcome. Reuse the record so the durable action row and
      // audit still move exactly once.
      settled = record;
    }
    if (this.outcomes.has(settled.taskId)) return;
    this.outcomes.add(settled.taskId);
    if (this.outcomes.size > 256) {
      const oldest = this.outcomes.keys().next().value as string | undefined;
      if (oldest !== undefined) this.outcomes.delete(oldest);
    }
    const evidence = withFailureDetail(result, status, detail);
    this.options.actions.settle(settled.attemptId, status, code, evidence);
    // `peek()` only ever returns queued work and `settle` removes it from that
    // queue, so a settled command can never be sent again. Keeping completed
    // ids around made this Set grow for the whole session.
    this.sentCommands.delete(settled.command.id);
    this.audit("settled", settled, status, detail);
    this.options.onOutcome?.({
      commandId: settled.command.id,
      taskId: settled.taskId,
      ...(settled.command.decisionId === undefined
        ? {}
        : { decisionId: settled.command.decisionId }),
      status,
      ...(code === undefined ? {} : { errorCode: code }),
      at: this.clock.now(),
      ...(detail === undefined ? {} : { detail }),
      ...(result === undefined ? {} : { outcome: result }),
    });
    // `notifyBody` is used by the orchestrator path. A body-originated result
    // must not receive its own cancel echo.
    void notifyBody;
  }

  private setOwnership(owner: Ownership, reason: string, source: "body" | "orchestrator"): void {
    const rank = OWNER_RANK[owner];
    if (rank < OWNER_RANK[this.ownership.owner] && source === "body") {
      this.fail("E_PERMISSION", `body cannot drop ownership from ${this.ownership.owner}`, undefined);
      return;
    }
    this.installOwnership(owner, reason);
    if (source === "orchestrator") {
      this.transport.send({ v: 1, type: "ownership", owner, reason });
    }
  }

  private installOwnership(owner: Ownership, reason: string): void {
    this.ownership = { owner, reason, at: this.clock.now() };
    this.options.onOwnership?.(this.ownership);
  }

  /**
   * The body may hand control to a human or stop itself, but it may never
   * grant itself Agent control after a takeover or emergency stop.
   */
  private onBodyOwnership(owner: Ownership, reason: string): void {
    if (owner === "agent") {
      if (this.authority.current.permission !== "agent") {
        this.fail("E_PERMISSION", "body cannot self-grant agent control", "ownership");
        this.transport.send({
          v: 1,
          type: "ownership",
          owner: ownerFor(this.authority.current.permission),
          reason: this.authority.current.reason,
        });
        return;
      }
      this.setOwnership(owner, reason, "body");
      this.pump(this.clock.now());
      return;
    }
    this.cancelAuthorisedWork(reason);
    if (owner === "operator") this.authority.takeOver(reason);
    else this.authority.emergencyStop(reason);
    this.setOwnership(owner, reason, "body");
  }

  private cancelAuthorisedWork(reason: string): void {
    for (const record of this.queue.active()) {
      const reachedBody = record.status === "running" || this.sentCommands.has(record.command.id);
      this.settle(record, "cancelled", "E_CANCELLED", reason, false);
      if (reachedBody) {
        this.transport.send({
          v: 1,
          type: "cancel",
          taskId: record.taskId,
          id: record.command.id,
          reason,
        });
      }
    }
  }

  private releaseToNone(reason: string): void {
    if (this.ownership.owner === "none" && reason === "body heartbeat missed") {
      // The body is already stopped. Reset the window so a silent connection
      // does not emit a release every poll.
      this.lastSeenAt = this.clock.now();
      return;
    }
    this.lastSeenAt = this.clock.now();
    this.cancelAuthorisedWork(reason);
    this.authority.safetyStop(reason);
    this.installOwnership(ownerFor("stopped"), reason);
  }

  private resumeAfterLivenessStop(): void {
    if (
      this.authority.current.permission !== "stopped" ||
      !this.authority.current.recoverable
    ) {
      return;
    }
    // A missed heartbeat is a safety stop, not an operator decision. Once
    // the body proves it is alive again, resume agent control so the next
    // comment can act without a manual reset.
    this.authority.release("heartbeat resumed");
    this.setOwnership(ownerFor("agent"), "heartbeat resumed", "orchestrator");
  }

  private startTimers(): void {
    this.stopTimers();
    const heartbeatMs = this.options.heartbeatMs ?? BRIDGE_LIMITS.heartbeatMs;
    this.heartbeatTimer = this.scheduler.setInterval(() => {
      if (this.closed || !this.body) return;
      this.transport.send({
        v: 1,
        type: "heartbeat",
        tick: this.tick,
        owner: this.ownership.owner,
      });
    }, heartbeatMs);
    this.tickTimer = this.scheduler.setInterval(() => {
      if (this.closed || !this.body) return;
      for (const record of this.queue.expire(this.clock.now(), this.tick)) {
        this.audit("settled", record, "timeout", "deadline passed");
        this.options.actions.settle(record.attemptId, "timeout", "E_TIMEOUT");
        this.transport.send({
          v: 1,
          type: "cancel",
          taskId: record.taskId,
          id: record.command.id,
          reason: "deadline passed",
        });
      }
      for (const record of this.queue.overdue(this.tick)) {
        this.settle(record, "timeout", "E_TIMEOUT", "deadline passed", false);
        this.transport.send({
          v: 1,
          type: "cancel",
          taskId: record.taskId,
          id: record.command.id,
          reason: "deadline passed",
        });
      }
    }, 50);
    const watchdogMs = this.options.watchdogMs ?? BRIDGE_LIMITS.watchdogMs;
    this.watchdogTimer = this.scheduler.setInterval(
      () => this.poll(this.clock.now()),
      Math.max(10, Math.min(100, Math.floor(watchdogMs / 4))),
    );
  }

  private stopTimers(): void {
    if (this.heartbeatTimer !== null) this.scheduler.clearInterval(this.heartbeatTimer);
    if (this.tickTimer !== null) this.scheduler.clearInterval(this.tickTimer);
    if (this.watchdogTimer !== null) this.scheduler.clearInterval(this.watchdogTimer);
    this.heartbeatTimer = null;
    this.tickTimer = null;
    this.watchdogTimer = null;
  }

  private fail(code: BridgeErrorCode, detail: string, id: string | undefined): void {
    const frame: BridgeServerFrame = { v: 1, type: "error", code, detail };
    this.transport.send(id === undefined ? frame : { ...frame, id });
  }

  private audit(
    type: AuditEvent["type"],
    record: TaskRecord,
    status?: BridgeTerminalStatus,
    detail?: string,
  ): void {
    this.options.audit?.record({
      type,
      commandId: record.command.id,
      taskId: record.taskId,
      op: record.command.op,
      priority: record.command.priority,
      at: this.clock.now(),
      ...(status === undefined ? {} : { status }),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  private get transport(): BodyTransport {
    return this.options.transport;
  }
}

/** Constant-time comparison avoids a timing oracle on a local token. */
function safeTokenEqual(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < given.length; index += 1) {
    diff |= given.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * A terminal failure must survive in the durable attempt row. The body's
 * result data carries success evidence; when there is none, preserve the
 * coordinator's reason instead of leaving only an opaque error code.
 */
function withFailureDetail(
  result: Readonly<Record<string, unknown>> | undefined,
  status: BridgeTerminalStatus,
  detail: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (status === "completed" || detail === undefined) return result;
  return { ...result, detail };
}

export { CLOSE_PROTOCOL, CLOSE_REPLACED, CLOSE_UNAUTHORIZED };
