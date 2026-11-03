import { createControlServer } from "./transport/control-server.ts";
import { createPersistentShow } from "./persistence.ts";
import { createRetentionSweep } from "./retention.ts";

const port = Number(process.env.CRAFTMATE_PORT ?? 4321);
// Loopback by default. Set CRAFTMATE_HOST=0.0.0.0 only when another device
// or a container needs to reach the socket.
const host = process.env.CRAFTMATE_HOST ?? "127.0.0.1";
const persistent = createPersistentShow();
const retention = createRetentionSweep({ expire: (now) => persistent.expireRawText(now) });
retention.start();
const server = createControlServer({
  show: persistent.show,
  settings: { saveSettings: (next) => persistent.saveSettings(next) },
  port,
  host,
});

const shutdown = async (): Promise<void> => {
  retention.stop();
  await server.close();
  persistent.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
