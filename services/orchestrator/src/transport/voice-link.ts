import { WebSocket } from "ws";
import type { VoiceEvent, VoiceSubtitle } from "@craftmate/contracts";
import { voiceServerFrameSchema } from "@craftmate/contracts";

export interface VoiceLinkOptions {
  readonly url: string;
  readonly token: string;
  readonly onStatus: (status: unknown) => void;
  readonly onSubtitle: (subtitle: VoiceSubtitle) => void;
  readonly onError?: (detail: string) => void;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
}

export interface SpeakCommand {
  readonly text: string;
  readonly priority: import("@craftmate/contracts").Priority;
  readonly decisionId: string | null;
  readonly commitmentId: string | null;
}

export interface VoiceLink {
  speak(command: SpeakCommand): void;
  stop(reason?: string): void;
  close(): void;
}

/**
 * Reconnecting client for the independent Voice service. The orchestrator
 * only forwards utterances and projections; it never synthesizes audio.
 */
export function connectVoice(options: VoiceLinkOptions): VoiceLink {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Commands queued while the link is down. A stop invalidates everything
   * already waiting, so a reconnect cannot replay promises the operator
   * silenced while Voice was unreachable.
   */
  let pending: unknown[] = [];

  const send = (frame: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    else if (pending.length < 32) pending.push(frame);
  };

  const open = (): void => {
    if (disposed) return;
    const next = new WebSocket(options.url);
    socket = next;

    next.on("open", () => {
      attempt = 0;
      next.send(JSON.stringify({ type: "hello", token: options.token }));
      for (const frame of pending.splice(0)) next.send(JSON.stringify(frame));
    });
    next.on("message", (raw) => {
      const parsed = voiceServerFrameSchema.safeParse(parseJson(raw.toString()));
      if (!parsed.success) return;
      if (parsed.data.type === "ready") {
        options.onStatus(parsed.data.payload.status);
        return;
      }
      if (parsed.data.type === "error") {
        options.onError?.(parsed.data.payload.detail);
        return;
      }
      if (parsed.data.type !== "event") return;
      if (parsed.data.payload.type === "status") {
        options.onStatus(parsed.data.payload.status);
        return;
      }
      const subtitle = toSubtitle(parsed.data.payload);
      if (subtitle) options.onSubtitle(subtitle);
    });
    next.on("close", () => {
      if (socket === next) socket = null;
      if (disposed) return;
      const base = options.reconnectBaseMs ?? 1_000;
      const max = options.reconnectMaxMs ?? 30_000;
      const delay = Math.min(base * 2 ** attempt, max);
      attempt = Math.min(attempt + 1, 5);
      timer = setTimeout(open, delay);
    });
    next.on("error", () => {
      /* close handler drives reconnection */
    });
  };

  open();

  return {
    speak: (command) =>
      send({
        type: "command",
        payload: {
          type: "speak",
          text: command.text,
          priority: command.priority,
          decisionId: command.decisionId,
          commitmentId: command.commitmentId,
        },
      }),
    stop: (reason = "operator stop") => {
      // A stop is a control fact, not a queued line: drop anything the outage
      // buffered before it so reconnecting cannot replay stale promises.
      pending = [];
      send({ type: "command", payload: { type: "stop", reason } });
    },
    close: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
      socket = null;
    },
  };
}

function toSubtitle(event: VoiceEvent): VoiceSubtitle | null {
  switch (event.type) {
    case "speaking":
      return {
        id: event.utterance.id,
        text: event.utterance.text,
        state: "speaking",
        decisionId: event.utterance.decisionId,
        commitmentId: event.utterance.commitmentId,
        at: event.startedAt,
      };
    case "spoken":
      return {
        id: event.utterance.id,
        text: event.utterance.text,
        state: "spoken",
        decisionId: event.utterance.decisionId,
        commitmentId: event.utterance.commitmentId,
        at: event.finishedAt,
      };
    case "failed":
      return {
        id: event.utterance.id,
        text: event.utterance.text,
        state: "failed",
        decisionId: event.utterance.decisionId,
        commitmentId: event.utterance.commitmentId,
        at: event.utterance.at,
      };
    case "cancelled":
      return {
        id: event.utterance.id,
        text: event.utterance.text,
        state: "cancelled",
        decisionId: event.utterance.decisionId,
        commitmentId: event.utterance.commitmentId,
        at: event.utterance.at,
      };
    default:
      return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
