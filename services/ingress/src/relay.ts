import type { AudienceEvent, IngressMetricsFrame } from "@craftmate/contracts";
import type { EventGate } from "./gate.ts";

type RecentFact = IngressMetricsFrame["recent"][number];

export interface RelayState {
  readonly received: number;
  readonly forwarded: number;
  readonly reconnects: number;
  /** Events admitted by the gate but not yet written to a live socket. */
  readonly buffered: number;
}

export interface Relay {
  readonly state: RelayState;
  /**
   * Applies the gate and returns frames ready for the live socket. An offline
   * call buffers, so the returned list is empty and `state.buffered` grows.
   */
  receive(event: AudienceEvent, live: boolean): readonly string[];
  /** Flushes buffered frames after a reconnect; returns the number sent. */
  flush(send: (frame: string) => void): number;
  noteReconnect(): void;
  /**
   * Starts a new room's counters. A reconfigured child may keep its socket,
   * so without this the new room would inherit the old room's throughput and
   * a duplicate from the previous room could suppress a real first comment.
   */
  reset(): void;
  stats(): {
    readonly queued: number;
    readonly dropped: number;
    readonly dropReasons: Readonly<Record<string, number>>;
  };
  metrics(state: {
    readonly state: IngressMetricsFrame["state"];
    readonly detail: string;
    readonly lastEventAt: number | null;
    readonly upstreamConnected: boolean;
  }): string;
}

export const BUFFER_CAPACITY = 64;
export const BUFFER_FULL_REASON = "relay buffer full";

/**
 * The single accounting point for the ingress process. A received event is
 * either forwarded, buffered, or explicitly dropped; there is deliberately no
 * fourth path where an admitted event disappears from every counter.
 */
export function createRelay(options: {
  readonly gate: Pick<
    EventGate,
    "admit" | "drain" | "stats" | "dropCounts" | "lastDropReason" | "reset"
  >;
  readonly capacity?: number;
  readonly now?: () => number;
}): Relay {
  const capacity = options.capacity ?? BUFFER_CAPACITY;
  const now = options.now ?? Date.now;
  const pending: string[] = [];
  let reported = new Set<string>();
  let recent: RecentFact[] = [];
  let counters = { received: 0, forwarded: 0, reconnects: 0 };
  let relayDropped = 0;

  function report(fact: RecentFact): void {
    const key = `${fact.id}\u0000${fact.at}\u0000${String(fact.accepted)}`;
    if (reported.has(key)) return;
    reported.add(key);
    recent.unshift(fact);
    if (recent.length > 12) recent.length = 12;
    if (reported.size > 512) {
      for (const entry of reported) {
        reported.delete(entry);
        if (reported.size <= 256) break;
      }
    }
  }

  function state(): RelayState {
    return {
      received: counters.received,
      forwarded: counters.forwarded,
      reconnects: counters.reconnects,
      buffered: pending.length,
    };
  }

  function receive(event: AudienceEvent, live: boolean): readonly string[] {
    counters.received += 1;
    const started = now();
    const accepted = options.gate.admit(event);
    if (!accepted) {
      report({
        at: started,
        id: event.id,
        kind: event.kind,
        accepted: false,
        reason: options.gate.lastDropReason(event.kind) ?? "gated",
        latencyMs: null,
      });
    }

    const frames: string[] = [];
    for (const admitted of options.gate.drain()) {
      const frame = JSON.stringify({ type: "event", payload: admitted });
      if (live) {
        counters.forwarded += 1;
        frames.push(frame);
        report({
          at: admitted.ts,
          id: admitted.id,
          kind: admitted.kind,
          accepted: true,
          reason: "",
          latencyMs: Math.max(0, started - admitted.ts),
        });
        continue;
      }
      if (pending.length < capacity) {
        pending.push(frame);
        report({
          at: admitted.ts,
          id: admitted.id,
          kind: admitted.kind,
          accepted: true,
          reason: "orchestrator offline · buffered",
          latencyMs: Math.max(0, started - admitted.ts),
        });
        continue;
      }
      // The gate admitted it, but the relay cannot deliver it. Report this as
      // a drop; silently forgetting it would make `received` exceed every
      // other counter with no explanation.
      relayDropped += 1;
      report({
        at: admitted.ts,
        id: admitted.id,
        kind: admitted.kind,
        accepted: false,
        reason: BUFFER_FULL_REASON,
        latencyMs: null,
      });
    }
    return frames;
  }

  function flush(send: (frame: string) => void): number {
    const frames = pending.splice(0);
    for (const frame of frames) send(frame);
    counters.forwarded += frames.length;
    return frames.length;
  }

  function stats(): {
    readonly queued: number;
    readonly dropped: number;
    readonly dropReasons: Readonly<Record<string, number>>;
  } {
    const gateStats = options.gate.stats();
    return {
      queued: gateStats.queued + pending.length,
      dropped: gateStats.dropped + relayDropped,
      dropReasons: {
        ...options.gate.dropCounts(),
        ...(relayDropped === 0 ? {} : { [BUFFER_FULL_REASON]: relayDropped }),
      },
    };
  }

  function metrics(input: {
    readonly state: IngressMetricsFrame["state"];
    readonly detail: string;
    readonly lastEventAt: number | null;
    readonly upstreamConnected: boolean;
  }): string {
    const totals = stats();
    return JSON.stringify({
      type: "metrics",
      payload: {
        state: input.state,
        detail: input.detail,
        lastEventAt: input.lastEventAt,
        received: counters.received,
        forwarded: counters.forwarded,
        queued: totals.queued,
        dropped: totals.dropped,
        dropReasons: totals.dropReasons,
        upstreamConnected: input.upstreamConnected,
        reconnects: counters.reconnects,
        recent: recent.slice(0, 12),
      },
    } satisfies { type: "metrics"; payload: IngressMetricsFrame });
  }

  return {
    get state() {
      return state();
    },
    receive,
    flush,
    noteReconnect: () => {
      counters.reconnects += 1;
    },
    reset: () => {
      options.gate.reset();
      pending.length = 0;
      reported = new Set<string>();
      recent = [];
      counters = { received: 0, forwarded: 0, reconnects: 0 };
      relayDropped = 0;
    },
    stats,
    metrics,
  };
}
