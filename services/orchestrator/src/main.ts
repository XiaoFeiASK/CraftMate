import { createControlServer } from "./transport/control-server.ts";
import { createPersistentShow } from "./persistence.ts";
import { createRetentionSweep } from "./retention.ts";
import { loadOrCreateToken } from "@craftmate/local-auth";
import { connectVoice } from "./transport/voice-link.ts";

const port = Number(process.env.CRAFTMATE_PORT ?? 4321);
// Loopback by default. Set CRAFTMATE_HOST=0.0.0.0 only when another device
// or a container needs to reach the socket.
const host = process.env.CRAFTMATE_HOST ?? "127.0.0.1";
const ingressToken = loadOrCreateToken();
const persistent = createPersistentShow();
const retention = createRetentionSweep({ expire: (now) => persistent.expireRawText(now) });
retention.start();
let voiceLink: ReturnType<typeof connectVoice> | null = null;
const server = createControlServer({
  show: persistent.show,
  settings: { saveSettings: (next) => persistent.saveSettings(next) },
  port,
  host,
  ingressToken,
  allowRemoteIngress: process.env.CRAFTMATE_ALLOW_REMOTE_INGRESS === "1",
  voice: {
    speak: (text) => voiceLink?.speak(text),
    stop: (reason) => voiceLink?.stop(reason),
  },
});

voiceLink = connectVoice({
  url: process.env.CRAFTMATE_VOICE ?? "ws://127.0.0.1:4323/voice",
  token: ingressToken,
  onStatus: (status) => server.publishVoiceStatus(status),
  onSubtitle: (subtitle) => server.publishSubtitle(subtitle),
  onError: (detail) => console.warn(`orchestrator: voice error — ${detail}`),
});

const shutdown = async (): Promise<void> => {
  retention.stop();
  voiceLink?.close();
  await server.close();
  persistent.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
