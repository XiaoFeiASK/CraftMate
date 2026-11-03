import type {
  BridgeCapability,
  BridgeClientFrame,
  BridgeServerFrame,
  SkillCommand,
  SkillName,
} from "@craftmate/contracts";
import { bridgeServerFrameSchema } from "@craftmate/contracts";
import type { Clock, TimerScheduler } from "./types.ts";
import { systemTimers } from "./types.ts";

export interface SimBodyOptions {
  readonly token: string;
  readonly client?: string;
  readonly capabilities?: readonly BridgeCapability[];
  readonly skills?: readonly SkillName[];
  readonly clock?: Clock;
  readonly scheduler?: TimerScheduler;
  /** Emits frames to the coordinator. `send` must not throw on a closed socket. */
  readonly send: (frame: BridgeClientFrame) => void;
  readonly onCommand?: (frame: Extract<BridgeServerFrame, { type: "cmd" }>) => void;
  /** Simulated travel time per command; one tick is 50ms. */
  readonly ticksPerCommand?: number;
  readonly autoComplete?: boolean;
  readonly onOwnership?: (owner: "agent" | "operator" | "none", reason: string) => void;
}

const DEFAULT_CAPABILITIES: readonly BridgeCapability[] = [
  "sensor",
  "move",
  "mine",
  "camera",
  "hud",
];
const DEFAULT_SKILLS: readonly SkillName[] = ["goto", "look_at", "mine_block", "wait"];

interface RunningTask {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly taskId: string;
  readonly op: SkillName;
  tick: number;
  readonly totalTicks: number;
  lastPhase: string;
}

/**
 * Deterministic headless body. It exercises the same frame schema, ownership
 * and stop-on-disconnect rules as the Mod, without pretending to be Minecraft.
 */
export class SimBody {
  private readonly options: SimBodyOptions;
  private readonly clock: Clock;
  private readonly scheduler: TimerScheduler;
  private owner: "agent" | "operator" | "none" = "none";
  private tick = 0;
  private current: RunningTask | null = null;
  private nextTask = 1;
  private sequence = 0;
  private timer: unknown = null;
  private stepTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private lastServerFrameAt: number;
  private closed = false;
  private readonly pressed = new Set<string>();
  private readonly completedKeys = new Set<string>();
  private readonly cancelledTasks = new Set<string>();
  private readonly cancelledCommands = new Set<string>();

  constructor(options: SimBodyOptions) {
    this.options = options;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.scheduler = options.scheduler ?? systemTimers;
    this.lastServerFrameAt = this.clock.now();
  }

  start(now = this.clock.now()): void {
    void now;
    this.options.send({
      v: 1,
      type: "hello",
      token: this.options.token,
      client: this.options.client ?? "craftmate-sim",
      capabilities: [...(this.options.capabilities ?? DEFAULT_CAPABILITIES)],
      skills: [...(this.options.skills ?? DEFAULT_SKILLS)],
    });
    this.timer = this.scheduler.setInterval(() => this.heartbeat(), 250);
    this.watchdogTimer = this.scheduler.setInterval(() => this.checkServerWatchdog(), 100);
  }

  /**
   * Socket close in the body is local: a dropped control plane cannot keep a
   * key pressed. This method is called directly by the socket adapter and also
   * by an explicit test path.
   */
  onDisconnect(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseEverything();
    if (this.timer !== null) this.scheduler.clearInterval(this.timer);
    if (this.stepTimer !== null) this.scheduler.clearInterval(this.stepTimer);
    if (this.watchdogTimer !== null) this.scheduler.clearInterval(this.watchdogTimer);
    this.timer = null;
    this.stepTimer = null;
    this.watchdogTimer = null;
  }

  /** Local ownership change (a human touching input, or a hard stop). */
  setOwnership(owner: "agent" | "operator" | "none", reason: string): void {
    this.owner = owner;
    if (owner !== "agent") this.stopCurrent("ownership changed");
    this.options.onOwnership?.(owner, reason);
  }

