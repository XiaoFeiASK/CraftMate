import {
  MAX_UTTERANCE_CHARS,
  type PersonaProfile,
  type Priority,
  type VoiceEvent,
  type VoiceStatus,
  type VoiceUtterance,
} from "@craftmate/contracts";
import {
  TimeoutError,
  withTimeout,
  type AudioSink,
  type CommitmentGate,
  type TtsProvider,
} from "./provider.ts";
import { splitUtterance } from "./split.ts";

const PRIORITY_RANK: Record<Priority, number> = {
  reflex: 0,
  operator: 1,
  safety: 2,
  promise: 3,
  plan: 4,
  vote: 5,
  command: 6,
  ambient: 7,
};

interface Segment {
  readonly utterance: VoiceUtterance;
  readonly priority: Priority;
  readonly requestId: string;
  readonly order: number;
}

interface ProviderCircuit {
  failures: number;
  openUntil: number;
  lastErrorAt: number | null;
}

export interface VoiceEngineOptions {
  readonly clock?: { now(): number; newId(): string };
  readonly providers: readonly TtsProvider[];
  readonly sink: AudioSink;
  readonly commitmentGate?: CommitmentGate;
  readonly capacity?: number;
  readonly maxChars?: number;
  synthesisTimeoutMs?: number;
  readonly circuitThreshold?: number;
  readonly circuitCooldownMs?: number;
  readonly onEvent?: (event: VoiceEvent) => void;
}

export interface SpeakRequest {
  readonly text: string;
  readonly priority?: Priority;
  readonly decisionId?: string | null;
  readonly commitmentId?: string | null;
  readonly voice: PersonaProfile["voice"];
}

const systemClock = { now: () => Date.now(), newId: () => crypto.randomUUID() };

/**
 * Bounded, priority-aware speech queue.
 *
 * Invariants:
 * - Every segment emits `speaking` before synthesis, so a subtitle exists even
 *   when every provider fails.
 * - A segment never starts when its persisted commitment is missing.
 * - Preemption happens between segments; `stop()` aborts the current segment.
 * - Provider failures trip a per-provider circuit instead of retrying forever.
 */
export class VoiceEngine {
  private readonly clock: { now(): number; newId(): string };
  private providers: readonly TtsProvider[];
  private readonly sink: AudioSink;
  private readonly commitmentGate: CommitmentGate | undefined;
  private readonly capacity: number;
  private readonly maxChars: number;
  synthesisTimeoutMs: number;
  private readonly circuitThreshold: number;
  private readonly circuitCooldownMs: number;
  private readonly onEvent: ((event: VoiceEvent) => void) | undefined;
  private readonly listeners = new Set<(event: VoiceEvent) => void>();
  private readonly circuits = new Map<string, ProviderCircuit>();
  private queue: Segment[] = [];
  private current: { controller: AbortController; utterance: VoiceUtterance } | null = null;
  private running = false;
  private voice: PersonaProfile["voice"] | null = null;
  private sequence = 0;
  private spoken = 0;
  private failed = 0;
  private cancelled = 0;
  private dropped = 0;
  private lastSpokenAt: number | null = null;
  private degraded = false;
  private idleWaiters: (() => void)[] = [];

  constructor(options: VoiceEngineOptions) {
    this.clock = options.clock ?? systemClock;
    this.providers = options.providers;
    this.sink = options.sink;
    this.commitmentGate = options.commitmentGate;
    this.capacity = options.capacity ?? 32;
    this.maxChars = options.maxChars ?? MAX_UTTERANCE_CHARS;
    this.synthesisTimeoutMs = options.synthesisTimeoutMs ?? 8_000;
    this.circuitThreshold = options.circuitThreshold ?? 3;
    this.circuitCooldownMs = options.circuitCooldownMs ?? 30_000;
    this.onEvent = options.onEvent;
    for (const provider of this.providers) {
      this.circuits.set(provider.id, { failures: 0, openUntil: 0, lastErrorAt: null });
    }
  }

