import { spawn } from "node:child_process";

const run = (name, command, args) => {
  const child = spawn(command, args, { stdio: "inherit", shell: false });
  child.on("exit", (code) => {
    if (code !== null && code !== 0) console.error(`[${name}] exited with ${code}`);
  });
  return child;
};

const children = [
  run("orchestrator", "npm", ["run", "dev:orchestrator"]),
  run("console", "npm", ["run", "dev:console"]),
];

const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
