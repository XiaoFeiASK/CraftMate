import type {
  BridgeCapability,
  BridgeClientFrame,
  BridgeErrorCode,
  BridgeServerFrame,
  Ownership,
  SkillCommand,
  SkillName,
} from "@craftmate/contracts";
import { bridgeClientFrameSchema } from "@craftmate/contracts";
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
  type NegotiatedBody,
  type OwnershipState,
  type TimerScheduler,
} from "./types.ts";
import { systemTimers } from "./types.ts";

export const BRIDGE_LIMITS = {
  /** The body declares the heartbeat period; the coordinator enforces a ceiling. */
  heartbeatMs: 2_000,
  /** A missing body heartbeat for this long releases control locally. */
  watchdogMs: 500,
} as const;

export interface BodyTransport {
  send(frame: BridgeServerFrame): void;
  close(code: number, reason: string): void;
}

export interface BodyHealth {
  readonly connected: boolean;
  readonly client: string | null;
  readonly owner: Ownership;
  readonly capabilities: readonly BridgeCapability[];
  readonly skills: readonly SkillName[];
  readonly queued: number;
  readonly running: number;
  readonly tick: number;
  readonly lastSeenAt: number;
  readonly watchdogMs: number;
}

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
  readonly onOwnership?: (state: OwnershipState) => void;
  readonly onOutcome?: (outcome: CommandOutcome) => void;
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
  private body: NegotiatedBody | null = null;
  private ownership: OwnershipState;
  private readonly capabilities = new Set<BridgeCapability>();
  private readonly skills = new Set<SkillName>();
  private readonly sentCommands = new Set<string>();
  private readonly outcomes = new Set<string>();
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
    this.queue = new CommandQueue({ capacity: options.queueCapacity ?? 32 });
    this.ownership = { owner: "none", reason: "awaiting handshake", at: this.clock.now() };
    this.lastSeenAt = this.clock.now();
  }

  get negotiated(): NegotiatedBody | null {
    return this.body;
  }

  get currentOwnership(): OwnershipState {
    return this.ownership;
  }

  health(): BodyHealth {
    const active = this.queue.active();
    return {
      connected: !this.closed && this.body !== null,
      client: this.body?.client ?? null,
      owner: this.ownership.owner,
      capabilities: [...this.capabilities],
      skills: [...this.skills],
      queued: this.queue.queuedCount(),
      running: active.filter((record) => record.status === "running").length,
      tick: this.tick,
      lastSeenAt: this.lastSeenAt,
      watchdogMs: this.options.watchdogMs ?? BRIDGE_LIMITS.watchdogMs,
    };
  }

  /** Drives the heartbeat/tick loop in tests with a fake scheduler. */
  poll(now = this.clock.now()): void {
    if (this.closed || !this.body) return;
    const watchdogMs = this.options.watchdogMs ?? BRIDGE_LIMITS.watchdogMs;
    if (now - this.lastSeenAt >= watchdogMs) {
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
        break;
      case "ownership":
        this.setOwnership(parsed.data.owner, parsed.data.reason, "body");
        break;
      case "heartbeat":
        this.tick = Math.max(this.tick, parsed.data.tick);
        break;
      default:
        break;
    }
    this.pump(this.clock.now());
  }

  /** Returns the command id, or throws a typed BridgeError. */
  issue(command: SkillCommand): string {
    if (this.closed) throw new BridgeError("E_CANCELLED", "bridge session is closed");
    if (!this.body) throw new BridgeError("E_PERMISSION", "body has not completed hello");
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
      accepted = this.queue.accept({ ...command, deadlineTick }, attempt.id, this.clock.now());
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
    this.transport.send({ v: 1, type: "cancel", taskId: record.taskId, reason });
  }

  /** Operator takeover cancels current work and keeps the queue. */
  takeOver(reason = "operator takeover"): void {
    const active = this.queue.active().filter((record) => record.status === "running");
    for (const record of active) {
      this.settle(record, "cancelled", "E_CANCELLED", reason, true);
      this.transport.send({ v: 1, type: "cancel", taskId: record.taskId, reason });
    }
    this.setOwnership("operator", reason, "orchestrator");
  }

  release(): void {
    this.setOwnership("agent", "operator released control", "orchestrator");
    this.pump(this.clock.now());
  }

  emergencyStop(reason = "operator emergency stop"): void {
    const active = this.queue.active();
    for (const record of active) {
      this.settle(record, "cancelled", "E_CANCELLED", reason, true);
      this.transport.send({ v: 1, type: "cancel", taskId: record.taskId, reason });
    }
    this.setOwnership("none", reason, "orchestrator");
  }

  close(reason = "orchestrator closing"): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimers();
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
    this.ownership = { owner: "agent", reason: "handshake accepted", at: this.clock.now() };
    this.transport.send({
      v: 1,
      type: "welcome",
      sessionId: this.options.sessionId,
      capabilities: [...this.capabilities],
      skills: [...this.skills],
      heartbeatMs: this.options.heartbeatMs ?? BRIDGE_LIMITS.heartbeatMs,
      watchdogMs: this.options.watchdogMs ?? BRIDGE_LIMITS.watchdogMs,
    });
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
    this.audit("progress", record, undefined, `${frame.phase} ${frame.done}/${frame.total ?? "?"}`);
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
    if (this.closed || !this.body || this.ownership.owner !== "agent") return;
    if (this.queue.active().some((record) => record.status === "running")) return;
    const next = this.queue.peek();
    if (!next || this.sentCommands.has(next.command.id)) return;
    this.sentCommands.add(next.command.id);
    const frame: BridgeServerFrame = {
      v: 1,
      type: "cmd",
      id: next.command.id,
      op: next.command.op,
      args: next.command.args,
      priority: next.command.priority,
      idempotencyKey: next.command.idempotencyKey,
      ...(next.command.deadlineTick === undefined ? {} : { deadlineTick: next.command.deadlineTick }),
    };
    this.transport.send(frame);
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
    this.options.actions.settle(settled.attemptId, status, code, result);
    if (status !== "completed") this.sentCommands.delete(settled.command.id);
    this.audit("settled", settled, status, detail);
    this.options.onOutcome?.({
      commandId: settled.command.id,
      taskId: settled.taskId,
      status,
      at: this.clock.now(),
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
    this.ownership = { owner, reason, at: this.clock.now() };
    this.options.onOwnership?.(this.ownership);
    if (source === "orchestrator") {
      this.transport.send({ v: 1, type: "ownership", owner, reason });
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
    this.emergencyStop(reason);
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
          reason: "deadline passed",
        });
      }
      for (const record of this.queue.overdue(this.tick)) {
        this.settle(record, "timeout", "E_TIMEOUT", "deadline passed", false);
        this.transport.send({
          v: 1,
          type: "cancel",
          taskId: record.taskId,
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

export { CLOSE_PROTOCOL, CLOSE_REPLACED, CLOSE_UNAUTHORIZED };