  handle(raw: unknown): void {
    if (this.closed) return;
    const parsed = bridgeServerFrameSchema.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    this.lastServerFrameAt = this.clock.now();
    if (frame.type === "welcome") {
      // Matching a token proves identity, not permission to act. The server's
      // sticky owner survives reconnects and may still be operator or none.
      this.owner = frame.owner;
      if (frame.owner !== "agent") this.stopCurrent("handshake owner is not agent");
      return;
    }
    if (frame.type === "ownership") {
      this.owner = frame.owner;
      if (frame.owner !== "agent") this.stopCurrent(frame.reason);
      return;
    }
    if (frame.type === "cancel") {
      this.cancelledTasks.add(frame.taskId);
      if (frame.id !== undefined) this.cancelledCommands.add(frame.id);
      if (
        this.current?.taskId === frame.taskId ||
        (frame.id !== undefined && this.current?.commandId === frame.id)
      ) {
        this.stopCurrent(frame.reason);
      }
      return;
    }
    if (frame.type === "cmd") this.execute(frame);
  }

  /** Test/introspection view; never serialized across the wire. */
  state(): {
    readonly tick: number;
    readonly owner: string;
    readonly pressed: readonly string[];
    readonly task: RunningTask | null;
    readonly completed: readonly string[];
    readonly cancelled: readonly string[];
  } {
    return {
      tick: this.tick,
      owner: this.owner,
      pressed: [...this.pressed],
      task: this.current,
      completed: [...this.completedKeys],
      cancelled: [...this.cancelledTasks],
    };
  }

  /** Test/tool entry: pretend the body received a command frame. */
  issue(frame: Extract<BridgeServerFrame, { type: "cmd" }>): void {
    this.handle(frame);
  }

  /** Same local stop path used by the tick loop; exposed for deterministic tests. */
  checkWatchdog(): void {
    this.checkServerWatchdog();
  }

  private execute(frame: SkillCommand & { type: "cmd" }): void {
    if (this.cancelledCommands.has(frame.id)) {
      this.options.send({
        v: 1,
        type: "ack",
        id: frame.id,
        accepted: false,
        code: "E_CANCELLED",
        detail: "command was cancelled before it reached the body",
      });
      return;
    }
    if (this.owner !== "agent") {
      this.options.send({
        v: 1,
        type: "ack",
        id: frame.id,
        accepted: false,
        code: "E_PERMISSION",
        detail: `owner is ${this.owner}`,
      });
      return;
    }
    if (this.completedKeys.has(frame.idempotencyKey)) {
      this.options.send({
        v: 1,
        type: "ack",
        id: frame.id,
        accepted: false,
        code: "E_PRECONDITION",
        detail: "idempotency key already used",
      });
      return;
    }
    if (this.current) {
      this.options.send({
        v: 1,
        type: "ack",
        id: frame.id,
        accepted: false,
        code: "E_BUSY",
        detail: "body is busy",
      });
      return;
    }

    const taskId = `sim-${this.nextTask++}`;
    this.current = {
      commandId: frame.id,
      idempotencyKey: frame.idempotencyKey,
      taskId,
      op: frame.op,
      tick: 0,
      totalTicks: Math.max(1, this.options.ticksPerCommand ?? 4),
      lastPhase: "starting",
    };
    this.options.onCommand?.(frame);
    this.options.send({ v: 1, type: "ack", id: frame.id, accepted: true, taskId });
    this.pressFor(frame.op);
    this.options.send({
      v: 1,
      type: "progress",
      taskId,
      phase: "starting",
      done: 0,
      total: this.current.totalTicks,
      tick: this.tick,
    });
    if (this.options.autoComplete !== false) this.scheduleStep();
  }

