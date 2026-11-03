import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultTokenPath, loadOrCreateToken } from "@craftmate/local-auth";
import { SqliteCommitmentGate } from "@craftmate/storage";
import { dafeiyu } from "@craftmate/agent";
import { VoiceEngine } from "./engine.ts";
import { createVoiceServer } from "./server.ts";
import {
  CommandAudioSink,
  HttpTtsProvider,
  NoopAudioSink,
  SubtitleOnlyProvider,
  VolcengineTtsProvider,
} from "./providers.ts";

const port = Number(process.env.VOICE_PORT ?? 4323);
const host = process.env.VOICE_HOST ?? "127.0.0.1";
if (!process.env.CRAFTMATE_TOKEN?.trim() && !existsSync(defaultTokenPath())) {
  console.error("voice: no shared token found; start the orchestrator first or set CRAFTMATE_TOKEN");
  process.exit(1);
}
const token = loadOrCreateToken();
const voice = {
  ...dafeiyu.voice,
  ...(process.env.TTS_PRIMARY_PROVIDER?.trim()
    ? { provider: process.env.TTS_PRIMARY_PROVIDER.trim() }
    : {}),
  ...(process.env.TTS_PRIMARY_VOICE_ID?.trim()
    ? { voiceId: process.env.TTS_PRIMARY_VOICE_ID.trim() }
    : {}),
};

const providers = [];
const primaryProvider = process.env.TTS_PRIMARY_PROVIDER?.trim().toLowerCase();
const primaryUrl = process.env.TTS_PRIMARY_URL;
if (primaryProvider === "volcengine" && process.env.TTS_PRIMARY_KEY?.trim() && process.env.TTS_PRIMARY_VOICE_ID?.trim()) {
  providers.push(
    new VolcengineTtsProvider({
      apiKey: process.env.TTS_PRIMARY_KEY.trim(),
      resourceId: process.env.TTS_PRIMARY_RESOURCE_ID?.trim() || "seed-tts-2.0",
      speaker: process.env.TTS_PRIMARY_VOICE_ID.trim(),
    }),
  );
} else if (primaryUrl) {
  providers.push(
    new HttpTtsProvider({
      id: process.env.TTS_PRIMARY_ID ?? "primary",
      url: primaryUrl,
      ...(process.env.TTS_PRIMARY_KEY ? { headers: { authorization: `Bearer ${process.env.TTS_PRIMARY_KEY}` } } : {}),
      ...(process.env.TTS_PRIMARY_VOICE_ID?.trim()
        ? {
            body: (request) => ({
              text: request.text,
              voice_id: process.env.TTS_PRIMARY_VOICE_ID?.trim(),
              speed: request.voice.speed,
            }),
          }
        : {}),
    }),
  );
}
const backupUrl = process.env.TTS_BACKUP_URL;
if (backupUrl) {
  providers.push(
    new HttpTtsProvider({
      id: process.env.TTS_BACKUP_ID ?? "backup",
      url: backupUrl,
      ...(process.env.TTS_BACKUP_KEY ? { headers: { authorization: `Bearer ${process.env.TTS_BACKUP_KEY}` } } : {}),
    }),
  );
}
const subtitleOnly = providers.length === 0;
if (subtitleOnly) {
  console.warn("voice: no TTS_PRIMARY_URL/TTS_BACKUP_URL configured; running subtitle-only");
  providers.push(new SubtitleOnlyProvider());
}

// Fail closed: without a readable database a promised line cannot be proven,
// so nothing is played rather than trusting the caller.
const gate = new SqliteCommitmentGate(
  process.env.CRAFTMATE_DB ?? join(homedir(), ".craftmate", "craftmate.db"),
);

const engine = new VoiceEngine({
  providers,
  subtitleOnly,
  commitmentGate: gate,
  sink: subtitleOnly ? new NoopAudioSink() : new CommandAudioSink(process.env.AUDIO_PLAYER ?? "afplay"),
  onEvent: (event) => server.publish(event),
});

const server = createVoiceServer({
  engine,
  port,
  host,
  token,
  initialStatus: engine.status(),
  voice,
});

await server.listening;
console.log(`voice: ws://${host}:${port}/voice`);

const shutdown = async (): Promise<void> => {
  engine.stop("shutdown");
  gate.close();
  await server.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
