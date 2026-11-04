#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";

const endpoint = process.argv[2] ?? "ws://127.0.0.1:4321/control";
const dbPath = process.env.CRAFTMATE_DB ?? join(homedir(), ".craftmate", "craftmate.db");
const count = Number(process.env.CRAFTMATE_CHECK_COUNT ?? 1);
const skill = process.env.CRAFTMATE_CHECK_SKILL ?? "chop_tree";
const text =
  process.env.CRAFTMATE_CHECK_TEXT ??
  (skill === "chop_tree" ? `只砍 ${count} 根木头` : `挖 ${count} 块 minecraft:stone`);
const timeoutMs = Number(process.env.CRAFTMATE_CHECK_TIMEOUT_MS ?? 180_000);

if (!Number.isInteger(count) || count < 1 || count > 16) {
  fail("CRAFTMATE_CHECK_COUNT must be an integer from 1 to 16");
}
if (skill !== "chop_tree" && skill !== "mine_block") {
  fail("CRAFTMATE_CHECK_SKILL must be chop_tree or mine_block");
}

const socket = new WebSocket(endpoint);
const eventId = `live-check-${crypto.randomUUID()}`;
const userId = `live-check-${crypto.randomUUID()}`;
let decisionId = null;
let verifier = null;
let finished = false;
let timeoutTimer = null;

function fail(message) {
  if (finished) return;
  finished = true;
  if (timeoutTimer !== null) clearTimeout(timeoutTimer);
  console.error(`control live check failed: ${message}`);
  process.exitCode = 1;
  if (verifier !== null) clearInterval(verifier);
  socket.close();
}

function pass(message) {
  if (finished) return;
  finished = true;
  if (timeoutTimer !== null) clearTimeout(timeoutTimer);
  console.log(message);
  if (verifier !== null) clearInterval(verifier);
  socket.close();
}

function openDatabase() {
  return new DatabaseSync(dbPath, { readOnly: true });
}

function checkCompletedAction() {
  if (decisionId === null) return;
  let db;
  try {
    db = openDatabase();
  } catch (error) {
    fail(`cannot open ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    const action = db
      .prepare(
        `SELECT skill, status, error_code, result_json
         FROM action_attempt
         WHERE decision_id = ?
         ORDER BY created_at_ms DESC
         LIMIT 1`,
      )
      .get(decisionId);
    if (!action) return;
    if (action.status === "queued" || action.status === "running") {
      return;
    }
    if (action.status !== "completed") {
      fail(
        `action ${action.skill} ended as ${action.status} ${action.error_code ?? ""}`.trim(),
      );
      return;
    }
    if (action.skill !== skill) {
      fail(`planner issued ${action.skill}, expected ${skill}`);
      return;
    }
    let result;
    try {
      result = action.result_json === null ? null : JSON.parse(action.result_json);
    } catch {
      fail("action result is not valid JSON");
      return;
    }
    const mined = result?.mined;
    if (!Array.isArray(mined) || mined.length !== count) {
      fail(`action result lacks evidence for ${count} block(s)`);
      return;
    }
    for (const block of mined) {
      if (
        typeof block?.block !== "string" ||
        !Number.isInteger(block.position?.x) ||
        !Number.isInteger(block.position?.y) ||
        !Number.isInteger(block.position?.z)
      ) {
        fail("action result does not identify the block and position");
        return;
      }
      if (skill === "chop_tree" && !block.block.includes("_log")) {
        fail(`chop_tree evidence is not a log: ${block.block}`);
        return;
      }
      console.log(
        `verified ${block.block} at ${block.position.x}, ${block.position.y}, ${block.position.z}`,
      );
    }
    pass(`${skill} live check passed through control → planner → bridge → game body`);
  } finally {
    db.close();
  }
}

socket.on("open", () => {
  socket.send(JSON.stringify({ type: "hello" }));
});

socket.on("message", (raw) => {
  let frame;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    return fail("control server returned invalid JSON");
  }
  if (frame.type === "error") {
    return fail(`control error: ${frame.payload?.code} ${frame.payload?.detail ?? ""}`);
  }
  if (frame.type === "ready") {
    const bridge = frame.payload?.snapshot?.bridge;
    if (!bridge?.connected || bridge.world?.inWorld !== true) {
      return fail("real game body is not connected in a loaded world");
    }
    if (!bridge.skills?.includes(skill)) {
      return fail(`real game body does not advertise ${skill}`);
    }
    if (frame.payload?.snapshot?.model?.state === "disabled") {
      return fail("planner has no configured model");
    }
    console.log(`connected body: ${bridge.client}`);
    console.log(`advertised skills: ${bridge.skills.join(", ")}`);
    socket.send(
      JSON.stringify({
        type: "comment",
        payload: {
          id: eventId,
          source: "douyin",
          kind: "comment",
          userId,
          nickname: "本地验收",
          text,
          ts: Date.now(),
        },
      }),
    );
    verifier = setInterval(checkCompletedAction, 250);
    return;
  }
  if (frame.type !== "decision" || frame.payload?.eventId !== eventId) return;
  const planned = frame.payload.skill;
  const queuedForSkill = frame.payload.decision === "QUEUE" && planned !== null;
  if (frame.payload.decision !== "EXECUTE" && !queuedForSkill) {
    return fail(
      `arbiter chose ${frame.payload.decision}, so no skill can be issued: ${frame.payload.reason}`,
    );
  }
  decisionId = frame.payload.id;
  if (frame.payload.stage !== "planned") {
    return console.log(`decision ${decisionId}: waiting for planner`);
  }
  if (planned === null) {
    return fail(
      `planner returned no skill${frame.payload.trace?.detail ? `: ${frame.payload.trace.detail}` : ""}`,
    );
  }
  if (planned.name !== skill) {
    return fail(`planner chose ${planned.name}, expected ${skill}`);
  }
  console.log(`planner chose ${planned.name} with ${JSON.stringify(planned.args)}`);
  checkCompletedAction();
});

socket.on("error", (error) => fail(error.message));

timeoutTimer = setTimeout(() => fail(`timed out after ${timeoutMs}ms`), timeoutMs);
timeoutTimer.unref();
