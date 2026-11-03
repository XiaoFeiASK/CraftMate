import { createServer } from "node:http";
import { MemoryActionPort } from "../../packages/bridge/src/memory-action-port.ts";
import { createBridgeUpgrade } from "../../packages/bridge/src/ws-server.ts";

const port = Number(process.env.BRIDGE_PORT ?? 4323);
const token = process.env.BRIDGE_TOKEN ?? "dev-bridge-token";
const http = createServer((request, response) => {
  if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, bridge: bridge.health() }));
      return;
  }
  response.writeHead(404).end();
});
const bridge = createBridgeUpgrade({
  token,
  sessionId: process.env.BRIDGE_SESSION ?? "dev-session",
  actions: new MemoryActionPort(),
});
http.on("upgrade", (request, socket, head) => bridge.handleUpgrade(request, socket, head));

http.listen(port, "127.0.0.1", () => {
  console.log(`bridge sim listening ws://127.0.0.1:${port}/bridge`);
  console.log(`health: http://127.0.0.1:${port}/health`);
});

const shutdown = async () => {
  await bridge.close();
  await new Promise((resolve) => http.close(() => resolve()));
};
process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
