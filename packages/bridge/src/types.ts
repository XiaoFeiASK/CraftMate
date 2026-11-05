import type {
  BridgeCapability,
  BridgeErrorCode,
  Ownership,
  Priority,
  SkillCommand,
  SkillName,
} from "@craftmate/contracts";

export interface Clock {
  now(): number;
}

/** Real timers are injectable so protocol tests never wait on wall time. */
export const systemTimers: TimerScheduler = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface TimerScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ActionPort {
  /** Returns `created: false` when this idempotency key was already accepted. */
  begin(command: SkillCommand): { readonly id: string; readonly created: boolean };
  settle(
    attemptId: string,
    status: BridgeTerminalStatus,
    errorCode?: BridgeErrorCode,
    result?: Readonly<Record<string, unknown>>,
  ): void;
}

export interface AuditEvent {
  readonly type: "accepted" | "rejected" | "progress" | "settled" | "cancelled";
  readonly commandId: string;
  readonly taskId: string | null;
  readonly op: SkillName;
  readonly priority: Priority;
  readonly at: number;
  readonly status?: BridgeTerminalStatus;
  readonly detail?: string;
}

export interface AuditSink {
  record(event: AuditEvent): void;
}

export const TERMINAL_STATUSES = [
  "completed",
  "preempted",
  "cancelled",
  "failed",
  "timeout",
] as const;
export type BridgeTerminalStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminal(status: string): status is BridgeTerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export interface NegotiatedBody {
  readonly client: string;
  readonly capabilities: readonly BridgeCapability[];
  readonly skills: readonly SkillName[];
}

export interface CommandOutcome {
  readonly commandId: string;
  readonly taskId: string;
  /** Present when the command carried a decision, so callers can join them. */
  readonly decisionId?: string;
  readonly status: BridgeTerminalStatus;
  readonly errorCode?: string;
  readonly at: number;
  /** The body's own reason for a failure or safety cancel, when it gave one. */
  readonly detail?: string;
  /** Confirmed changes and unconfirmed submissions from the body. */
  readonly outcome?: Readonly<Record<string, unknown>>;
}

/** One body-owned progress fact, joined to the command that caused it. */
export interface CommandProgress {
  readonly commandId: string;
  readonly taskId: string;
  /** Present when the command carried a decision. */
  readonly decisionId?: string;
  readonly phase: string;
  readonly done: number;
  readonly total?: number;
  readonly at: number;
}

export interface OwnershipState {
  readonly owner: Ownership;
  readonly reason: string;
  readonly at: number;
}
