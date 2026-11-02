import type { AudienceEvent } from "@craftmate/contracts";

export interface GateOptions {
  /** Bounded queue; overflow drops the cheapest events instead of growing. */
  readonly capacity?: number;
  /** Total events accepted per second before shedding. */
  readonly perSecond?: number;
  /** In-process duplicate window, the cheap half of dedupe. */
  readonly dedupeWindowMs?: number;
  readonly onDrop?: (kind: string, reason: string) => void;
}

/**
 * Backpressure and the first dedupe layer.
 *
 * SQLite's unique index is the authoritative dedupe; this only spares the
 * database a reconnect replay. Shedding order matters: gift and viewer_count
 * carry information that cannot be re-derived, while chat can wait.
 */
export class EventGate {
  private readonly capacity: number;
  private readonly perSecond: number;
  private readonly dedupeWindowMs: number;
  private readonly seen = new Map<string, number>();
  private windowStart = 0;
  private windowCount = 0;
  private queue: AudienceEvent[] = [];
  private dropped = 0;

  constructor(private readonly options: GateOptions = {}) {
    this.capacity = options.capacity ?? 512;
    this.perSecond = options.perSecond ?? 50;
    this.dedupeWindowMs = options.dedupeWindowMs ?? 10 * 60_000;
  }

  /** Returns false when the event should not reach the orchestrator. */
  admit(event: AudienceEvent, now = Date.now()): boolean {
    const key = `${event.kind}:${event.id}`;
    const seenAt = this.seen.get(key);
    if (seenAt !== undefined && now - seenAt < this.dedupeWindowMs) {
      this.report(event.kind, "duplicate");
      return false;
    }
    this.seen.set(key, now);
    if (this.seen.size > 20_000) this.prune(now);

    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    if (this.windowCount > this.perSecond && !isPrecious(event)) {
      this.report(event.kind, "rate limited");
      return false;
    }

    if (this.queue.length >= this.capacity) {
      const victim = this.queue.findIndex((queued) => !isPrecious(queued));
      if (victim === -1) {
        this.report(event.kind, "queue full");
        return false;
      }
      this.queue.splice(victim, 1);
      this.dropped += 1;
    }
    this.queue.push(event);
    return true;
  }

  drain(): AudienceEvent[] {
    const queued = this.queue;
    this.queue = [];
    return queued;
  }

  stats(): { readonly queued: number; readonly dropped: number } {
    return { queued: this.queue.length, dropped: this.dropped };
  }

  private prune(now: number): void {
    for (const [key, at] of this.seen) {
      if (now - at >= this.dedupeWindowMs) this.seen.delete(key);
    }
  }

  private report(kind: string, reason: string): void {
    this.dropped += 1;
    this.options.onDrop?.(kind, reason);
  }
}

function isPrecious(event: AudienceEvent): boolean {
  return event.kind === "gift" || event.kind === "viewer_count";
}
