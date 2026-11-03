import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { VoiceStatus, VoiceSubtitle } from "@craftmate/contracts";
import { connectVoice } from "./voice-link.ts";

const STATUS: VoiceStatus = {
  state: "idle",
  detail: "待命",
  queued: 0,
  spoken: 0,
  failed: 0,
  cancelled: 0,
  dropped: 0,
  providers: [],
  lastSpokenAt: null,
};

async function fakeVoice(): Promise<{ url: string; tokens: string[]; close(): Promise<void> }> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const tokens: string[] = [];
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type: string; token?: string };
      if (frame.type === "hello") {
        tokens.push(frame.token ?? "");
        socket.send(JSON.stringify({ type: "ready", payload: { status: STATUS, heartbeatMs: 15_000 } }));
        return;
      }
      socket.send(
        JSON.stringify({
          type: "event",
          payload: {
            type: "status",
            status: { ...STATUS, state: "speaking", queued: 1 },
          },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "event",
          payload: {
            type: "speaking",
            utterance: {
              id: "u1",
              text: "你好",
              priority: "operator",
              decisionId: null,
              commitmentId: null,
              at: 1_000,
            },
            startedAt: 1_000,
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `ws://127.0.0.1:${address.port}/voice`,
    tokens,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

describe("voice link", () => {
  test("forwards the ready status and subtitles, and speaks", async () => {
    const hub = await fakeVoice();
    const statuses: VoiceStatus[] = [];
    const subtitles: VoiceSubtitle[] = [];
    const link = connectVoice({
      url: hub.url,
      token: "shared-token",
      onStatus: (status) => statuses.push(status as VoiceStatus),
      onSubtitle: (subtitle) => subtitles.push(subtitle),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      link.speak({ text: "你好呀", priority: "operator", decisionId: null, commitmentId: null });
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(hub.tokens[0], "shared-token");
      assert.equal(statuses[0]?.state, "idle");
      assert.equal(statuses[1]?.state, "speaking");
      assert.equal(subtitles[0]?.text, "你好");
      assert.equal(subtitles[0]?.state, "speaking");
    } finally {
      link.close();
      await hub.close();
    }
  });
});