  subscribe(listener: (event: VoiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Applies a verified operator configuration. Any in-flight audio is from the
   * old endpoint, so stop it before swapping providers.
   */
  replaceProviders(providers: readonly TtsProvider[]): void {
    this.stop("TTS configuration changed");
    this.providers = providers;
    this.circuits.clear();
    for (const provider of providers) {
      this.circuits.set(provider.id, { failures: 0, openUntil: 0, lastErrorAt: null });
    }
    this.degraded = false;
    this.emitStatus();
  }

  /** Returns the number of segments accepted (0 when shed). */
  speak(request: SpeakRequest): number {
    this.voice = request.voice;
    const segments = splitUtterance(request.text, this.maxChars);
    if (segments.length === 0) return 0;

    const priority = request.priority ?? "plan";
    const requestId = this.clock.newId();
    const accepted: Segment[] = segments.map((text, index) => ({
      requestId,
      order: this.sequence++,
      priority,
      utterance: {
        id: `${requestId}-${index}`,
        text,
        priority,
        decisionId: request.decisionId ?? null,
        commitmentId: request.commitmentId ?? null,
        at: this.clock.now(),
      },
    }));

    const admitted: Segment[] = [];
    for (const segment of accepted) {
      if (this.queue.length >= this.capacity) {
        const victim = this.leastUrgent();
        if (!victim || PRIORITY_RANK[victim.priority] <= PRIORITY_RANK[segment.priority]) {
          this.dropped += 1;
          this.dispatch({
            type: "failed",
            utterance: segment.utterance,
            code: "E_QUEUE_FULL",
            detail: "语音队列已满，本条未排队",
          });
          continue;
        }
        this.queue = this.queue.filter((queued) => queued !== victim);
        this.dropped += 1;
        this.dispatch({
          type: "cancelled",
          utterance: victim.utterance,
          reason: "被更高优先级语音挤出队列",
        });
      }
      this.queue.push(segment);
      admitted.push(segment);
    }

    for (const segment of admitted) {
      this.dispatch({
        type: "queued",
        utterance: segment.utterance,
        position: this.queue.indexOf(segment),
      });
    }
    void this.pump();
    return admitted.length;
  }

  /** Immediate stop: aborts synthesis/playback and clears pending segments. */
  stop(reason = "operator stop"): void {
    const pending = this.queue;
    this.queue = [];
    for (const segment of pending) {
      this.cancelled += 1;
      this.dispatch({ type: "cancelled", utterance: segment.utterance, reason });
    }
    if (this.current) {
      this.cancelled += 1;
      this.dispatch({ type: "cancelled", utterance: this.current.utterance, reason });
      this.current.controller.abort(new Error(reason));
      this.current = null;
    }
    this.emitStatus();
    this.resolveIdle();
  }

  status(voice?: PersonaProfile["voice"]): VoiceStatus {
    void voice;
    const now = this.clock.now();
    const providers = this.providers.map((provider) => {
      const circuit = this.circuits.get(provider.id) ?? {
        failures: 0,
        openUntil: 0,
        lastErrorAt: null,
      };
      const open = circuit.openUntil > now;
      return {
        id: provider.id,
        state: open ? ("open" as const) : circuit.failures > 0 ? ("degraded" as const) : ("ok" as const),
        detail: open ? `熔断至 ${new Date(circuit.openUntil).toISOString()}` : "可用",
        failures: circuit.failures,
        lastErrorAt: circuit.lastErrorAt,
      };
    });
    const allOpen = providers.length > 0 && providers.every((provider) => provider.state === "open");
    const state = this.current
      ? "speaking"
      : allOpen || this.degraded
        ? "degraded"
        : "idle";
    return {
      state,
      detail:
        state === "speaking"
          ? "正在说话"
          : allOpen
            ? "所有 TTS 供应商已熔断"
            : this.degraded
              ? "上次语音合成或播放失败"
              : this.providers.length === 0
                ? "未配置实时语音，语音不可用"
                : "待命",
      queued: this.queue.length,
      spoken: this.spoken,
      failed: this.failed,
      cancelled: this.cancelled,
      dropped: this.dropped,
      providers,
      lastSpokenAt: this.lastSpokenAt,
    };
  }

  /** Resolves when the queue is empty and no segment is playing. */
  whenIdle(): Promise<void> {
    if (!this.running && this.current === null && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async pump(): Promise<void> {
    // A re-entrant call must not start a second consumer: the active loop will
    // pick up whatever was enqueued after it last checked.
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && this.voice) {
        this.queue.sort(
          (left, right) =>
            PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] || left.order - right.order,
        );
        const segment = this.queue.shift();
        if (!segment) break;
        await this.speakSegment(segment, this.voice);
      }
    } finally {
      this.running = false;
      this.current = null;
      this.emitStatus();
      this.resolveIdle();
    }
  }

  private async speakSegment(segment: Segment, voice: PersonaProfile["voice"]): Promise<void> {
    if (segment.utterance.commitmentId && this.commitmentGate) {
      if (!this.commitmentGate.isReserved(segment.utterance.commitmentId)) {
        this.fail(segment, "E_NOT_RESERVED", "承诺尚未持久化，拒绝播放");
        return;
      }
    }

    const controller = new AbortController();
    this.current = { controller, utterance: segment.utterance };
    const startedAt = this.clock.now();
    this.dispatch({ type: "speaking", utterance: segment.utterance, startedAt });
    this.emitStatus();

    let lastError: unknown = null;
    let audioReady = false;
    for (const provider of this.providers) {
      if (controller.signal.aborted) break;
      if (this.isCircuitOpen(provider.id)) continue;
      try {
        const request = {
          text: segment.utterance.text,
          voice,
          signal: controller.signal,
        };
        const stream =
          provider.stream && this.sink.playStream
            ? await withTimeout(
                provider.stream(request),
                this.synthesisTimeoutMs,
                controller.signal,
              )
            : null;
        const audio = stream
          ? null
          : await withTimeout(
              provider.synthesize(request),
              this.synthesisTimeoutMs,
              controller.signal,
            );
        audioReady = true;
        if (stream) {
          await this.sink.playStream!(
            stream,
            controller.signal,
            segment.utterance.text,
          );
        } else {
          await this.sink.play(audio!, controller.signal, segment.utterance.text);
        }
        this.recordSuccess(provider.id);
        this.spoken += 1;
        this.degraded = false;
        this.lastSpokenAt = this.clock.now();
        this.dispatch({
          type: "spoken",
          utterance: segment.utterance,
          finishedAt: this.clock.now(),
          latencyMs:
            (stream ? await stream.firstByteAt : audio!.firstByteAt) -
            startedAt,
          provider: provider.id,
        });
        return;
      } catch (error) {
        lastError = error;
        if (!controller.signal.aborted) this.recordFailure(provider.id);
      }
    }

    if (controller.signal.aborted) {
      // `stop()` already emitted the cancellation for the current utterance.
      return;
    }

    this.degraded = true;
    // The subtitle has already been shown. Distinguish a synthesis failure
    // from a playback failure so the operator knows whether to change vendor
    // or fix the audio route.
    const code = audioReady
      ? "E_AUDIO_PLAYBACK"
      : lastError instanceof TimeoutError
        ? "E_TTS_TIMEOUT"
        : "E_TTS_FAILED";
    this.fail(segment, code, describe(lastError));
  }

  private fail(segment: Segment, code: string, detail: string): void {
    this.failed += 1;
    this.dispatch({ type: "failed", utterance: segment.utterance, code, detail });
  }

  private isCircuitOpen(id: string): boolean {
    const circuit = this.circuits.get(id);
    return circuit !== undefined && circuit.openUntil > this.clock.now();
  }

  private recordSuccess(id: string): void {
    const circuit = this.circuits.get(id);
    if (!circuit) return;
    circuit.failures = 0;
    circuit.openUntil = 0;
  }

  private recordFailure(id: string): void {
    const circuit = this.circuits.get(id);
    if (!circuit) return;
    circuit.failures += 1;
    circuit.lastErrorAt = this.clock.now();
    if (circuit.failures >= this.circuitThreshold) {
      circuit.openUntil = this.clock.now() + this.circuitCooldownMs;
    }
  }

  private leastUrgent(): Segment | undefined {
    let victim: Segment | undefined;
    for (const segment of this.queue) {
      if (!victim || PRIORITY_RANK[segment.priority] > PRIORITY_RANK[victim.priority]) victim = segment;
    }
    return victim;
  }

  private emitStatus(): void {
    this.dispatch({ type: "status", status: this.status() });
  }

  private dispatch(event: VoiceEvent): void {
    this.onEvent?.(event);
    for (const listener of this.listeners) listener(event);
  }

  private resolveIdle(): void {
    if (this.running || this.current !== null || this.queue.length > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown TTS error");
}
