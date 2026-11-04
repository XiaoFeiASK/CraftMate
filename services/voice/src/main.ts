import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultTokenPath, loadOrCreateToken } from "@craftmate/local-auth";
import { SqliteCommitmentGate } from "@craftmate/storage";
import { VoiceEngine } from "./engine.ts";
import { createVoiceServer } from "./server.ts";
import { CommandAudioSink, VolcengineRealtimeTtsProvider } from "./providers.ts";
import { createRuntimeConfigStore } from "@craftmate/local-config";
import { dafeiyu } from "@craftmate/agent";
import type { VoiceRuntimeConfig } from "@craftmate/contracts";

const port = Number(process.env.VOICE_PORT ?? 4323);
const host = process.env.VOICE_HOST ?? "127.0.0.1";
if (!process.env.CRAFTMATE_TOKEN?.trim() && !existsSync(defaultTokenPath())) {
  console.error("voice: no shared token found; start the orchestrator first or set CRAFTMATE_TOKEN");
  process.exit(1);
}
const token = loadOrCreateToken();
const runtimeConfig = createRuntimeConfigStore().read();
let voice: typeof dafeiyu.voice = {
  ...dafeiyu.voice,
  provider: runtimeConfig.voice.provider,
  voiceId: runtimeConfig.voice.voiceId,
};

const providerFor = (config: VoiceRuntimeConfig) =>
  config.apiKey
    ? [
        new VolcengineRealtimeTtsProvider({
          apiKey: config.apiKey,
          voice: config.voiceId,
          url: config.url,
          instructions: config.instructions,
          timeoutMs: config.timeoutMs,
        }),
      ]
    : [];
const providers = providerFor(runtimeConfig.voice);
const synthesisTimeoutMs = runtimeConfig.voice.timeoutMs;

// Fail closed: without a readable database a promised line cannot be proven,
// so nothing is played rather than trusting the caller.
const gate = new SqliteCommitmentGate(
  process.env.CRAFTMATE_DB ?? join(homedir(), ".craftmate", "craftmate.db"),
);

const engine = new VoiceEngine({
  providers,
  commitmentGate: gate,
  sink: new CommandAudioSink(process.env.AUDIO_PLAYER ?? "afplay"),
  synthesisTimeoutMs,
  onEvent: (event) => server.publish(event),
});

const server = createVoiceServer({
  engine,
  port,
  host,
  token,
  initialStatus: engine.status(),
  voice,
  onConfigure: (config) => {
    voice = { ...voice, provider: config.provider, voiceId: config.voiceId };
    engine.synthesisTimeoutMs = config.timeoutMs;
    engine.replaceProviders(providerFor(config));
  },
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
