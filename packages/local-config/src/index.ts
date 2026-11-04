import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  integrationSettingsUpdateSchema,
  integrationSettingsViewSchema,
  runtimeIntegrationConfigSchema,
  type IntegrationSettingsUpdate,
  type IntegrationSettingsView,
  type RuntimeIntegrationConfig,
} from "@craftmate/contracts";

export const DEFAULT_VOICE_INSTRUCTIONS =
  "你是软萌爱撒娇的蓝色鲸鱼娘「大肥鱼」。用清亮少女音、自然口语和一点嘴硬撒娇的语气，忠实朗读提供给你的台词，不添加、不改写台词。";

export interface RuntimeConfigStore {
  readonly path: string;
  read(): RuntimeIntegrationConfig;
  save(update: IntegrationSettingsUpdate): RuntimeIntegrationConfig;
}

export interface RuntimeConfigOptions {
  readonly path?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function defaultRuntimeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CRAFTMATE_INTEGRATIONS_FILE?.trim() || join(homedir(), ".craftmate", "integrations.json");
}

/**
 * Machine-local service credentials. The file is deliberately separate from
 * the evidence database and is written atomically with owner-only permissions.
 */
export function createRuntimeConfigStore(options: RuntimeConfigOptions = {}): RuntimeConfigStore {
  const env = options.env ?? process.env;
  const path =
    options.path ??
    (env === process.env
      ? defaultRuntimeConfigPath(env)
      : join("/nonexistent", "craftmate-test-integrations.json"));

  return {
    path,
    read: () => {
      if (!existsSync(path)) return envConfig(env);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      } catch (error) {
        throw new Error(
          `runtime config ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const validated = runtimeIntegrationConfigSchema.safeParse(parsed);
      if (!validated.success) {
        throw new Error(`runtime config ${path} is invalid: ${validated.error.message}`);
      }
      return validated.data;
    },
    save: (raw) => {
      const update = integrationSettingsUpdateSchema.parse(raw);
      const current = readCurrent(path, env);
      const next = runtimeIntegrationConfigSchema.parse({
        model: {
          provider: update.model.provider,
          baseUrl: update.model.baseUrl,
          model: update.model.model,
          apiKey:
            update.model.clearApiKey
              ? ""
              : update.model.apiKey?.trim() || current.model.apiKey,
          timeoutMs: update.model.timeoutMs,
        },
        voice: {
          provider: update.voice.provider,
          url: update.voice.url,
          apiKey:
            update.voice.clearApiKey
              ? ""
              : update.voice.apiKey?.trim() || current.voice.apiKey,
          voiceId: update.voice.voiceId,
          instructions: update.voice.instructions,
          timeoutMs: update.voice.timeoutMs,
        },
        douyin: update.douyin,
      });
      writePrivateJson(path, next);
      return next;
    },
  };
}

export function publicRuntimeConfig(config: RuntimeIntegrationConfig): IntegrationSettingsView {
  return integrationSettingsViewSchema.parse({
    model: {
      provider: config.model.provider,
      baseUrl: config.model.baseUrl,
      model: config.model.model,
      apiKeyConfigured: config.model.apiKey.length > 0,
      timeoutMs: config.model.timeoutMs,
    },
    voice: {
      provider: config.voice.provider,
      url: config.voice.url,
      voiceId: config.voice.voiceId,
      apiKeyConfigured: config.voice.apiKey.length > 0,
      instructions: config.voice.instructions,
      timeoutMs: config.voice.timeoutMs,
    },
    douyin: config.douyin,
  });
}

function readCurrent(path: string, env: NodeJS.ProcessEnv): RuntimeIntegrationConfig {
  if (!existsSync(path)) return envConfig(env);
  const parsed = runtimeIntegrationConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`runtime config ${path} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

function envConfig(env: NodeJS.ProcessEnv): RuntimeIntegrationConfig {
  return runtimeIntegrationConfigSchema.parse({
    model: {
      provider: env.CRAFTMATE_MODEL_PROVIDER?.trim() || "deepseek",
      baseUrl: env.CRAFTMATE_MODEL_URL?.trim() || "https://www.yyapi.cloud/v1",
      model: env.CRAFTMATE_MODEL?.trim() || "deepseek-v4.1-flash",
      apiKey: env.CRAFTMATE_MODEL_KEY?.trim() || "",
      timeoutMs: positiveInt(env.CRAFTMATE_MODEL_TIMEOUT_MS, 30_000),
    },
    voice: {
      provider: "volcengine-realtime",
      url:
        env.TTS_PRIMARY_URL?.trim() ||
        "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue",
      apiKey: env.TTS_PRIMARY_KEY?.trim() || "",
      voiceId: env.TTS_PRIMARY_VOICE_ID?.trim() || "zh_female_vv_uranus_bigtts",
      instructions: env.TTS_PRIMARY_INSTRUCTIONS?.trim() || DEFAULT_VOICE_INSTRUCTIONS,
      timeoutMs: positiveInt(env.TTS_SYNTHESIS_TIMEOUT_MS, 300_000),
    },
    douyin: {
      roomId: env.DOUYIN_ROOM_ID?.trim() || "",
      dyhubUrl: env.DYHUB_URL?.trim() || "ws://127.0.0.1:8757",
    },
  });
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
