import type { SkillCommand } from "@craftmate/contracts";
import { BridgeError } from "./errors.ts";
import { isTerminal, type BridgeTerminalStatus } from "./types.ts";

const PRIORITY_RANK: Record<SkillCommand["priority"], number> = {
  reflex: 0,
  operator: 1,
  safety: 2,
  promise: 3,
  plan: 4,
  vote: 5,
  command: 6,
  ambient: 7,
};

interface TaskRecord {
  readonly command: SkillCommand;
  readonly attemptId: string;
  taskId: string;
  status: BridgeTerminalStatus | "accepted" | "running";
  readonly acceptedAt: number;
  startedAt: number | null;
}

/**
 * Owns command lifecycle and the bounded waiting line. It deliberately has no
 * transport or game knowledge: the same rules apply to the sim and the Mod.
 */
export class CommandQueue {
  private readonly capacity: number;
  private readonly retainedLimit: number;
  private readonly terminalTasks: Array<{ taskId: string; status: BridgeTerminalStatus }> = [];
  private readonly byIdempotency = new Map<string, TaskRecord>();
  private readonly byCommand = new Map<string, TaskRecord>();
  private readonly byTask = new Map<string, TaskRecord>();
  private readonly queued: TaskRecord[] = [];
  private readonly history: TaskRecord[] = [];
  private readonly historyLimit: number;
  private nextTask = 1;

