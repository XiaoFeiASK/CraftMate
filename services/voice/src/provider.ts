export interface TtsRequest {
  readonly text: string;
  readonly voice: { readonly provider: string; readonly voiceId: string; readonly speed: number };
  readonly signal: AbortSignal;
}

export interface TtsAudio {
  readonly bytes: Uint8Array;
  /** Monotonic clock value when the first audio byte became available. */
  readonly firstByteAt: number;
  readonly mediaType: string;
}

export interface TtsStreamFormat {
  /** Raw little-endian signed 16-bit PCM, delivered incrementally. */
  readonly mediaType: "audio/pcm_s16le";
  readonly sampleRate: number;
  readonly channels: 1;
  readonly bitsPerSample: 16;
}

export interface TtsStream {
  readonly format: TtsStreamFormat;
  readonly chunks: AsyncIterable<Uint8Array>;
  /** Resolves as soon as the upstream yields its first non-empty audio chunk. */
  readonly firstByteAt: Promise<number>;
}

export interface TtsProvider {
  readonly id: string;
  synthesize(request: TtsRequest): Promise<TtsAudio>;
  /**
   * Production providers expose incremental audio. `synthesize` remains the
   * small compatibility surface used by deterministic test providers.
   */
  stream?(request: TtsRequest): Promise<TtsStream>;
}

export interface AudioSink {
  /** Resolves when playback finishes or the signal aborts. */
  play(audio: TtsAudio, signal: AbortSignal, text?: string): Promise<void>;
  /** Starts playback while audio is still arriving from the provider. */
  playStream?(audio: TtsStream, signal: AbortSignal, text?: string): Promise<void>;
}

/** A persisted commitment must exist before its utterance may be spoken. */
export interface CommitmentGate {
  isReserved(commitmentId: string): boolean;
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`TTS timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
