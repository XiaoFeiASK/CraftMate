#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { WebSocket } from "ws";

const endpoint = process.argv[2] ?? "ws://127.0.0.1:4321/bridge";
const tokenPath = process.env.CRAFTMATE_BRIDGE_TOKEN_FILE ?? join(homedir(), ".craftmate", "bridge.token");
const token = readFileSync(tokenPath, "utf8").trim();

const args = {
  block: process.env.CRAFTMATE_CHECK_BLOCK ?? "minecraft:stone",
  count: Number(process.env.CRAFTMATE_CHECK_COUNT ?? 1),
};
if (!/^[a-z0-9_.:-]+$/i.test(args.block) || !Number.isInteger(args.count) || args.count < 1 || args.count > 64) {
  fail("CRAFTMATE_CHECK_BLOCK / CRAFTMATE_CHECK_COUNT are outside the accepted contract range");
}

const socket = new WebSocket(endpoint);
const commandId = crypto.randomUUID();
const idempotencyKey = crypto.randomUUID();
let sawHello = false;

function fail(message) {
  console.error(`bridge live check failed: ${message}`);
  process.exitCode = 1;
  socket?.close();
}

socket.on("open", () => {
  socket.send(JSON.stringify({
    v: 1,
    type: "hello",
    token,
    client: "craftmate-live-check/0.1.0",
    capabilities: ["sensor", "move", "mine", "attack", "use", "build", "camera", "hud"],
    skills: ["goto", "look_at", "mine_block", "say", "wait", "attack", "equip", "eat", "use_block", "place_block"],
  }));
});

socket.on("message", (raw) => {
  let frame;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    return fail("body returned invalid JSON");
  }
  if (frame.type === "welcome") {
    sawHello = true;
    console.log(`accepted body capabilities: ${frame.capabilities.join(", ")}`);
    console.log(`accepted body skills: ${frame.skills.join(", ")}`);
    socket.send(JSON.stringify({
      v: 1,
      type: "cmd",
      id: commandId,
      op: "mine_block",
      args,
      priority: "command",
      idempotencyKey,
      deadlineTick: frame.heartbeatMs ? Math.floor(Date.now() / 50 + 20_000) : undefined,
    }));
    return;
  }
  if (frame.type === "ack" && frame.id === commandId) {
    if (!frame.accepted) return fail(`command rejected: ${frame.code} ${frame.detail ?? ""}`);
    console.log("command accepted by game body");
    return;
  }
  if (frame.type === "progress" && frame.taskId === commandId) {
    console.log(`progress: ${frame.phase} ${frame.done}/${frame.total ?? "?"}`);
    return;
  }
  if (frame.type === "result" && frame.taskId === commandId) {
    if (frame.status !== "completed") {
      return fail(`command ended as ${frame.status}: ${frame.code ?? ""} ${frame.detail ?? ""}`);
    }
    const evidence = frame.data;
    if (!Array.isArray(evidence?.mined) || evidence.mined.length !== Number(args.count)) {
      return fail(`completion lacked evidence for ${args.count} block(s)`);
    }
    for (const mined of evidence.mined) {
      if (mined.block !== args.block || !Number.isInteger(mined.position?.x) || !Number.isInteger(mined.position?.y) || !Number.isInteger(mined.position?.z)) {
        return fail("completion evidence does not identify the block and position");
      }
      console.log(`verified ${mined.block} at ${mined.position.x}, ${mined.position.y}, ${mined.position.z}`);
    }
    console.log("bridge live check passed");
    socket.close();
    return;
  }
  if (frame.type === "error") return fail(`bridge error: ${frame.code} ${frame.detail}`);
});

socket.on("error", (error) => fail(error.message));
socket.on("close", (code, reason) => {
  if (process.exitCode === 0) return;
  if (!sawHello) fail(`closed before welcome: ${code} ${reason.toString()}`);
});

await wait(60_000);
fail("timed out after 60 seconds");