  constructor(options: { readonly capacity: number; readonly historyLimit?: number }) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new Error("queue capacity must be a positive integer");
    }
    this.capacity = options.capacity;
    this.historyLimit = options.historyLimit ?? 100;
    this.retainedLimit = options.historyLimit ?? 100;
  }

  /**
   * Idempotency is checked before capacity. Replaying a known command returns
   * its original task so a reconnecting client never executes it twice.
   */
  accept(command: SkillCommand, attemptId: string, now: number): {
    readonly record: TaskRecord;
    readonly duplicate: boolean;
    readonly preempted: readonly TaskRecord[];
  } {
    const existing = this.byIdempotency.get(command.idempotencyKey);
    if (existing) {
      return { record: existing, duplicate: true, preempted: [] };
    }
    let evicted: TaskRecord | null = null;
    if (this.active().length >= this.capacity) {
      const victim = [...this.queued].reverse().find((record) => record.status === "accepted");
      if (
        !victim ||
        PRIORITY_RANK[victim.command.priority] <= PRIORITY_RANK[command.priority]
      ) {
        throw new BridgeError("E_BUSY", `command queue is full (${this.capacity})`);
      }
      this.queued.splice(this.queued.indexOf(victim), 1);
      victim.status = "preempted";
      this.remember(victim);
      evicted = victim;
    }

    const record: TaskRecord = {
      command,
      attemptId,
      taskId: `task-${this.nextTask++}`,
      status: "accepted",
      acceptedAt: now,
      startedAt: null,
    };
    this.byIdempotency.set(command.idempotencyKey, record);
    this.byCommand.set(command.id, record);
    this.byTask.set(record.taskId, record);

    this.arrive(record);
    return { record, duplicate: false, preempted: evicted ? [evicted] : [] };
  }

  start(taskId: string, now: number): TaskRecord {
    const record = this.requireRunningCandidate(taskId);
    const index = this.queued.indexOf(record);
    if (index >= 0) this.queued.splice(index, 1);
    record.status = "running";
    record.startedAt = now;
    return record;
  }

  /**
   * The body owns the task id returned in `ack`. Until then the coordinator
   * uses a local placeholder; adopting the body id makes progress/result and
   * cancel all refer to the same task without inventing a second field.
   */
  adopt(commandId: string, taskId: string): TaskRecord {
    const record = this.byCommand.get(commandId);
    if (!record) throw new BridgeError("E_PRECONDITION", `unknown command ${commandId}`);
    if (record.taskId === taskId) return record;
    if (this.byTask.has(taskId)) {
      throw new BridgeError("E_PRECONDITION", `task id ${taskId} is already in use`);
    }
    this.byTask.delete(record.taskId);
    record.taskId = taskId;
    this.byTask.set(taskId, record);
    return record;
  }

  progress(taskId: string, now: number): TaskRecord {
    const record = this.byTask.get(taskId);
    if (!record) throw new BridgeError("E_PRECONDITION", `unknown task ${taskId}`);
    if (isTerminal(record.status)) {
      throw new BridgeError("E_WORLD_CHANGED", `task ${taskId} is already ${record.status}`);
    }
    if (record.status === "accepted") {
      const index = this.queued.indexOf(record);
      if (index >= 0) this.queued.splice(index, 1);
      record.status = "running";
      record.startedAt = now;
    }
    return record;
  }

  /**
   * First terminal state wins. Late acks from a cancelled task therefore
   * cannot revive it, which is what makes cancellation a real contract.
   */
  settle(taskId: string, status: BridgeTerminalStatus): TaskRecord {
    const record = this.byTask.get(taskId);
    if (!record) {
      const prior = this.terminalTasks.find((candidate) => candidate.taskId === taskId);
      if (prior) {
        const archived = this.history.find((candidate) => candidate.taskId === taskId);
        const existing = archived ?? ({ taskId, status: prior.status } as TaskRecord);
        if (prior.status === status) return existing;
        throw new BridgeError("E_WORLD_CHANGED", `task ${taskId} is already ${prior.status}`);
      }
      throw new BridgeError("E_PRECONDITION", `unknown task ${taskId}`);
    }
    if (isTerminal(record.status)) {
      if (record.status === status) return record;
      throw new BridgeError("E_WORLD_CHANGED", `task ${taskId} is already ${record.status}`);
    }
    const index = this.queued.indexOf(record);
    if (index >= 0) this.queued.splice(index, 1);
    record.status = status;
    // The task id can be a local placeholder until the body acks. Keep both
    // indexes usable so a late progress frame after cancellation is ignored
    // rather than mistaken for an unknown task.
    this.remember(record);
    return record;
  }

  cancelCommand(commandId: string): TaskRecord | null {
    const record = this.byCommand.get(commandId);
    if (!record) return null;
    if (isTerminal(record.status)) return record;
    return this.settle(record.taskId, "cancelled");
  }

  /** Cancel everything the Agent owns; the caller decides whether to keep the queue. */
  cancelAll(status: BridgeTerminalStatus = "cancelled"): readonly TaskRecord[] {
    return [...this.queued, ...this.byTask.values()]
      .filter((record, index, all) => all.indexOf(record) === index && !isTerminal(record.status))
      .map((record) => this.settle(record.taskId, status));
  }

  next(now: number): TaskRecord | null {
    const record = this.queued[0];
    if (!record) return null;
    if (this.expired(record, now)) {
      this.settle(record.taskId, "timeout");
      return this.next(now);
    }
    return record;
  }

  /** The earliest queued item, without changing its state. */
  peek(): TaskRecord | null {
    return this.queued[0] ?? null;
  }

  /**
   * Drop queued work whose deadline has passed. Running work is the body's
   * responsibility: the orchestrator cannot pretend a side effect stopped.
   */
  expire(now: number, tick: number): readonly TaskRecord[] {
    const expired: TaskRecord[] = [];
    for (const record of [...this.queued]) {
      if (!this.expired(record, now, tick)) continue;
      expired.push(this.settle(record.taskId, "timeout"));
    }
    return expired;
  }

  /** Running tasks past their tick deadline; the caller must send cancel. */
  overdue(tick: number): readonly TaskRecord[] {
    return this.active().filter(
      (record) =>
        record.status === "running" &&
        record.command.deadlineTick !== undefined &&
        record.command.deadlineTick < tick,
    );
  }

  active(): readonly TaskRecord[] {
    return [...this.byTask.values()].filter((record) => !isTerminal(record.status));
  }

  queuedCount(): number {
    return this.queued.length;
  }

  lookup(commandId: string): TaskRecord | null {
    return this.byCommand.get(commandId) ?? null;
  }

  lookupTask(taskId: string): TaskRecord | null {
    return (
      this.byTask.get(taskId) ??
      this.history.find((record) => record.taskId === taskId) ??
      null
    );
  }

  snapshot(): readonly TaskRecord[] {
    return [...this.history];
  }

  private arrive(record: TaskRecord): void {
    this.queued.push(record);
    this.queued.sort(
      (left, right) =>
        PRIORITY_RANK[left.command.priority] - PRIORITY_RANK[right.command.priority] ||
        left.acceptedAt - right.acceptedAt,
    );
  }

  private expired(record: TaskRecord, now: number, tick?: number): boolean {
    const deadline = record.command.deadlineTick;
    if (deadline === undefined) return false;
    return tick !== undefined ? deadline < tick : deadline * 50 < now - record.acceptedAt;
  }

  private requireRunningCandidate(taskId: string): TaskRecord {
    const record = this.byTask.get(taskId);
    if (!record) throw new BridgeError("E_PRECONDITION", `unknown task ${taskId}`);
    if (isTerminal(record.status)) {
      throw new BridgeError("E_WORLD_CHANGED", `task ${taskId} is already ${record.status}`);
    }
    return record;
  }

  private remember(record: TaskRecord): void {
    this.history.unshift(record);
    if (this.history.length > this.historyLimit) this.history.pop();
    // Terminal tasks must not keep growing byTask/byCommand for hours. The
    // body's idempotency key and the durable action row remain the authority;
    // keeping only a bounded in-memory window is enough for late-frame checks.
    this.byTask.delete(record.taskId);
    this.terminalTasks.unshift({ taskId: record.taskId, status: record.status as BridgeTerminalStatus });
    if (this.terminalTasks.length > this.retainedLimit) this.terminalTasks.pop();
    while (this.byCommand.size > this.retainedLimit) {
      const oldest = this.byCommand.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.byCommand.delete(oldest);
    }
    while (this.byIdempotency.size > this.retainedLimit) {
      const oldest = this.byIdempotency.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.byIdempotency.delete(oldest);
    }
  }
}

export type { TaskRecord };
