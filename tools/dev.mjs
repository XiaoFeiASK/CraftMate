import { spawn } from "node:child_process";

// Load the ignored, machine-local configuration before spawning any service.
// Values already supplied by the shell keep precedence over .env.
try {
  process.loadEnvFile(".env");
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
    throw error;
  }
}

const mode = process.argv[2] === "desktop" ? "desktop" : "web";
const detach = process.platform !== "win32";
// Windows 上没有无扩展名的 `npm` 可执行文件，直接 spawn 会 ENOENT。
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const run = (name, command, args) => {
  const child = spawn(command, args, {
    stdio: "inherit",
    // Windows 上 .cmd 需要经 shell 启动，否则新版 Node 会抛 EINVAL。
    shell: process.platform === "win32",
    detached: detach,
  });
  child.on("exit", (code) => {
    if (code !== null && code !== 0) console.error(`[${name}] exited with ${code}`);
  });
  return child;
};

const children =
  mode === "desktop"
    ? [
        run("orchestrator", npm, ["run", "dev:orchestrator"]),
        run("voice", npm, ["run", "dev:voice"]),
        run("desktop", npm, ["run", "dev:desktop"]),
      ]
    : [
        run("orchestrator", npm, ["run", "dev:orchestrator"]),
        run("voice", npm, ["run", "dev:voice"]),
        run("admin-console", npm, ["run", "dev:console"]),
      ];

const stop = () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      // Detached children lead their own process group, so signal the whole
      // tree. Tauri spawns Vite and must not outlive the launcher.
      process.kill(detach ? -child.pid : child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