  private scheduleStep(): void {
    if (this.stepTimer !== null) this.scheduler.clearInterval(this.stepTimer);
    this.stepTimer = this.scheduler.setInterval(() => {
      if (this.closed || !this.current) return;
      this.tick += 1;
      const task = this.current;
      task.tick += 1;
      const phase = task.op === "mine_block" ? "mining" : "traveling";
      task.lastPhase = phase;
      this.options.send({
        v: 1,
        type: "progress",
        taskId: task.taskId,
        phase,
        done: task.tick,
        total: task.totalTicks,
        tick: this.tick,
      });
      if (task.tick >= task.totalTicks) {
        this.releaseKeys();
        if (this.stepTimer !== null) this.scheduler.clearInterval(this.stepTimer);
        this.stepTimer = null;
        this.completedKeys.add(task.idempotencyKey);
        this.current = null;
        this.options.send({
          v: 1,
          type: "result",
          taskId: task.taskId,
          status: "completed",
          ticks: task.tick,
          data: { op: task.op },
        });
        this.options.send({
          v: 1,
          type: "event",
          seq: (this.sequence += 1),
          tick: this.tick,
          name: "task_completed",
          data: { taskId: task.taskId, op: task.op },
        });
      }
    }, 50);
  }

  private heartbeat(): void {
    if (this.closed) return;
    this.tick += 1;
    // The server watchdog measures silence since the last received frame,
    // not since the task began. Sending our own heartbeat must not keep a
    // dead control plane looking alive.
    this.options.send({ v: 1, type: "heartbeat", tick: this.tick, owner: this.owner });
  }

  /**
   * The body must stop on its own. Waiting for a `cancel` that cannot arrive
   * because the orchestrator is gone is how a character keeps walking into
   * lava after the operator closes the laptop.
   */
  private checkServerWatchdog(): void {
    if (this.closed || this.current === null) return;
    if (this.clock.now() - this.lastServerFrameAt < 500) return;
    this.lastServerFrameAt = this.clock.now();
    this.stopCurrent("server heartbeat missed");
    this.owner = "none";
    this.options.onOwnership?.("none", "server heartbeat missed");
  }

  /** A socket close means "let go of every input", not "wait for cancel". */
  private stopCurrent(reason: string): void {
    if (!this.current) {
      this.releaseEverything();
      return;
    }
    this.cancelledTasks.add(this.current.taskId);
    if (this.stepTimer !== null) this.scheduler.clearInterval(this.stepTimer);
    this.stepTimer = null;
    this.releaseEverything();
    this.current = null;
    void reason;
  }

  private releaseEverything(): void {
    this.pressed.clear();
    this.current = null;
  }

  private pressFor(op: SkillName): void {
    if (op === "goto" || op === "follow" || op === "flee") this.pressed.add("W");
    if (op === "mine_block" || op === "chop_tree") this.pressed.add("attack");
    if (op === "goto") this.pressed.add("sprint");
  }

  private releaseKeys(): void {
    this.pressed.clear();
  }
}

export interface VirtualTimerScheduler extends TimerScheduler {
  advance(ms: number): void;
  /** Run every callback scheduled at or before `now`. */
  pending(): number;
}

/** Deterministic scheduler used by sim tests and long-run samplers. */
export function createVirtualScheduler(now: () => number): VirtualTimerScheduler {
  let nextId = 1;
  const timers = new Map<number, { every: number; next: number; callback: () => void }>();
  return {
    setInterval(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { every: delayMs, next: now() + delayMs, callback });
      return id;
    },
    clearInterval(handle) {
      if (typeof handle === "number") timers.delete(handle);
    },
    advance(ms) {
      const target = now() + ms;
      let guard = 0;
      while (guard++ < 10_000) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.next <= target)
          .sort((left, right) => left[1].next - right[1].next)[0];
        if (!due) break;
        const [id, timer] = due;
        timer.next += timer.every;
        timer.callback();
        if (!timers.has(id)) continue;
      }
    },
    pending() {
      return timers.size;
    },
  };
}
