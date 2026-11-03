import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import type { AudienceEvent, SourceHealth } from "@craftmate/contracts";
import { DyhubSource } from "./dyhub-source.ts";
import { EventGate } from "./gate.ts";
import { normalize } from "./normalize.ts";

interface FakeDyhub {
  readonly url: string;
  readonly connections: Set<WebSocket>;
  readonly received: string[];
  readonly totalConnections: () => number;
  close(): Promise<void>;
}

/** Minimal dyhub stand-in: records subscriptions and lets a test push frames. */
async function fakeDyhub(): Promise<FakeDyhub> {
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  const connections = new Set<WebSocket>();
  const received: string[] = [];
  let total = 0;

  wss.on("connection", (socket) => {
    total += 1;
    connections.add(socket);
    socket.on("message", (raw) => received.push(raw.toString()));
    socket.on("close", () => connections.delete(socket));
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("no port");

  return {
    url: `ws://127.0.0.1:${address.port}`,
    connections,
    received,
    totalConnections: () => total,
    close: async () => {
      for (const socket of connections) socket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await wait(10);
  }
}

describe("dyhub source", () => {
  test("subscribes to the room and forwards normalized comments", async () => {
    const hub = await fakeDyhub();
    const events: AudienceEvent[] = [];
    const source = new DyhubSource({ url: hub.url, reconnectBaseMs: 10 });
    source.on((event) => events.push(event));
    try {
      await source.connect("12345");
      await eventually(() => hub.connections.size === 1);
      const [socket] = [...hub.connections];
      socket?.send(
        JSON.stringify({
          id: "m1",
          type: "chat",
          user: { id: "u1", nickname: "小鲸鱼" },
          data: { content: "去挖矿" },
          ts: 1_000,
        }),
      );
      await eventually(() => events.length === 1);

      assert.equal(events[0]?.text, "去挖矿");
      assert.equal(source.health().state, "open");
    } finally {
      await source.close();
      await hub.close();
    }
  });

  test("reconnects after the upstream closes and keeps forwarding", async () => {
    const hub = await fakeDyhub();
    const events: AudienceEvent[] = [];
    const source = new DyhubSource({ url: hub.url, reconnectBaseMs: 10 });
    source.on((event) => events.push(event));
    try {
      await source.connect("12345");
      await eventually(() => hub.connections.size === 1);
      for (const socket of [...hub.connections]) socket.terminate();

      await eventually(() => hub.totalConnections() === 2, 3_000);
      const socket = [...hub.connections][0];
      socket?.send(
        JSON.stringify({
          id: "m2",
          type: "chat",
          user: { id: "u1", nickname: "小鲸鱼" },
          data: { content: "还在吗" },
          ts: 1_100,
        }),
      );
      await eventually(() => events.length === 1, 3_000);
      assert.equal(events[0]?.text, "还在吗");
    } finally {
      await source.close();
      await hub.close();
    }
  });

  test("a closed room becomes health, never a phantom comment", async () => {
    const hub = await fakeDyhub();
    const events: AudienceEvent[] = [];
    const health: SourceHealth[] = [];
    const source = new DyhubSource({
      url: hub.url,
      reconnectBaseMs: 10,
      onHealth: (next) => health.push(next),
    });
    source.on((event) => events.push(event));
    try {
      await source.connect("12345");
      await eventually(() => hub.connections.size === 1);
      const [socket] = [...hub.connections];
      socket?.send(JSON.stringify({ id: "r1", type: "roomStatus", data: { status: "closed" } }));
      await eventually(() => source.health().state === "closed");

      assert.equal(events.length, 0);
      assert.ok(health.some((entry) => entry.detail === "直播间已关闭"));
    } finally {
      await source.close();
      await hub.close();
    }
  });

  test("malformed JSON and unsupported events are dropped without killing the link", async () => {
    const hub = await fakeDyhub();
    const events: AudienceEvent[] = [];
    const drops: string[] = [];
    const source = new DyhubSource({
      url: hub.url,
      reconnectBaseMs: 10,
      onDrop: (reason) => drops.push(reason),
    });
    source.on((event) => events.push(event));
    try {
      await source.connect("12345");
      await eventually(() => hub.connections.size === 1);
      const [socket] = [...hub.connections];
      socket?.send("{not json");
      socket?.send(JSON.stringify({ id: "m3", type: "follow", user: { id: "u1" } }));
      socket?.send(
        JSON.stringify({
          id: "m4",
          type: "chat",
          user: { id: "u1", nickname: "小鲸鱼" },
          data: { content: "正常评论" },
          ts: 1_200,
        }),
      );
      await eventually(() => events.length === 1);

      assert.equal(events[0]?.text, "正常评论");
      assert.ok(drops.includes("invalid json"));
      assert.ok(drops.some((reason) => reason.includes("follow")));
    } finally {
      await source.close();
      await hub.close();
    }
  });
});

describe("event gate under burst", () => {
  test("sheds beyond the rate limit and reports the reason", () => {
    const drops: string[] = [];
    const gate = new EventGate({ perSecond: 50, capacity: 32, onDrop: (_kind, reason) => drops.push(reason) });
    let accepted = 0;

    for (let index = 0; index < 200; index += 1) {
      const event: AudienceEvent = {
        id: `burst-${index}`,
        source: "douyin",
        kind: "comment",
        userId: `viewer-${index}`,
        nickname: "观众",
        text: "冲",
        ts: 1_000,
      };
      if (gate.admit(event, 1_000)) accepted += 1;
    }

    assert.ok(accepted <= 50);
    assert.equal(gate.drain().length, 32);
    assert.ok(gate.stats().dropped > 100);
    assert.ok(gate.dropCounts()["rate limited"] !== undefined || gate.dropCounts()["queue full"] !== undefined);
  });

  test("gifts survive a burst that sheds chat", () => {
    const gate = new EventGate({ perSecond: 1, capacity: 1 });
    const gift: AudienceEvent = {
      id: "gift-1",
      source: "douyin",
      kind: "gift",
      userId: "u1",
      nickname: "老板",
      gift: { name: "小心心", count: 1, value: 1 },
      ts: 1_000,
    };
    assert.equal(gate.admit(gift, 1_000), true);
    for (let index = 0; index < 10; index += 1) {
      gate.admit(
        {
          id: `chat-${index}`,
          source: "douyin",
          kind: "comment",
          userId: `u${index}`,
          nickname: "观众",
          text: "刷屏",
          ts: 1_000,
        },
        1_000,
      );
    }
    assert.equal(gate.drain().some((event) => event.kind === "gift"), true);
  });
});

describe("normalize gift counts", () => {
  test("uses repeatCount then groupCount and never fabricates a count", () => {
    const result = normalize({
      id: "g1",
      type: "gift",
      user: { id: "u1", nickname: "老板" },
      data: { giftName: "火箭", repeatCount: 3, groupCount: 9 },
    });
    assert.equal(result.kind, "event");
    assert.equal(result.kind === "event" ? result.event.gift?.count : null, 3);

    const fallback = normalize({
      id: "g2",
      type: "gift",
      user: { id: "u1", nickname: "老板" },
      data: { giftName: "火箭", groupCount: 9 },
    });
    assert.equal(fallback.kind === "event" ? fallback.event.gift?.count : null, 9);
  });
});
