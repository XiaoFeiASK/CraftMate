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
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    readonly id: string;
    readonly url: string;
    readonly headers?: Record<string, string>;
    readonly timeoutMs?: number;
    readonly body?: (request: TtsRequest) => unknown;
    readonly fetchImpl?: typeof fetch;
  }) {
    this.id = options.id;
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 6_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.body =
      options.body ??
      ((request) => ({
        text: request.text,
        voice_id: request.voice.voiceId,
        speed: request.voice.speed,
      }));
  }

  async synthesize(request: TtsRequest): Promise<TtsAudio> {
    const response = await this.fetchImpl(this.url, {
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

/**
 * Doubao/Volcengine V3 HTTP SSE adapter. The API key and resource selection
 * travel in headers; the response is a sequence of JSON events whose audio
 * chunks are base64 encoded.
 */
export class VolcengineTtsProvider implements TtsProvider {
  readonly id = "volcengine";
  private readonly apiKey: string;
  private readonly resourceId: string;
  private readonly defaultSpeaker: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    readonly apiKey: string;
    readonly resourceId?: string;
    readonly speaker: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof fetch;
  }) {
    this.apiKey = options.apiKey;
    this.resourceId = options.resourceId ?? "seed-tts-2.0";
    this.defaultSpeaker = options.speaker;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(request: TtsRequest): Promise<TtsAudio> {
    const response = await this.fetchImpl("https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "X-Api-Key": this.apiKey,
        "X-Api-Resource-Id": this.resourceId,
        "X-Api-Request-Id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        user: { uid: "craftmate" },
        req_params: {
          text: request.text,
          speaker: request.voice.voiceId || this.defaultSpeaker,
          audio_params: {
            format: "mp3",
            sample_rate: 24_000,
            speech_rate: Math.round((request.voice.speed - 1) * 100),
          },
        },
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)]),
    });
    if (!response.ok) throw new Error(`volcengine returned HTTP ${response.status}`);

    const body = await response.text();
    const chunks: Uint8Array[] = [];
    let firstByteAt: number | null = null;
    for (const block of body.split(/\r?\n\r?\n/)) {
      if (!block.trim()) continue;
      const event = block.match(/^event:\s*(\d+)/m)?.[1];
      const data = block.match(/^data:\s*(.+)$/m)?.[1];
      if (!data) continue;

      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new Error("volcengine returned an invalid SSE event");
      }
      if (typeof payload !== "object" || payload === null) {
        throw new Error("volcengine returned an invalid SSE payload");
      }
      const record = payload as { code?: unknown; message?: unknown; data?: unknown };
      if (event === "153" || (typeof record.code === "number" && record.code !== 0 && record.code !== 20000000)) {
        throw new Error(`volcengine TTS failed (${String(record.code ?? event)}): ${String(record.message ?? "")}`);
      }
      if (event === "352" && typeof record.data === "string" && record.data.length > 0) {
        const audio = Buffer.from(record.data, "base64");
        if (audio.byteLength > 0) {
          firstByteAt ??= Date.now();
          chunks.push(audio);
        }
      }
    }

    const bytes = Buffer.concat(chunks);
    if (bytes.byteLength === 0) throw new Error("volcengine returned no audio");
    return {
      bytes: new Uint8Array(bytes),
      firstByteAt: firstByteAt ?? Date.now(),
      mediaType: "audio/mpeg",
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
