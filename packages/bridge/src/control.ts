import type { Ownership } from "@craftmate/contracts";
import type { Clock } from "./types.ts";

/**
 * Sticky operator intent. It deliberately outlives one WebSocket session:
 * a reconnect may replace the body connection but must not clear a takeover
 * or emergency stop.
 */
export type ControlPermission = "agent" | "operator" | "stopped";

export interface ControlSnapshot {
  readonly permission: ControlPermission;
  readonly generation: number;
  readonly reason: string;
  readonly at: number;
  /** A watchdog safety stop may resume once the body proves it is alive. */
  readonly recoverable: boolean;
}

export interface ControlAuthorityOptions {
  readonly clock?: Clock;
  readonly permission?: ControlPermission;
  readonly reason?: string;
}

const DEFAULT_CLOCK: Clock = { now: () => Date.now() };

export function ownerFor(permission: ControlPermission): Ownership {
  switch (permission) {
    case "agent":
      return "agent";
    case "operator":
      return "operator";
    case "stopped":
      return "none";
  }
}

/**
 * One authority belongs to one logical body, not to one socket. Every explicit
 * control change advances the generation so callers can discard work that was
 * authorised before a takeover, stop or reconnect.
 */
export class ControlAuthority {
  private readonly clock: Clock;
  private permission: ControlPermission;
  private generation = 1;
  private reason: string;
  private at: number;
  private recoverable = false;

  constructor(options: ControlAuthorityOptions = {}) {
    this.clock = options.clock ?? DEFAULT_CLOCK;
    this.permission = options.permission ?? "agent";
    this.reason = options.reason ?? "initial";
    this.at = this.clock.now();
  }

  get current(): ControlSnapshot {
    return {
      permission: this.permission,
      generation: this.generation,
      reason: this.reason,
      at: this.at,
      recoverable: this.recoverable,
    };
  }

  takeOver(reason = "operator takeover"): ControlSnapshot {
    return this.set("operator", reason);
  }

  release(reason = "operator released control"): ControlSnapshot {
    return this.set("agent", reason);
  }

  emergencyStop(reason = "operator emergency stop"): ControlSnapshot {
    return this.set("stopped", reason);
  }

  /**
   * Stop because the body stopped proving it is alive. Unlike an operator
   * emergency stop, this clears itself when the body heartbeats again.
   */
  safetyStop(reason = "body heartbeat missed"): ControlSnapshot {
    const snapshot = this.set("stopped", reason);
    this.recoverable = true;
    return snapshot;
  }

  /**
   * A dropped socket invalidates in-flight authorisations but keeps the
   * operator's intent. Reconnecting after a normal transport failure can
   * resume agent control; reconnecting after takeover or stop cannot.
   */
  transportLost(reason = "transport lost"): ControlSnapshot {
    return this.bump(reason);
  }

  private set(permission: ControlPermission, reason: string): ControlSnapshot {
    this.permission = permission;
    this.recoverable = false;
    return this.bump(reason);
  }

  private bump(reason: string): ControlSnapshot {
    this.generation += 1;
    this.reason = reason;
    this.at = this.clock.now();
    return this.current;
  }
}
