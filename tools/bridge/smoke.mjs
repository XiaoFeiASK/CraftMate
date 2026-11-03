import { connectBridgeClient } from "../../packages/bridge/src/ws-client.ts";

const port = Number(process.env.BRIDGE_PORT ?? 4323);
const token = process.env.BRIDGE_TOKEN ?? "dev-bridge-token";
const url = `ws://127.0.0.1:${port}/bridge`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const serverProbe = (await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json()));
console.log("bridge health before smoke:", JSON.stringify(serverProbe));

const client = connectBridgeClient({ url, token, ticksPerCommand: 4 });
await client.open;
await delay(100);

client.body.issue({
  v: 1,
  type: "cmd",
  id: "smoke-1",
  op: "mine_block",
  args: { block: "minecraft:stone" },
  priority: "command",
  idempotencyKey: "smoke-key-1",
});
await delay(350);
console.log("sim state:", JSON.stringify(client.body.state()));

await client.close();
await delay(100);
