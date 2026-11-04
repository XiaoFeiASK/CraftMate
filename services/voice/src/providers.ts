import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { access, chmod, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import type {
  AudioSink,
  TtsAudio,
  TtsProvider,
  TtsRequest,
  TtsStream,
} from "./provider.ts";

export const DAFEIYU_REALTIME_INSTRUCTIONS =
  "你是软萌爱撒娇的蓝色鲸鱼娘「大肥鱼」。用清亮少女音、自然口语和一点嘴硬撒娇的语气，忠实朗读提供给你的台词，不添加、不改写台词。";

const PCM_STREAM_PLAYER = fileURLToPath(
  new URL("./native/pcm-stream-player.swift", import.meta.url),
);
let compiledPcmPlayer: Promise<string> | null = null;

/**
 * `swift <script>` invokes the full JIT frontend for every utterance. Compile
 * the unchanged player once instead; this avoids both repeated compiler
 * latency and SwiftJIT crashes while PCM is arriving.
 */
async function pcmStreamPlayer(): Promise<string> {
  if (compiledPcmPlayer) return compiledPcmPlayer;
  compiledPcmPlayer = (async () => {
    const source = await readFile(PCM_STREAM_PLAYER);
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const binary = join(tmpdir(), `craftmate-pcm-player-${hash}`);
    try {
      await access(binary);
      return binary;
    } catch {
      // Build below.
    }

    await new Promise<void>((resolve, reject) => {
      const compiler = spawn(
        "swiftc",
        ["-O", PCM_STREAM_PLAYER, "-framework", "AVFoundation", "-o", binary],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      compiler.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
      });
      compiler.once("error", reject);
      compiler.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Swift audio player build failed (${code}): ${stderr.trim()}`));
      });
    });
    await chmod(binary, 0o700);
    return binary;
  })().catch((error) => {
    compiledPcmPlayer = null;
    throw error;
  });
  return compiledPcmPlayer;
}

/** macOS playback through a private file or an incremental PCM player. */
export class CommandAudioSink implements AudioSink {
  private readonly command: string;
  private readonly args: readonly string[];

  constructor(command = "afplay", args: readonly string[] = []) {
    this.command = command;
    this.args = args;
  }

  async play(audio: TtsAudio, signal: AbortSignal): Promise<void> {
    const path = join(tmpdir(), `craftmate-voice-${crypto.randomUUID()}.wav`);
    try {
      await writeFile(path, audio.bytes, { mode: 0o600 });
      await this.playFile(path, signal);
    } finally {
      await unlink(path).catch(() => undefined);
    }
  }

  async playStream(audio: TtsStream, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    const player = await pcmStreamPlayer();
    const child = spawn(
      player,
      [String(audio.format.sampleRate)],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
    });
    // A closed audio device makes stdin emit EPIPE asynchronously. The child
    // exit handler reports the actual diagnostic; this listener prevents the
    // process-level unhandled error from masking it.
    child.stdin.on("error", (error: Error) => {
      stderr = `${stderr}${error.message}`.slice(-2_000);
    });

    const exited = new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        child.kill("SIGTERM");
        reject(signal.reason ?? new Error("aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) return;
        if (code === 0) resolve();
        else {
          reject(
            new Error(
              `stream player exited with ${code ?? "signal"}${
                stderr.trim() ? `: ${stderr.trim()}` : ""
              }`,
            ),
          );
        }
      });
    });
    // PCM can fail first with EPIPE when AVFoundation aborts. Observe the
    // child promise immediately so its later rejection is reported through
    // the stream path instead of becoming an unhandled Node rejection.
    void exited.catch(() => undefined);

    try {
      for await (const chunk of audio.chunks) {
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        if (!child.stdin.write(chunk)) {
          await new Promise<void>((resolve, reject) => {
            const abort = (): void => {
              signal.removeEventListener("abort", abort);
              reject(signal.reason ?? new Error("aborted"));
            };
            child.stdin.once("drain", () => {
              signal.removeEventListener("abort", abort);
              resolve();
            });
            signal.addEventListener("abort", abort, { once: true });
          });
        }
      }
      child.stdin.end();
      await exited;
    } catch (error) {
      child.stdin.end();
      child.kill("SIGTERM");
      throw error;
    }
  }

  private playFile(path: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      const child = spawn(this.command, [...this.args, path], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";

      const abort = (): void => {
        child.kill("SIGTERM");
        reject(signal.reason ?? new Error("aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
      });
      child.once("error", (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) return;
        if (code === 0) resolve();
        else reject(new Error(
          `${this.command} exited with ${code ?? "signal"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        ));
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
    const stream = await this.stream(request);
    const chunks: Buffer[] = [];
    for await (const chunk of stream.chunks) chunks.push(Buffer.from(chunk));
    const pcm = Buffer.concat(chunks);
    return {
      bytes: new Uint8Array(toWave(pcm, this.sampleRate)),
      firstByteAt: await stream.firstByteAt,
      mediaType: "audio/wav",
    };
  }

  async stream(request: TtsRequest): Promise<TtsStream> {
    if (request.signal.aborted) {
      throw request.signal.reason ?? new Error("aborted");
    }
    const socket = this.socketFactory(this.url, { "X-Api-Key": this.apiKey });
    const chunks = new AsyncChunkQueue();
    let firstByteAt = 0;
    let resolveFirst!: (at: number) => void;
    let rejectFirst!: (error: unknown) => void;
    const first = new Promise<number>((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    });
    // The engine always consumes this promise; suppress a second rejection
    // when the provider fails before entering playback.
    void first.catch(() => undefined);
    let ready = false;
    let settled = false;
    let committed = false;

    return await new Promise<TtsStream>((resolve, reject) => {
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        socket.close();
        if (error) {
          if (!ready) reject(error);
          chunks.fail(error);
          rejectFirst(error);
          return;
        }
        if (firstByteAt === 0) {
          const empty = new Error(`${this.id} returned no audio`);
          if (!ready) reject(empty);
          chunks.fail(empty);
          rejectFirst(empty);
          return;
        }
        chunks.finish();
        if (!ready) {
          ready = true;
          resolve({
            format: {
              mediaType: "audio/pcm_s16le",
              sampleRate: this.sampleRate,
              channels: 1,
              bitsPerSample: 16,
            },
            chunks,
            firstByteAt: first,
          });
        }
      };
      const abort = (): void => {
        finish(
          request.signal.reason instanceof Error
            ? request.signal.reason
            : new Error("aborted"),
        );
      };
      const timer = setTimeout(
        () => finish(new Error(`${this.id} timed out`)),
        this.timeoutMs,
      );
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
                  // The API's bare `pcm` is 32-bit; request signed 16-bit PCM
                  // because the WAV wrapper and local playback path are s16le.
                  format: { type: "pcm_s16le", rate: this.sampleRate },
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
        const event = payload as {
          type?: unknown;
          delta?: unknown;
          error?: unknown;
        };
        if (event.type === "session.created") {
          if (committed) return;
          committed = true;
          socket.send(
            JSON.stringify({
              event_id: `speech_${crypto.randomUUID()}`,
              type: "speech_text_buffer.commit",
              text: request.text,
            }),
          );
          if (!ready) {
            ready = true;
            resolve({
              format: {
                mediaType: "audio/pcm_s16le",
                sampleRate: this.sampleRate,
                channels: 1,
                bitsPerSample: 16,
              },
              chunks,
              firstByteAt: first,
            });
          }
          return;
        }
        if (
          event.type === "response.output_audio.delta" &&
          typeof event.delta === "string"
        ) {
          const chunk = new Uint8Array(Buffer.from(event.delta, "base64"));
          if (chunk.byteLength === 0) return;
          if (firstByteAt === 0) {
            firstByteAt = Date.now();
            resolveFirst(firstByteAt);
          }
          chunks.push(chunk);
          return;
        }
        if (event.type === "response.output_audio.done") {
          finish();
          return;
        }
        if (event.type === "error") {
          const error = event.error as
            | { code?: unknown; message?: unknown }
            | undefined;
          finish(
            new Error(
              `${this.id} failed (${String(error?.code ?? "unknown")}): ${String(
                error?.message ?? "",
              )}`,
            ),
          );
        }
      });
      socket.once("error", (error) => finish(error));
      socket.once("close", (code) => {
        if (!settled) {
          finish(
            new Error(
              `${this.id} closed before audio completed (${code})`,
            ),
          );
        }
      });
    });
  }
}

class AsyncChunkQueue implements AsyncIterable<Uint8Array> {
  private readonly values: Uint8Array[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<Uint8Array>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private done = false;
  private error: unknown = null;

  push(value: Uint8Array): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.error = error;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.error) return Promise.reject(this.error);
        if (this.done) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
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
