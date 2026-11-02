import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = process.argv[2];
if (!script) {
  console.error("usage: node tools/run-workspace.mjs <root-script>");
  process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["run", script], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});

child.on("error", (error) => {
  console.error(`[workspace] failed to start ${script}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
