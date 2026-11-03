import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultTokenPath, loadOrCreateToken } from "@craftmate/local-auth";
import { SqliteCommitmentGate } from "@craftmate/storage";
import { dafeiyu } from "@craftmate/agent";
import { VoiceEngine } from "./engine.ts";
import { createVoiceServer } from "./server.ts";
import { CommandAudioSink, VolcengineRealtimeTtsProvider } from "./providers.ts";

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
const primaryKey = process.env.TTS_PRIMARY_KEY?.trim();
const primaryVoice = process.env.TTS_PRIMARY_VOICE_ID?.trim();
if (primaryProvider !== "volcengine-realtime" || !primaryKey || !primaryVoice) {
  console.error(
    "voice: TTS_PRIMARY_PROVIDER=volcengine-realtime, TTS_PRIMARY_KEY and TTS_PRIMARY_VOICE_ID are required",
  );
  process.exit(1);
}
const realtimeUrl = process.env.TTS_PRIMARY_URL?.trim() || undefined;
const instructions = process.env.TTS_PRIMARY_INSTRUCTIONS?.trim();
providers.push(
  new VolcengineRealtimeTtsProvider({
    apiKey: primaryKey,
    voice: primaryVoice,
    ...(realtimeUrl ? { url: realtimeUrl } : {}),
    ...(instructions ? { instructions } : {}),
  }),
);

// Fail closed: without a readable database a promised line cannot be proven,
// so nothing is played rather than trusting the caller.
const gate = new SqliteCommitmentGate(
  process.env.CRAFTMATE_DB ?? join(homedir(), ".craftmate", "craftmate.db"),
);

const engine = new VoiceEngine({
  providers,
  commitmentGate: gate,
  sink: new CommandAudioSink(process.env.AUDIO_PLAYER ?? "afplay"),
  synthesisTimeoutMs: Number(process.env.TTS_SYNTHESIS_TIMEOUT_MS ?? 300_000),
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
