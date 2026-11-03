import { spawn } from "node:child_process";
import type { AudioSink, TtsAudio, TtsProvider, TtsRequest } from "./provider.ts";

/**
 * macOS playback through `afplay`. The bytes are passed over stdin so no
 * temporary audio file is left behind on the live machine.
 */
export class CommandAudioSink implements AudioSink {
  private readonly command: string;
  private readonly args: readonly string[];

  constructor(command = "afplay", args: readonly string[] = ["--", "-"]) {
    this.command = command;
    this.args = args;
  }

  play(audio: TtsAudio, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      // Reference the child's own stdin: an intermediate PassThrough can drop
      // the final chunk or leave `close` waiting on an unflushed pipe.
      const child = spawn(this.command, this.args, { stdio: ["pipe", "ignore", "pipe"] });
      child.stdin.end(audio.bytes);

      const abort = (): void => {
        child.kill("SIGTERM");
        reject(signal.reason ?? new Error("aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", () => signal.removeEventListener("abort", abort));
      child.once("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) return;
        if (code === 0) resolve();
        else reject(new Error(`${this.command} exited with ${code ?? "signal"}`));
      });
    });
  }
}

/**
 * HTTP TTS adapter for providers that accept `{ text, voice, speed }` and
 * answer with audio bytes. Provider-specific auth stays in headers, never in
 * logs or URLs.
 */
export class HttpTtsProvider implements TtsProvider {
  readonly id: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly body: (request: TtsRequest) => unknown;

  constructor(options: {
    readonly id: string;
    readonly url: string;
    readonly headers?: Record<string, string>;
    readonly timeoutMs?: number;
    readonly body?: (request: TtsRequest) => unknown;
  }) {
    this.id = options.id;
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 6_000;
    this.body =
      options.body ??
      ((request) => ({
        text: request.text,
        voice_id: request.voice.voiceId,
        speed: request.voice.speed,
      }));
  }

  async synthesize(request: TtsRequest): Promise<TtsAudio> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(this.body(request)),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)]),
    });
    if (!response.ok) {
      throw new Error(`${this.id} returned HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error(`${this.id} returned empty audio`);
    return {
      bytes,
      firstByteAt: Date.now(),
      mediaType: response.headers.get("content-type") ?? "audio/mpeg",
    };
  }
}

/** Deterministic provider used by tests and UI previews. */
export class SilentTtsProvider implements TtsProvider {
  readonly id: string;
  private readonly delayMs: number;

  constructor(id = "fake", delayMs = 0) {
    this.id = id;
    this.delayMs = delayMs;
  }

  async synthesize(request: TtsRequest): Promise<TtsAudio> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        request.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(request.signal.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      });
    }
    return { bytes: new Uint8Array(0), firstByteAt: Date.now(), mediaType: "audio/wav" };
  }
}

/**
 * Subtitle-only mode. It is not a failure: the utterance is delivered to the
 * console, and no audio device is touched.
 */
export class SubtitleOnlyProvider implements TtsProvider {
  readonly id = "subtitle-only";

  async synthesize(): Promise<TtsAudio> {
    return { bytes: new Uint8Array(0), firstByteAt: Date.now(), mediaType: "audio/none" };
  }
}

export class MemoryAudioSink implements AudioSink {
  readonly played: string[] = [];
  readonly delayMs: number;

  constructor(delayMs = 0) {
    this.delayMs = delayMs;
  }

  async play(_audio: TtsAudio, signal: AbortSignal): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      });
    }
    this.played.push("played");
  }
}

export class NoopAudioSink implements AudioSink {
  async play(_audio: TtsAudio, signal: AbortSignal, text = ""): Promise<void> {
    // No device is touched, but a zero-length "playback" would make every
    // subtitle flash by instantly. Approximate reading time so the operator
    // can see the speaking state and stop it.
    await new Promise<void>((resolve, reject) => {
      // Roughly a comfortable Chinese reading pace, bounded so a very long
      // subtitle does not hold the queue for too long.
      const duration = Math.min(6_000, Math.max(350, text.length * 180));
      const timer = setTimeout(resolve, duration);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
  }
}
