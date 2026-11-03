import type { Clock } from "@craftmate/agent/application";

const HOUR_MS = 60 * 60 * 1000;

export interface RetentionSweepOptions {
  /** Purges expired raw text and returns the number of sources purged. */
  readonly expire: (now: number) => number;
  readonly clock?: Clock;
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface RetentionSweep {
  runOnce(): number;
  start(): void;
  stop(): void;
}

/**
 * Hourly retention tick. The sweep is deliberately independent of the panel
 * timer so a busy event loop or a long show cannot silence the 24h promise.
 */
export function createRetentionSweep(options: RetentionSweepOptions): RetentionSweep {
  const clock = options.clock ?? { now: () => Date.now(), newId: () => crypto.randomUUID() };
  const intervalMs = options.intervalMs ?? HOUR_MS;
  const report = options.onError ?? ((error: unknown) => console.error("retention sweep failed", error));
  let timer: ReturnType<typeof setInterval> | null = null;

  const runOnce = (): number => {
    try {
      return options.expire(clock.now());
    } catch (error) {
      report(error);
      return 0;
    }
  };

  return {
    runOnce,
    start: () => {
      if (timer !== null) return;
      runOnce();
      timer = setInterval(runOnce, intervalMs);
      // A maintenance sweep must never keep the orchestrator alive on its own.
      timer.unref?.();
    },
    stop: () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
