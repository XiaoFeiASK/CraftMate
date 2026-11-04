import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DouyinRuntimeConfig } from "@craftmate/contracts";

export interface IngressSupervisorHooks {
  readonly publishHealth: (health: {
    readonly state: "connecting" | "open" | "closed" | "error";
    readonly detail: string;
    readonly lastEventAt: number | null;
  }) => void;
  readonly onError?: (detail: string) => void;
}

export interface IngressSupervisor {
  configure(config: DouyinRuntimeConfig): Promise<void>;
  close(): Promise<void>;
}

type SpawnProcess = typeof spawn;

/**
 * Keeps the comment Ingress aligned with the operator's saved room settings.
 * The child never receives credentials on argv; the shared token and runtime
 * configuration remain available through the inherited process environment.
 */
export function createIngressSupervisor(
  options: IngressSupervisorHooks & {
    readonly entry?: string;
    readonly spawnProcess?: SpawnProcess;
  },
): IngressSupervisor {
  const entry =
    options.entry ??
    fileURLToPath(new URL("../../ingress/src/main.ts", import.meta.url));
  const spawnProcess = options.spawnProcess ?? spawn;
  let child: ChildProcess | null = null;
  let currentKey = "";
  let generation = 0;
  let changing: Promise<void> = Promise.resolve();

  const stopChild = async (): Promise<void> => {
    const running = child;
    child = null;
    currentKey = "";
    if (!running || running.exitCode !== null || running.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        running.kill("SIGKILL");
        resolve();
      }, 3_000);
      running.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      running.kill("SIGTERM");
    });
  };

  const apply = async (config: DouyinRuntimeConfig): Promise<void> => {
    const key =
      config.roomId.length > 0
        ? `${config.roomId}\u0000${config.dyhubUrl}`
        : "";
    if (key === currentKey) return;

    await stopChild();
    if (config.roomId.length === 0) {
      options.publishHealth({
        state: "closed",
        detail: "抖音房间未配置",
        lastEventAt: null,
      });
      return;
    }

    const runGeneration = ++generation;
    options.publishHealth({
      state: "connecting",
      detail: `正在启动 Ingress · 房间 ${config.roomId}`,
      lastEventAt: null,
    });
    const started = spawnProcess(process.execPath, ["--import", "tsx", entry], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: {
        ...process.env,
        DOUYIN_ROOM_ID: config.roomId,
        DYHUB_URL: config.dyhubUrl,
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child = started;
    currentKey = key;

    started.once("error", (error) => {
      if (generation === runGeneration && child === started) {
        child = null;
        currentKey = "";
        options.publishHealth({
          state: "error",
          detail: `Ingress 启动失败：${error.message}`,
          lastEventAt: null,
        });
        options.onError?.(error.message);
      }
    });
    started.once("exit", (code, signal) => {
      if (generation !== runGeneration || child !== started) return;
      child = null;
      currentKey = "";
      const detail =
        code === 0
          ? "Ingress 已停止"
          : `Ingress 异常退出：${signal ?? code ?? "unknown"}`;
      options.publishHealth({ state: code === 0 ? "closed" : "error", detail, lastEventAt: null });
      if (code !== 0) options.onError?.(detail);
    });
  };

  const configure = async (config: DouyinRuntimeConfig): Promise<void> => {
    const key =
      config.roomId.length > 0
        ? `${config.roomId}\u0000${config.dyhubUrl}`
        : "";
    if (key === currentKey) return;
    if (key.length > 0 && child?.connected && currentKey.length > 0) {
      currentKey = key;
      child.send?.({ type: "configure", config });
      options.publishHealth({
        state: "connecting",
        detail: `正在切换房间 ${config.roomId}`,
        lastEventAt: null,
      });
      return;
    }
    await apply(config);
  };

  return {
    configure: (config) => {
      changing = changing.then(() => configure(config)).catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error.message : String(error));
      });
      return changing;
    },
    close: async () => {
      await changing;
      await stopChild();
    },
  };
}
