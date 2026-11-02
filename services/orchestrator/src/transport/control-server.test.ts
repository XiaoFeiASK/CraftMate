import { test } from "node:test";
import assert from "node:assert/strict";
import { Show, dafeiyu } from "@craftmate/agent";
import { createControlServer } from "./control-server.ts";

async function withServer(
  host: string | undefined,
  run: (port: number) => Promise<void>,
): Promise<void> {
  // Port 0 asks the OS for a free port, so tests never collide with a running dev server.
  const server = createControlServer({
    show: new Show({ persona: dafeiyu }),
    port: 0,
    ...(host === undefined ? {} : { host }),
  });

  try {
    await run(await server.listening);
  } finally {
    await server.close();
  }
}

test("health endpoint answers on the configured host", async () => {
  await withServer(undefined, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });
});

test("a wildcard host accepts connections addressed to loopback", async () => {
  await withServer("0.0.0.0", async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
  });
});
