import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import { WebSocket } from "ws";
import type { BodySession } from "./coordinator.ts";
import { MemoryActionPort } from "./memory-action-port.ts";
import { SimBody } from "./sim-body.ts";
import { connectBridgeClient } from "./ws-client.ts";
import { attachBridgeUpgrade, createBridgeUpgrade, type BridgeUpgrade } from "./ws-server.ts";

const TOKEN = "ws-test-token-0123456789";

async function withBridge(
  run: (
    url: string,
    health: () => ReturnType<ReturnType<typeof createBridgeUpgrade>["health"]>,
    session: () => BodySession,
    bridge: BridgeUpgrade,
  ) => Promise<void>,
): Promise<void> {
  const http = createServer();
  const bridge = createBridgeUpgrade({
    token: TOKEN,
    sessionId: "ws-session",
    actions: new MemoryActionPort(),
  });
  attachBridgeUpgrade(http, bridge);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  try {
    await run(
      `ws://127.0.0.1:${address.port}/bridge`,
      () => bridge.health(),
      () => bridge.session,
      bridge,
    );
  } finally {
    await bridge.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}

describe("bridge WebSocket transport", () => {
  test("a valid client negotiates and completes a command over the wire", async () => {
    await withBridge(async (url) => {
      const client = connectBridgeClient({
        url,
        token: TOKEN,
        ticksPerCommand: 1,
      });
      await client.open;
      await delay(100);

      const command = {
        v: 1 as const,
        type: "cmd" as const,
        id: "wire-1",
        op: "mine_block" as const,
        args: { block: "minecraft:stone" },
        priority: "command" as const,
        idempotencyKey: "wire-key-1",
      };
      client.body.handle(command);
      await delay(150);
      await client.close();
    });
  });

  test("a forged token is closed and never accepted as a body", async () => {
    await withBridge(async (url) => {
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
      socket.send(
        JSON.stringify({
          v: 1,
          type: "hello",
          token: "forged",
          client: "intruder",
          capabilities: ["move"],
          skills: ["goto"],
        }),
      );
      assert.equal(await closed, 4401);
    });
  });

  test("a socket close releases the body's inputs locally", async () => {
    await withBridge(async (url) => {
      const client = connectBridgeClient({
        url,
        token: TOKEN,
        ticksPerCommand: 20,
      });
      await client.open;
      await delay(100);
      client.body.handle({
        v: 1,
        type: "cmd",
        id: "wire-held",
        op: "mine_block",
        args: {},
        priority: "command",
        idempotencyKey: "wire-held-key",
      });
      await delay(60);
      assert.ok(client.body.state().pressed.length > 0);
      await client.close();
      await delay(80);
      assert.deepEqual(client.body.state().pressed, []);
    });
  });

  test("the body stops itself within 500ms when the server goes silent", async () => {
    let now = 1_000;
    const body = new SimBody({
      token: TOKEN,
      clock: { now: () => now },
      ticksPerCommand: 20,
      autoComplete: false,
      send: () => {},
    });
    body.start();
    body.handle({
      v: 1,
      type: "welcome",
      sessionId: "local-watchdog",
      owner: "agent",
      generation: 1,
      capabilities: ["move", "mine"],
      skills: ["mine_block"],
      heartbeatMs: 250,
      watchdogMs: 500,
    });
    body.handle({
      v: 1,
      type: "cmd",
      id: "local-watchdog-cmd",
      op: "mine_block",
      args: {},
      priority: "command",
      idempotencyKey: "local-watchdog-key",
    });
    assert.ok(body.state().pressed.length > 0);

    now = 1_499;
    body.checkWatchdog();
    assert.ok(body.state().pressed.length > 0);

    now = 1_500;
    body.checkWatchdog();
    assert.deepEqual(body.state().pressed, []);
    assert.equal(body.state().owner, "none");
    assert.equal(body.state().task, null);
    body.onDisconnect();
  });

  test("a body can reconnect after a disconnect and own the bridge again", async () => {
    await withBridge(async (url, health, _session, bridge) => {
      const first = connectBridgeClient({ url, token: TOKEN, ticksPerCommand: 1 });
      await first.open;
      await delay(80);
      assert.equal(health().connected, true);
      await first.close();
      await delay(120);
      assert.equal(health().connected, false);

      const second = connectBridgeClient({ url, token: TOKEN, ticksPerCommand: 1 });
      await second.open;
      await delay(120);
      try {
        // Before the fix the coordinator reused a closed session, so a
        // reconnect was accepted by the socket but could never take control.
        assert.equal(health().connected, true);
        assert.equal(health().owner, "agent");
      } finally {
        await second.close();
      }
    });
  });

  test("takeover and emergency stop survive a socket reconnect", async () => {
    await withBridge(async (url, health, session) => {
      const first = connectBridgeClient({ url, token: TOKEN, ticksPerCommand: 20, autoComplete: false });
      await first.open;
      await delay(80);
      session().takeOver();
      assert.equal(health().owner, "operator");
      await first.close();
      await delay(120);

      const second = connectBridgeClient({ url, token: TOKEN, ticksPerCommand: 20, autoComplete: false });
      await second.open;
      await delay(120);
      try {
        assert.equal(health().connected, true);
        assert.equal(health().owner, "operator");
        assert.equal(health().permission, "operator");
        assert.throws(
          () => session().issue({
            v: 1,
            type: "cmd",
            id: "after-takeover",
            op: "mine_block",
            args: {},
            priority: "command",
            idempotencyKey: "after-takeover-key",
          }),
          /not permitted/,
        );
        session().emergencyStop();
        second.body.setOwnership("agent", "forged local self-grant");
        assert.equal(health().owner, "none");
        assert.equal(health().permission, "stopped");
      } finally {
        await second.close();
      }
    });
  });

  test("operator control waits for the next body while disconnected", async () => {
    await withBridge(async (url, health, _session, bridge) => {
      const first = connectBridgeClient({ url, token: TOKEN, ticksPerCommand: 1 });
      await first.open;
      await delay(80);
      await first.close();
      await delay(120);
      assert.equal(health().connected, false);

      bridge.takeOver("operator while disconnected");
      assert.equal(health().owner, "operator");
      assert.equal(health().permission, "operator");

      const second = connectBridgeClient({ url, token: TOKEN, ticksPerCommand: 1 });
      await second.open;
      await delay(120);
      try {
        assert.equal(health().connected, true);
        assert.equal(health().owner, "operator");
        assert.equal(health().permission, "operator");
      } finally {
        await second.close();
      }
    });
  });
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
