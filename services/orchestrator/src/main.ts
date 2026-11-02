import { Show, dafeiyu } from "@craftmate/agent";
import { createControlServer } from "./transport/control-server.ts";

const port = Number(process.env.CRAFTMATE_PORT ?? 4321);
const server = createControlServer({ show: new Show({ persona: dafeiyu }), port });

const shutdown = async (): Promise<void> => {
  await server.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
