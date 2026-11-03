import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import type { AudioSink, TtsAudio, TtsProvider, TtsRequest } from "./provider.ts";

export const DAFEIYU_REALTIME_INSTRUCTIONS =
  "你是软萌爱撒娇的蓝色鲸鱼娘「大肥鱼」。用清亮少女音、自然口语和一点嘴硬撒娇的语气，忠实朗读提供给你的台词，不添加、不改写台词。";

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

interface RealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number, reason: unknown) => void): this;
  once(event: "open", listener: () => void): this;
  once(event: "message", listener: (data: unknown) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number, reason: unknown) => void): this;
}

type RealtimeSocketFactory = (url: string, headers: Record<string, string>) => RealtimeSocket;

/**
 * Doubao Seeduplex real-time speech adapter. It creates a socket per spoken
 * segment, commits the already-decided line, and collects the streamed PCM.
 * The model never owns conversation or tool decisions here; it only voices the
 * text selected by CraftMate.
 */
export class VolcengineRealtimeTtsProvider implements TtsProvider {
  readonly id = "volcengine-realtime";
  private readonly apiKey: string;
  private readonly url: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly instructions: string;
  private readonly sampleRate: number;
  private readonly timeoutMs: number;
  private readonly socketFactory: RealtimeSocketFactory;

  constructor(options: {
    readonly apiKey: string;
    readonly url?: string;
    readonly model?: string;
    readonly voice?: string;
    readonly instructions?: string;
    readonly sampleRate?: number;
    readonly timeoutMs?: number;
    readonly socketFactory?: RealtimeSocketFactory;
  }) {
    this.apiKey = options.apiKey;
    this.url = options.url ?? "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue";
    this.model = options.model ?? "1.2.6.1";
    this.voice = options.voice ?? "zh_female_vv_uranus_bigtts";
    this.instructions = options.instructions ?? DAFEIYU_REALTIME_INSTRUCTIONS;
    this.sampleRate = options.sampleRate ?? 24_000;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.socketFactory =
      options.socketFactory ??
      ((url, headers) => new WebSocket(url, { headers }) as unknown as RealtimeSocket);
  }

  async synthesize(request: TtsRequest): Promise<TtsAudio> {
    const socket = this.socketFactory(this.url, { "X-Api-Key": this.apiKey });
    const chunks: Buffer[] = [];
    let firstByteAt: number | null = null;
    let settled = false;

    return await new Promise<TtsAudio>((resolve, reject) => {
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        socket.close();
        if (error) {
          reject(error);
          return;
        }
        const pcm = Buffer.concat(chunks);
        if (pcm.byteLength === 0) {
          reject(new Error(`${this.id} returned no audio`));
          return;
        }
        resolve({
          bytes: new Uint8Array(toWave(pcm, this.sampleRate)),
          firstByteAt: firstByteAt ?? Date.now(),
          mediaType: "audio/wav",
        });
      };
      const abort = (): void => finish(request.signal.reason instanceof Error ? request.signal.reason : new Error("aborted"));
      const timer = setTimeout(() => finish(new Error(`${this.id} timed out`)), this.timeoutMs);
      request.signal.addEventListener("abort", abort, { once: true });
      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            event_id: `session_${crypto.randomUUID()}`,
            type: "session.create",
            session: {
              model: this.model,
              instructions: this.instructions,
              audio: {
                input: { format: { type: "pcm", rate: 16_000 } },
                output: {
                  format: { type: "pcm", rate: this.sampleRate },
                  speed: Math.round((request.voice.speed - 1) * 100),
                  loudness: 0,
                  voice: this.voice,
                },
              },
              tools: [],
            },
            extension: { asr: {}, tts: {}, dialog: {} },
          }),
        );
      });
      socket.on("message", (raw) => {
        let payload: unknown;
        try {
          payload = JSON.parse(String(raw));
        } catch {
          finish(new Error(`${this.id} returned invalid JSON`));
          return;
        }
        if (typeof payload !== "object" || payload === null) {
          finish(new Error(`${this.id} returned an invalid event`));
          return;
        }
        const event = payload as { type?: unknown; delta?: unknown; error?: unknown };
        if (event.type === "session.created") {
          socket.send(
            JSON.stringify({
              event_id: `speech_${crypto.randomUUID()}`,
              type: "speech_text_buffer.commit",
              text: request.text,
            }),
          );
          return;
        }
        if (event.type === "response.output_audio.delta" && typeof event.delta === "string") {
          const chunk = Buffer.from(event.delta, "base64");
          if (chunk.byteLength > 0) {
            firstByteAt ??= Date.now();
            chunks.push(chunk);
          }
          return;
        }
        if (event.type === "response.output_audio.done") {
          finish();
          return;
        }
        if (event.type === "error") {
          const error = event.error as { code?: unknown; message?: unknown } | undefined;
          finish(new Error(`${this.id} failed (${String(error?.code ?? "unknown")}): ${String(error?.message ?? "")}`));
        }
      });
      socket.once("error", (error) => finish(error));
      socket.once("close", (code) => {
        if (!settled) finish(new Error(`${this.id} closed before audio completed (${code})`));
      });
    });
  }
}

function toWave(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
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
