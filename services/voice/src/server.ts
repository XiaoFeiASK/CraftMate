import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  voiceClientFrameSchema,
  VOICE_CLOSE_REMOTE,
  VOICE_CLOSE_UNAUTHORIZED,
  type VoiceEvent,
  type VoiceServerFrame,
  type VoiceStatus,
  type VoiceRuntimeConfig,
} from "@craftmate/contracts";
import { isLoopbackAddress, tokenMatches } from "@craftmate/local-auth";
import type { VoiceEngine } from "./engine.ts";

export interface VoiceServerOptions {
  readonly engine: VoiceEngine;
  readonly port: number;
  readonly token: string;
  readonly host?: string;
  readonly allowRemote?: boolean;
  readonly initialStatus: VoiceStatus;
  readonly voice: Parameters<VoiceEngine["speak"]>[0]["voice"];
  readonly onConfigure?: (config: VoiceRuntimeConfig) => void;
}

export interface VoiceServer {
  readonly listening: Promise<number>;
  publish(event: VoiceEvent): void;
  close(): Promise<void>;
}

/**
 * Thin transport around `VoiceEngine`. It knows nothing about decisions,
 * commitments, or personas beyond the voice profile it passes through.
 */
export function createVoiceServer({
  engine,
  port,
  token,
  host = "127.0.0.1",
  allowRemote = false,
  initialStatus,
  voice,
  onConfigure,
}: VoiceServerOptions): VoiceServer {
  const http = createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, status: engine.status() }));
  });

  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/voice") {
      socket.destroy();
      return;
    }
    if (!allowRemote && !isLoopbackAddress(request.socket.remoteAddress)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  const clients = new Set<WebSocket>();
  let currentStatus = initialStatus;
  let currentVoice = voice;

  const send = (socket: WebSocket, frame: VoiceServerFrame): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };

  wss.on("connection", (socket, request) => {
    let greeted = false;
    const remote = request.socket.remoteAddress ?? "unknown";
    if (!allowRemote && !isLoopbackAddress(remote)) {
      socket.close(VOICE_CLOSE_REMOTE, "remote voice connection is disabled");
      return;
    }

    socket.on("message", (raw) => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: "error", payload: { code: "E_SCHEMA", detail: "invalid json" } });
        return;
      }
      const parsed = voiceClientFrameSchema.safeParse(parsedJson);
      if (!parsed.success) {
        send(socket, { type: "error", payload: { code: "E_SCHEMA", detail: "invalid frame" } });
        return;
      }

      if (parsed.data.type === "hello") {
        if (!tokenMatches(token, parsed.data.token)) {
          socket.close(VOICE_CLOSE_UNAUTHORIZED, "invalid voice token");
          return;
        }
        greeted = true;
        clients.add(socket);
        send(socket, {
          type: "ready",
          payload: { status: currentStatus, heartbeatMs: 15_000 },
        });
        return;
      }
      if (!greeted) {
        socket.close(VOICE_CLOSE_UNAUTHORIZED, "hello required");
        return;
      }

      const command = parsed.data.payload;
      switch (command.type) {
        case "speak":
          engine.speak({ ...command, voice: currentVoice });
          break;
        case "stop":
          engine.stop(command.reason);
          break;
        case "limit":
          // Queue limits are process configuration, not a live operator knob.
          break;
        case "configure":
          currentVoice = {
            ...currentVoice,
            provider: command.config.provider,
            voiceId: command.config.voiceId,
          };
          onConfigure?.(command.config);
          break;
      }
    });

    socket.on("error", (error) => {
      clients.delete(socket);
      console.warn(
        `voice: socket error — ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    socket.on("close", () => clients.delete(socket));
  });

  const publish = (event: VoiceEvent): void => {
    if (event.type === "status") currentStatus = event.status;
    for (const client of clients) send(client, { type: "event", payload: event });
  };

  // The engine owns timing; the server owns fan-out. Wiring here keeps a
  // caller from forgetting to connect them and silently losing subtitles.
  engine.subscribe(publish);

  const listening = new Promise<number>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.off("error", reject);
      const address = http.address();
      if (address === null || typeof address === "string") {
        reject(new Error("voice server is not bound to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    listening,
    publish,
    close: async () => {
      for (const client of clients) client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
