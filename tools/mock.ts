import { runMockClient } from "../apps/orchestrator/src/simulation/mock-client.ts";

await runMockClient({
  url: process.argv[2] ?? "ws://127.0.0.1:4321/control",
  rounds: Number(process.argv[3] ?? 40),
  onDecision: (decision, nickname, text) => console.log(decision.padEnd(9), nickname, text),
});
