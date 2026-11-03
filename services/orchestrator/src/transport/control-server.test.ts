import { test } from "node:test";
import assert from "node:assert/strict";
import { Show, dafeiyu } from "@craftmate/agent";
import { WebSocket } from "ws";
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

test("a settings frame updates the show and is broadcast", async () => {
  const show = new Show({ persona: dafeiyu });
  const server = createControlServer({ show, port: 0 });
  try {
    const port = await server.listening;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/control`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const messages: { type: string; payload?: { goal?: string } }[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    const next = { ...show.currentSettings(), goal: "去挖钻石" };
    socket.send(JSON.stringify({ type: "hello" }));
    socket.send(JSON.stringify({ type: "settings", payload: next }));

    await new Promise((resolve) => setTimeout(resolve, 150));
    socket.close();

    assert.equal(show.currentSettings().goal, "去挖钻石");
    const update = messages.find((message) => message.type === "settings");
    assert.equal(update?.payload?.goal, "去挖钻石");
  } finally {
    await server.close();
  }
});
