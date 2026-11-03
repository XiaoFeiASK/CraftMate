import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Show, dafeiyu } from "@craftmate/agent";
import { WebSocket } from "ws";
import { createControlServer } from "./control-server.ts";

const TEST_TOKEN = "test-token-0123456789abcdef";

async function withServer(
  host: string | undefined,
  run: (port: number) => Promise<void>,
): Promise<void> {
  // Port 0 asks the OS for a free port, so tests never collide with a running dev server.
  const server = createControlServer({
    show: new Show({ persona: dafeiyu }),
    port: 0,
    ingressToken: TEST_TOKEN,
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
  const server = createControlServer({ show, port: 0, ingressToken: TEST_TOKEN });
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

function openIngress(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ingress`);
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextFrame(socket: WebSocket): Promise<{ type: string; payload?: { code?: string; detail?: string } }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), 1_000);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as { type: string; payload?: { code?: string; detail?: string } });
    });
  });
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for close")), 1_000);
    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("ingress authentication", () => {
  test("a valid hello is acknowledged", async () => {
    const server = createControlServer({
      show: new Show({ persona: dafeiyu }),
      port: 0,
      ingressToken: TEST_TOKEN,
    });
    try {
      const socket = await openIngress(await server.listening);
      socket.send(JSON.stringify({ type: "hello", role: "ingress", token: TEST_TOKEN }));
      const frame = await nextFrame(socket);
      socket.close();

      assert.equal(frame.type, "ready");
      assert.equal(typeof (frame.payload as { sessionId?: string }).sessionId, "string");
    } finally {
      await server.close();
    }
  });

  test("a forged token is closed as unauthorized and ingests nothing", async () => {
    const show = new Show({ persona: dafeiyu });
    const server = createControlServer({ show, port: 0, ingressToken: TEST_TOKEN });
    try {
      const socket = await openIngress(await server.listening);
      const closed = closeCode(socket);
      socket.send(JSON.stringify({ type: "hello", role: "ingress", token: "forged" }));

      assert.equal(await closed, 4401);
      socket.send(JSON.stringify({ type: "event", payload: commentEvent("c1") }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(show.snapshot().stats.received, 0);
    } finally {
      await server.close();
    }
  });

  test("an event before hello is rejected", async () => {
    const show = new Show({ persona: dafeiyu });
    const server = createControlServer({ show, port: 0, ingressToken: TEST_TOKEN });
    try {
      const socket = await openIngress(await server.listening);
      const closed = closeCode(socket);
      socket.send(JSON.stringify({ type: "event", payload: commentEvent("c1") }));

      assert.equal(await closed, 4401);
      assert.equal(show.snapshot().stats.received, 0);
    } finally {
      await server.close();
    }
  });

  test("no token configured closes every ingress connection", async () => {
    const server = createControlServer({ show: new Show({ persona: dafeiyu }), port: 0 });
    try {
      const socket = await openIngress(await server.listening);
      const closed = closeCode(socket);
      assert.equal(await closed, 4401);
    } finally {
      await server.close();
    }
  });

  test("repeated forged handshakes throttle new ingress connections", async () => {
    const server = createControlServer({
      show: new Show({ persona: dafeiyu }),
      port: 0,
      ingressToken: TEST_TOKEN,
      ingressFailureLimit: 1,
    });
    try {
      const port = await server.listening;
      const first = await openIngress(port);
      const firstClosed = closeCode(first);
      first.send(JSON.stringify({ type: "hello", role: "ingress", token: "forged" }));
      assert.equal(await firstClosed, 4401);

      const second = await openIngress(port);
      const secondClosed = closeCode(second);
      assert.equal(await secondClosed, 4401);
    } finally {
      await server.close();
    }
  });

  test("a valid event produces a decision and a bad payload does not crash", async () => {
    const show = new Show({ persona: dafeiyu });
    const server = createControlServer({ show, port: 0, ingressToken: TEST_TOKEN });
    try {
      const socket = await openIngress(await server.listening);
      socket.send(JSON.stringify({ type: "hello", role: "ingress", token: TEST_TOKEN }));
      await nextFrame(socket);

      socket.send(JSON.stringify({ type: "event", payload: { nonsense: true } }));
      const error = await nextFrame(socket);
      assert.equal(error.type, "error");
      assert.equal(error.payload?.code, "E_SCHEMA");

      socket.send(JSON.stringify({ type: "event", payload: commentEvent("c2") }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      socket.close();

      assert.equal(show.snapshot().stats.received, 1);
      assert.equal(show.snapshot().decisions.length, 1);
    } finally {
      await server.close();
    }
  });
});

describe("voice bridge", () => {
  test("publishes voice status and subtitles to the console", async () => {
    const server = createControlServer({
      show: new Show({ persona: dafeiyu }),
      port: 0,
      ingressToken: TEST_TOKEN,
    });
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${await server.listening}/control`);
      const frames: { type: string; payload?: unknown }[] = [];
      socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      socket.send(JSON.stringify({ type: "hello" }));

      server.publishVoiceStatus({
        state: "idle",
        detail: "待命",
        queued: 0,
        spoken: 1,
        failed: 0,
        cancelled: 0,
        dropped: 0,
        providers: [],
        lastSpokenAt: null,
      });
      server.publishSubtitle({
        id: "u1",
        text: "你好",
        state: "speaking",
        decisionId: null,
        at: 1_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      socket.close();

      assert.equal(frames.find((frame) => frame.type === "voice")?.payload !== undefined, true);
      assert.equal(frames.find((frame) => frame.type === "subtitle")?.payload !== undefined, true);
    } finally {
      await server.close();
    }
  });
});

describe("console independence", () => {
  test("ingress decisions continue after the console disconnects", async () => {
    const show = new Show({ persona: dafeiyu });
    const server = createControlServer({ show, port: 0, ingressToken: TEST_TOKEN });
    try {
      const port = await server.listening;
      const consoleSocket = new WebSocket(`ws://127.0.0.1:${port}/control`);
      await new Promise<void>((resolve, reject) => {
        consoleSocket.once("open", () => resolve());
        consoleSocket.once("error", reject);
      });
      consoleSocket.send(JSON.stringify({ type: "hello" }));
      consoleSocket.close();
      await new Promise((resolve) => consoleSocket.once("close", resolve));

      const ingressSocket = await openIngress(port);
      ingressSocket.send(JSON.stringify({ type: "hello", role: "ingress", token: TEST_TOKEN }));
      await nextFrame(ingressSocket);
      ingressSocket.send(JSON.stringify({ type: "event", payload: commentEvent("after-close") }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      ingressSocket.close();

      assert.equal(show.snapshot().stats.received, 1);
      assert.equal(show.snapshot().decisions.length, 1);
    } finally {
      await server.close();
    }
  });
});

function commentEvent(id: string): unknown {
  return {
    id,
    source: "douyin",
    kind: "comment",
    userId: "viewer-1",
    nickname: "小鲸鱼",
    text: "去挖矿",
    ts: 1_000,
  };
}
