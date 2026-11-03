import type { BridgeErrorCode, SkillCommand } from "@craftmate/contracts";
import type { ActionPort, BridgeTerminalStatus, Clock } from "./types.ts";

export const systemClock: Clock = { now: () => Date.now() };

interface Attempt {
  id: string;
  command: SkillCommand;
  status: BridgeTerminalStatus | "queued";
  createdAt: number;
  settledAt: number | null;
  errorCode: BridgeErrorCode | null;
}

/**
 * In-memory action ledger for the simulator and tests. The real orchestrator
 * passes a SQLite-backed ActionPort instead; keeping this behind the port is
 * what stops the bridge package from writing tables directly.
 */
export class MemoryActionPort implements ActionPort {
  private readonly byKey = new Map<string, Attempt>();
  private readonly byId = new Map<string, Attempt>();
  private nextId = 1;

  begin(command: SkillCommand): { id: string; created: boolean } {
    const existing = this.byKey.get(command.idempotencyKey);
    if (existing) return { id: existing.id, created: false };
    const attempt: Attempt = {
      id: `attempt-${this.nextId++}`,
      command,
      status: "queued",
      createdAt: Date.now(),
      settledAt: null,
      errorCode: null,
    };
    this.byKey.set(command.idempotencyKey, attempt);
    this.byId.set(attempt.id, attempt);
    return { id: attempt.id, created: true };
  }

  settle(
    attemptId: string,
    status: BridgeTerminalStatus,
    errorCode?: BridgeErrorCode,
  ): void {
    const attempt = this.byId.get(attemptId);
    if (!attempt || attempt.settledAt !== null) return;
    attempt.status = status;
    attempt.settledAt = Date.now();
    attempt.errorCode = errorCode ?? null;
  }

  snapshot(): readonly Attempt[] {
    return [...this.byKey.values()];
  }
}
