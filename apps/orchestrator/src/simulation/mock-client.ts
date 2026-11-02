import { WebSocket } from "ws";
import type { ClientMessage } from "@craftmate/protocol";
import { SAMPLE_COMMENTS } from "./samples.ts";

export interface MockOptions {
  readonly url: string;
  readonly intervalMs?: number;
  readonly rounds?: number;
  readonly onDecision?: (decision: string, nickname: string, text: string) => void;
}

/** Sends scripted comments; a stand-in for a real CommentSource adapter. */
export async function runMockClient(options: MockOptions): Promise<void> {
  const { url, intervalMs = 1_500, rounds = 40 } = options;
  const socket = new WebSocket(url);
  await open(socket);

  const send = (message: ClientMessage): void => {
    socket.send(JSON.stringify(message));
  };

  send({ type: "hello" });
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as {
      type: string;
      payload?: { nickname?: string; text?: string; decision?: string };
    };
    if (message.type !== "decision" || !message.payload) return;
    options.onDecision?.(
      message.payload.decision ?? "?",
      message.payload.nickname ?? "",
      message.payload.text ?? "",
    );
  });

  for (let index = 0; index < rounds; index += 1) {
    const sample = SAMPLE_COMMENTS[index % SAMPLE_COMMENTS.length]!;
    send({
      type: "comment",
      payload: {
        id: `mock-${index}`,
        source: "douyin",
        kind: "comment",
        userId: `user-${sample.nickname}`,
        nickname: sample.nickname,
        text: sample.text,
        ts: Date.now(),
      },
    });
    await delay(intervalMs);
  }

  socket.close();
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function open(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}
