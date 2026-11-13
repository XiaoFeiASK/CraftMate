import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  BridgeClientFrame,
  BridgeServerFrame,
  SkillCommand,
} from "@craftmate/contracts";
import { BodySession, CLOSE_PROTOCOL, CLOSE_UNAUTHORIZED } from "./coordinator.ts";
import { ControlAuthority } from "./control.ts";
import { MemoryActionPort } from "./memory-action-port.ts";
import { CommandQueue } from "./queue.ts";
import { SimBody, createVirtualScheduler } from "./sim-body.ts";

const TOKEN = "bridge-token-0123456789";

interface Harness {
  readonly coordinator: BodySession;
  readonly body: SimBody;
  readonly actions: MemoryActionPort;
  readonly sent: BridgeServerFrame[];
  readonly received: BridgeClientFrame[];
  readonly closeCodes: number[];
  readonly welcome: () => Extract<BridgeServerFrame, { type: "welcome" }> | undefined;
  readonly frame: (command: Partial<SkillCommand> & { id: string }) => SkillCommand;
  readonly advance: (ms: number) => void;
}

function createHarness(mode: "auto" | "manual" = "auto"): Harness {
  let now = 1_000;
  const scheduler = createVirtualScheduler(() => now);
  const clock = { now: () => now };
  const sent: BridgeServerFrame[] = [];
  const received: BridgeClientFrame[] = [];
  const closeCodes: number[] = [];
  const actions = new MemoryActionPort();

  const body = new SimBody({
    token: TOKEN,
    clock,
    scheduler,
    ticksPerCommand: 2,
    autoComplete: mode === "auto",
    send: (frame) => {
      received.push(frame);
      coordinator.handle(frame);
    },
  });
  const coordinator = new BodySession({
    token: TOKEN,
    sessionId: "session-test",
    clock,
    scheduler,
    actions,
    watchdogMs: 2_000,
    heartbeatMs: 250,
    transport: {
      send: (frame) => {
        sent.push(frame);
        body.handle(frame);
      },
      close: (code) => {
        closeCodes.push(code);
      },
    },
  });

  return {
    coordinator,
    body,
    actions,
    sent,
    received,
    closeCodes,
    welcome: () =>
      sent.find(
        (frame): frame is Extract<BridgeServerFrame, { type: "welcome" }> =>
          frame.type === "welcome",
      ),
    frame: (command) => ({
      v: 1,
      type: "cmd",
      id: command.id,
      op: command.op ?? "mine_block",
      args: command.args ?? { block: "minecraft:iron_ore", count: 1 },
      priority: command.priority ?? "command",
      idempotencyKey: command.idempotencyKey ?? `key-${command.id}`,
      ...(command.deadlineTick === undefined ? {} : { deadlineTick: command.deadlineTick }),
    }),
    advance: (ms) => {
      now += ms;
      scheduler.advance(ms);
    },
  };
}

function connectHarness(harness: Harness): void {
  harness.body.start();
}

function commands(harness: Harness): Extract<BridgeServerFrame, { type: "cmd" }>[] {
  return harness.sent.filter(
    (frame): frame is Extract<BridgeServerFrame, { type: "cmd" }> => frame.type === "cmd",
  );
}

describe("bridge handshake and capability negotiation", () => {
  test("hello is answered with the negotiated body and a watchdog window", () => {
    const harness = createHarness();
    connectHarness(harness);
    const welcome = harness.welcome();

    assert.equal(welcome?.type, "welcome");
    assert.equal(harness.coordinator.currentOwnership.owner, "agent");
    assert.deepEqual(harness.coordinator.negotiated?.skills, ["goto", "look_at", "mine_block", "wait"]);
    if (welcome?.type === "welcome") {
      assert.equal(welcome.heartbeatMs, 250);
      assert.equal(welcome.watchdogMs, 2_000);
      assert.equal(welcome.sessionId, "session-test");
      assert.equal(welcome.owner, "agent");
      assert.equal(welcome.generation, 1);
    }
  });

  test("a forged token is rejected with E_PERMISSION and close 4401", () => {
    const harness = createHarness();
    harness.coordinator.handle({
      v: 1,
      type: "hello",
      token: "forged",
      client: "intruder",
      capabilities: ["move"],
      skills: ["goto"],
    });

    assert.equal(harness.coordinator.negotiated, null);
    assert.equal(harness.closeCodes[0], CLOSE_UNAUTHORIZED);
    assert.equal(harness.sent.at(-1)?.type, "error");
  });

  test("a command before hello is rejected", () => {
    const harness = createHarness();
    harness.coordinator.handle({
      v: 1,
      type: "heartbeat",
      tick: 1,
      owner: "agent",
    });

    assert.equal(harness.closeCodes[0], CLOSE_UNAUTHORIZED);
  });

  test("an invalid frame is closed as a protocol error", () => {
    const harness = createHarness();
    harness.coordinator.handle({ v: 1, type: "cmd", id: "" });

    assert.equal(harness.closeCodes[0], CLOSE_PROTOCOL);
    const error = harness.sent.find((frame) => frame.type === "error");
    assert.equal(error?.type === "error" ? error.code : null, "E_SCHEMA");
  });

  test("a skill the body did not advertise is refused locally", () => {
    const harness = createHarness();
    connectHarness(harness);

    assert.throws(
      () => harness.coordinator.issue(harness.frame({ id: "c-1", op: "follow" })),
      /did not advertise follow/,
    );
    assert.equal(commands(harness).length, 0);
  });

  test("a deadline already in the past is refused before reaching the body", () => {
    const harness = createHarness();
    connectHarness(harness);

    assert.throws(
      () => harness.coordinator.issue(harness.frame({ id: "c-1", deadlineTick: 0 })),
      /already passed/,
    );
    assert.equal(commands(harness).length, 0);
  });
});

describe("bridge command lifecycle", () => {
  test("success runs cmd → ack → progress → result exactly once", () => {
    const harness = createHarness();
    connectHarness(harness);
    harness.coordinator.issue(harness.frame({ id: "c-1" }));
    harness.advance(200);

    assert.equal(commands(harness).length, 1);
    assert.equal(harness.body.state().completed.length, 1);
    const settled = harness.actions.snapshot()[0];
    assert.equal(settled?.status, "completed");
    assert.equal(harness.body.state().task, null);
    assert.deepEqual(harness.body.state().pressed, []);
  });

  test("progress keeps the command's decision join key", () => {
    const progresses: {
      readonly taskId: string;
      readonly decisionId?: string;
      readonly phase: string;
      readonly done: number;
    }[] = [];
    let now = 1_000;
    const scheduler = createVirtualScheduler(() => now);
    const clock = { now: () => now };
    const body = new SimBody({
      token: TOKEN,
      clock,
      scheduler,
      ticksPerCommand: 20,
      autoComplete: false,
      send: (frame) => coordinator.handle(frame),
    });
    const coordinator = new BodySession({
      token: TOKEN,
      sessionId: "progress-join",
      clock,
      scheduler,
      actions: new MemoryActionPort(),
      onProgress: (progress) => progresses.push(progress),
      transport: {
        send: (frame) => body.handle(frame),
        close: () => {},
      },
    });
    body.start();
    coordinator.issue({
      v: 1,
      type: "cmd",
      id: "c-progress",
      op: "mine_block",
      args: {},
      priority: "command",
      idempotencyKey: "c-progress-key",
      decisionId: "decision-1",
    });
    now += 10;
    coordinator.handle({ v: 1, type: "heartbeat", tick: 1, owner: "agent" });

    assert.equal(progresses[0]?.phase, "starting");
    assert.equal(progresses[0]?.decisionId, "decision-1");
    coordinator.close("test done");
  });

  test("the same idempotency key never reaches the body twice", () => {
    const harness = createHarness();
    connectHarness(harness);
    const first = harness.frame({ id: "c-1", idempotencyKey: "same-key" });
    harness.coordinator.issue(first);
    harness.advance(200);
    harness.coordinator.issue({ ...first, id: "c-2" });
    harness.advance(200);

    assert.equal(harness.body.state().completed.length, 1);
    assert.equal(commands(harness).filter((frame) => frame.idempotencyKey === "same-key").length, 1);
  });

  test("a result from a replaced body cannot settle a new session", () => {
    const harness = createHarness("manual");
    connectHarness(harness);
    harness.coordinator.issue(harness.frame({ id: "c-1" }));
    harness.advance(50);
    assert.equal(harness.coordinator.health().running, 1);

    harness.coordinator.close("socket closed");
    const next = createHarness("manual");
    connectHarness(next);
    next.coordinator.issue(next.frame({ id: "c-2" }));
    next.advance(50);

    next.coordinator.handle({
      v: 1,
      type: "result",
      taskId: harness.body.state().task?.taskId ?? "old-task",
      status: "completed",
    });

    assert.equal(next.coordinator.health().running, 1);
    assert.equal(next.actions.snapshot()[0]?.status, "queued");
  });

  test("a transport send failure settles the command instead of leaving it running", () => {
    const actions = new MemoryActionPort();
    const outcomes: string[] = [];
    let ready = false;
    const session = new BodySession({
      token: TOKEN,
      sessionId: "send-failure",
      transport: {
        send: () => {
          if (!ready) return;
          throw new Error("socket is not writable");
        },
        close: () => {},
      },
      clock: { now: () => 1_000 },
      scheduler: {
        setInterval: () => 1,
        clearInterval: () => undefined,
      },
      actions,
      onOutcome: (outcome) => outcomes.push(outcome.taskId),
    });
    session.handle({
      v: 1,
      type: "hello",
      token: TOKEN,
      client: "test-body",
      capabilities: ["sensor"],
      skills: ["wait"],
    });
    ready = true;
    session.issue({
      v: 1,
      type: "cmd",
      id: "send-failure-command",
      op: "wait",
      args: {},
      priority: "command",
      idempotencyKey: "send-failure-key",
    });

    assert.equal(outcomes.length, 1);
    assert.equal(actions.snapshot()[0]?.status, "failed");
    assert.equal(session.health().running, 0);
  });

  test("a reused command id is ignored instead of creating a second task", () => {
    const harness = createHarness();
    connectHarness(harness);
    harness.coordinator.issue(harness.frame({ id: "same-id", idempotencyKey: "key-a" }));
    harness.coordinator.issue(harness.frame({ id: "same-id", idempotencyKey: "key-b" }));

    assert.equal(commands(harness).filter((frame) => frame.id === "same-id").length, 1);
  });

  test("an idle body receives no second command while one is in flight", () => {
    const harness = createHarness();
    connectHarness(harness);
    harness.coordinator.issue(harness.frame({ id: "c-1" }));
    harness.coordinator.issue(harness.frame({ id: "c-2" }));

    assert.equal(commands(harness).length, 1);
    harness.advance(200);
    assert.equal(commands(harness).length, 2);
  });

  test("a cancelled command is terminal even if the body later reports completion", () => {
    const harness = createHarness();
    connectHarness(harness);
    harness.coordinator.issue(harness.frame({ id: "c-1" }));
    harness.coordinator.cancel("c-1", "operator moved");
    harness.advance(200);

    assert.equal(harness.actions.snapshot()[0]?.status, "cancelled");
    assert.equal(harness.actions.snapshot()[0]?.status, "cancelled");
    assert.deepEqual(harness.body.state().pressed, []);
  });

  test("an orchestrator cancel is not proof the body stopped until it reports", () => {
    const harness = createHarness("manual");
    connectHarness(harness);
    harness.coordinator.issue(harness.frame({ id: "c-1" }));
    harness.coordinator.cancel("c-1", "orchestrator cancel");

    assert.equal(harness.actions.snapshot()[0]?.status, "cancelled");
    assert.deepEqual(harness.body.state().pressed, []);
  });

  test("a queued command still expires without a body ack", () => {
    const harness = createHarness("manual");
    connectHarness(harness);
    harness.coordinator.issue(
      harness.frame({ id: "c-1", deadlineTick: 10 }),
    );
    harness.coordinator.handle({
      v: 1,
      type: "heartbeat",
      tick: 20,
      owner: "agent",
    });
    harness.advance(100);

    assert.equal(harness.actions.snapshot()[0]?.status, "timeout");
    assert.ok(harness.sent.some((frame) => frame.type === "cancel"));
  });

  test("progress extends the coordinator's own default deadline", () => {
    const harness = createHarness("manual");
    connectHarness(harness);
    // No deadlineTick: the coordinator supplies its default 30s window.
    harness.coordinator.issue(harness.frame({ id: "c-1" }));
    const sent = harness.sent.at(-1);
    assert.ok(sent && sent.type === "cmd");
    harness.coordinator.handle({
      v: 1,
      type: "ack",
      id: "c-1",
      taskId: "task-body-1",
      accepted: true,
    });
    const before = harness.coordinator.pendingCommand("c-1")?.command.deadlineTick;
    assert.equal(typeof before, "number");

    // Real digging progress must move the deadline, not freeze the task at
    // the 30-second default.
    harness.coordinator.handle({
      v: 1,
      type: "progress",
      taskId: "task-body-1",
      phase: "breaking",
      done: 20,
      total: 100,
      tick: 1_000,
    });
    const after = harness.coordinator.pendingCommand("c-1")?.command.deadlineTick;
    assert.equal(typeof after, "number");
    assert.ok((after as number) > (before as number));
  });

  test("a timed-out command is reported as timeout and the body is told to stop", () => {
    const harness = createHarness("manual");
    connectHarness(harness);
    harness.coordinator.issue(harness.frame({ id: "c-1", deadlineTick: 10 }));
    harness.coordinator.handle({
      v: 1,
      type: "heartbeat",
      tick: 20,
      owner: "agent",
    });
    harness.advance(100);

    assert.equal(harness.actions.snapshot()[0]?.status, "timeout");
    assert.ok(harness.sent.some((frame) => frame.type === "cancel"));
    assert.deepEqual(harness.body.state().pressed, []);
  });

  test("takeover cancels running and queued work", () => {
    const harness = createHarness("manual");
    connectHarness(harness);
    harness.coordinator.issue(harness.frame({ id: "c-1" }));
    harness.coordinator.issue(harness.frame({ id: "c-2" }));
    harness.advance(50);
    harness.coordinator.takeOver();

    assert.equal(harness.coordinator.currentOwnership.owner, "operator");
    assert.deepEqual(
      harness.actions.snapshot().map((attempt) => attempt.status),
      ["cancelled", "cancelled"],
    );
    assert.equal(harness.coordinator.health().queued, 0);
  });
});

describe("bridge local watchdog", () => {
  test("a missing heartbeat releases held keys within the negotiated watchdog", () => {
    const harness = createHarness("manual");
    connectHarness(harness);
    harness.body.handle({
      v: 1,
      type: "heartbeat",
      tick: 2,
      owner: "agent",
      world: { inWorld: true },
    });
    harness.coordinator.issue(harness.frame({ id: "c-1" }));
    harness.advance(50);
    assert.ok(harness.body.state().pressed.length > 0);

    harness.body.handle({
      v: 1,
      type: "heartbeat",
      tick: 2,
      owner: "agent",
      world: { inWorld: true },
    });
    harness.sent.splice(0, harness.sent.length);
    harness.advance(2_000);
    assert.deepEqual(harness.body.state().pressed, []);
    assert.ok(harness.body.state().cancelled.length > 0);
  });
});

test("world loading does not become a sticky stop before the first in-world heartbeat", () => {
  let now = 1_000;
  const transport = {
    send: () => undefined,
    close: () => undefined,
  };
  const session = new BodySession({
    token: "secret",
    sessionId: "s",
    transport,
    clock: { now: () => now },
    scheduler: {
      setInterval: () => 1,
      clearInterval: () => undefined,
    },
    actions: new MemoryActionPort(),
  });

  session.handle({
    v: 1,
    type: "hello",
    token: "secret",
    client: "craftmate-body-fabric",
    capabilities: ["sensor"],
    skills: ["wait"],
  });

  now += 10_000;
  session.poll();
  assert.equal(session.control.permission, "agent");

  session.handle({
    v: 1,
    type: "heartbeat",
    tick: 1,
    owner: "agent",
    world: { inWorld: true },
  });
  now += 3_001;
  session.poll();
  assert.equal(session.control.permission, "stopped");
});

test("a brief render stall is inside the watchdog grace, not a lost player", () => {
  let now = 1_000;
  const session = new BodySession({
    token: "secret",
    sessionId: "grace",
    transport: { send: () => undefined, close: () => undefined },
    clock: { now: () => now },
    scheduler: { setInterval: () => 1, clearInterval: () => undefined },
    actions: new MemoryActionPort(),
  });
  session.handle({
    v: 1,
    type: "hello",
    token: "secret",
    client: "craftmate-body-fabric",
    capabilities: ["sensor"],
    skills: ["wait"],
  });
  session.handle({
    v: 1,
    type: "heartbeat",
    tick: 1,
    owner: "agent",
    world: { inWorld: true },
  });

  now += 2_500;
  session.poll();
  assert.equal(session.control.permission, "agent");

  now += 1_000;
  session.poll();
  assert.equal(session.control.permission, "stopped");
});

test("an orchestrator stall is not mistaken for a missing body heartbeat", () => {
  let now = 1_000;
  let mono = 50_000;
  const session = new BodySession({
    token: "secret",
    sessionId: "orchestrator-stall",
    transport: { send: () => undefined, close: () => undefined },
    clock: { now: () => now },
    monotonic: { now: () => mono },
    scheduler: { setInterval: () => 1, clearInterval: () => undefined },
    actions: new MemoryActionPort(),
  });
  session.handle({
    v: 1,
    type: "hello",
    token: "secret",
    client: "craftmate-body-fabric",
    capabilities: ["sensor"],
    skills: ["wait"],
  });
  session.handle({
    v: 1,
    type: "heartbeat",
    tick: 1,
    owner: "agent",
    world: { inWorld: true },
  });
  mono += 100;
  session.poll();

  // The Node event loop is blocked for five seconds. Nothing observed the
  // body during that window, so it cannot prove the body went silent.
  now += 5_000;
  mono += 5_000;
  session.poll();
  assert.equal(session.control.permission, "agent");

  // Once observation resumes, a fresh heartbeat keeps control healthy.
  session.handle({
    v: 1,
    type: "heartbeat",
    tick: 2,
    owner: "agent",
    world: { inWorld: true },
  });
  now += 500;
  mono += 500;
  session.poll();
  assert.equal(session.control.permission, "agent");
});

test("a liveness-only heartbeat does not erase the last world snapshot", () => {
  const harness = createHarness();
  harness.body.start();
  harness.advance(100);
  harness.coordinator.handle({
    v: 1,
    type: "heartbeat",
    tick: 100,
    owner: "agent",
    worldGeneration: 1,
    world: {
      inWorld: true,
      position: { x: 10, y: 64, z: 8 },
      nearbyBlocks: [{ id: "minecraft:stone" }],
    },
  });
  harness.coordinator.handle({
    v: 1,
    type: "heartbeat",
    tick: 101,
    owner: "agent",
    worldGeneration: 1,
    world: null,
  });

  assert.deepEqual(harness.coordinator.health().world, {
    inWorld: true,
    position: { x: 10, y: 64, z: 8 },
    nearbyBlocks: [{ id: "minecraft:stone" }],
  });
});

describe("bridge control ownership", () => {
  test("a reflex event preempts running work and keeps its reason", () => {
    const control = new ControlAuthority();
    const sessions = createSessions(control);
    const first = sessions.open();
    first.coordinator.issue(sessionsCommand("r-1"));
    sessions.advance(50);
    assert.equal(first.coordinator.health().running, 1);

    first.coordinator.handle({
      v: 1,
      type: "event",
      seq: 1,
      tick: 1,
      name: "reflex",
      data: { kind: "lava", detail: "站在岩浆里", health: 4 },
    });

    assert.equal(first.coordinator.health().running, 0);
    const attempt = sessions.actions.snapshot()[0];
    assert.equal(attempt?.status, "preempted");
    assert.equal(attempt?.result?.detail, "safety: 站在岩浆里");
    assert.deepEqual(
      first.coordinator.health().incidents.map((incident) => incident.kind),
      ["lava"],
    );
  });

  test("a threat reflex does not cancel the attack that is fighting it", () => {
    const control = new ControlAuthority();
    const sessions = createSessions(control);
    const first = sessions.open();
    first.coordinator.issue({
      ...sessionsCommand("r-attack"),
      op: "attack",
      args: { target: "minecraft:zombie" },
    });
    sessions.advance(50);
    assert.equal(first.coordinator.health().running, 1);

    first.coordinator.handle({
      v: 1,
      type: "event",
      seq: 1,
      tick: 1,
      name: "reflex",
      data: { kind: "threat", detail: "僵尸离你 3 格" },
    });

    // The fight is the recovery action. Keep the command alive so its own
    // hit/approach state machine can finish instead of restarting forever.
    assert.equal(first.coordinator.health().running, 1);
    assert.equal(first.coordinator.health().incidents.length, 1);

    first.coordinator.handle({
      v: 1,
      type: "event",
      seq: 2,
      tick: 2,
      name: "reflex",
      data: { kind: "lava", detail: "站在岩浆里" },
    });
    assert.equal(first.coordinator.health().running, 0);
  });

  test("a body cannot use reflex events to cancel an operator's work", () => {
    const control = new ControlAuthority();
    const sessions = createSessions(control);
    const first = sessions.open();
    first.coordinator.takeOver();

    first.coordinator.handle({
      v: 1,
      type: "event",
      seq: 1,
      tick: 1,
      name: "reflex",
      data: { kind: "lava", detail: "站在岩浆里" },
    });

    assert.equal(first.coordinator.health().incidents.length, 0);
  });

  function createSessions(control: ControlAuthority) {
    let now = 1_000;
    const scheduler = createVirtualScheduler(() => now);
    const clock = { now: () => now };
    const actions = new MemoryActionPort();

    const open = () => {
      let coordinator: BodySession;
      const body = new SimBody({
        token: TOKEN,
        clock,
        scheduler,
        skills: ["goto", "look_at", "mine_block", "wait", "attack"],
        ticksPerCommand: 20,
        autoComplete: false,
        send: (frame) => coordinator.handle(frame),
      });
      coordinator = new BodySession({
        token: TOKEN,
        sessionId: "session-control",
        clock,
        scheduler,
        actions,
        control,
        transport: {
          send: (frame) => body.handle(frame),
          close: () => {},
        },
      });
      body.start();
      return { coordinator, body };
    };

    return { open, actions, advance: (ms: number) => { now += ms; scheduler.advance(ms); } };
  }

  test("takeover invalidates queued work and does not auto-grant control on reconnect", () => {
    const control = new ControlAuthority();
    const sessions = createSessions(control);
    const first = sessions.open();
    first.coordinator.issue(sessionsCommand("c-1"));
    first.coordinator.issue(sessionsCommand("c-2"));
    sessions.advance(50);

    first.coordinator.takeOver();
    assert.equal(first.coordinator.currentOwnership.owner, "operator");
    assert.deepEqual(
      sessions.actions.snapshot().map((attempt) => attempt.status),
      ["cancelled", "cancelled"],
    );
    assert.deepEqual(first.body.state().pressed, []);

    first.coordinator.close("socket closed");
    const second = sessions.open();
    assert.equal(second.coordinator.currentOwnership.owner, "operator");
    assert.equal(second.coordinator.control.permission, "operator");
    assert.throws(() => second.coordinator.issue(sessionsCommand("c-3")), /not permitted/);

    second.coordinator.release();
    assert.equal(second.coordinator.currentOwnership.owner, "agent");
    assert.equal(second.coordinator.control.permission, "agent");
    assert.doesNotThrow(() => second.coordinator.issue(sessionsCommand("c-4")));
  });

  test("emergency stop survives reconnect until the operator explicitly releases", () => {
    const control = new ControlAuthority();
    const sessions = createSessions(control);
    const first = sessions.open();
    first.coordinator.issue(sessionsCommand("c-1"));
    sessions.advance(50);
    first.coordinator.emergencyStop();
    first.coordinator.close("socket closed");

    const second = sessions.open();
    assert.equal(second.coordinator.health().owner, "none");
    assert.equal(second.coordinator.health().permission, "stopped");
    assert.throws(() => second.coordinator.issue(sessionsCommand("c-2")), /not permitted/);

    second.coordinator.release("operator resumed");
    assert.equal(second.coordinator.health().owner, "agent");
    assert.doesNotThrow(() => second.coordinator.issue(sessionsCommand("c-3")));
  });

  test("a stale control generation cannot issue work after takeover", () => {
    const control = new ControlAuthority();
    const sessions = createSessions(control);
    const first = sessions.open();
    const generation = first.coordinator.control.generation;
    first.coordinator.takeOver();

    assert.throws(
      () => first.coordinator.issue(sessionsCommand("late-model-result"), {
        expectedGeneration: generation,
      }),
      /stale control generation/,
    );
    assert.equal(sessions.actions.snapshot().length, 0);
  });

  test("a heartbeat safety stop survives reconnect and resumes on the next heartbeat", () => {
    const control = new ControlAuthority();
    const sessions = createSessions(control);
    const first = sessions.open();
    first.coordinator.handle({
      v: 1,
      type: "heartbeat",
      tick: 1,
      owner: "agent",
      world: { inWorld: true },
    });
    first.coordinator.poll(10_000);
    assert.equal(first.coordinator.health().permission, "stopped");
    first.coordinator.close("socket closed");

    const second = sessions.open();
    assert.equal(second.coordinator.health().owner, "none");
    assert.throws(() => second.coordinator.issue(sessionsCommand("c-2")), /not permitted/);

    second.coordinator.handle({
      v: 1,
      type: "heartbeat",
      tick: 2,
      owner: "none",
      world: { inWorld: true },
    });
    assert.equal(second.coordinator.health().permission, "agent");
    assert.equal(second.coordinator.health().owner, "agent");
    assert.doesNotThrow(() => second.coordinator.issue(sessionsCommand("c-3")));
  });

  test("a missed heartbeat resumes agent control once the body is alive again", () => {
    const control = new ControlAuthority();
    const sessions = createSessions(control);
    const first = sessions.open();
    first.coordinator.handle({
      v: 1,
      type: "heartbeat",
      tick: 1,
      owner: "agent",
      world: { inWorld: true },
    });
    first.coordinator.poll(10_000);
    assert.equal(first.coordinator.health().permission, "stopped");

    first.coordinator.handle({
      v: 1,
      type: "heartbeat",
      tick: 2,
      owner: "agent",
      world: { inWorld: true },
    });
    assert.equal(first.coordinator.health().permission, "agent");
    assert.equal(first.coordinator.health().owner, "agent");
    assert.doesNotThrow(() => first.coordinator.issue(sessionsCommand("c-2")));
  });

  test("an explicit emergency stop is not cleared by a later heartbeat", () => {
    const control = new ControlAuthority();
    const sessions = createSessions(control);
    const first = sessions.open();
    first.coordinator.emergencyStop("operator pressed stop");

    first.coordinator.handle({
      v: 1,
      type: "heartbeat",
      tick: 2,
      owner: "none",
      world: { inWorld: true },
    });
    assert.equal(first.coordinator.health().permission, "stopped");
    assert.throws(() => first.coordinator.issue(sessionsCommand("c-3")), /not permitted/);
  });

  test("late ACK and result frames cannot revive work cancelled by takeover", () => {
    const control = new ControlAuthority();
    const sessions = createSessions(control);
    const first = sessions.open();
    first.coordinator.issue(sessionsCommand("c-1"));
    sessions.advance(50);
    first.coordinator.takeOver();

    first.coordinator.handle({
      v: 1,
      type: "ack",
      id: "c-1",
      accepted: true,
      taskId: "late-task",
    });
    first.coordinator.handle({
      v: 1,
      type: "result",
      taskId: "late-task",
      status: "completed",
    });
    assert.deepEqual(
      sessions.actions.snapshot().map((attempt) => attempt.status),
      ["cancelled"],
    );
    assert.equal(first.coordinator.health().owner, "operator");
    assert.deepEqual(first.body.state().pressed, []);
  });
});

function sessionsCommand(id: string): SkillCommand {
  return {
    v: 1,
    type: "cmd",
    id,
    op: "mine_block",
    args: {},
    priority: "command",
    idempotencyKey: `control-key-${id}`,
  };
}

describe("bridge queue", () => {
  const command = (id: string, priority: SkillCommand["priority"]): SkillCommand => ({
    v: 1,
    type: "cmd",
    id,
    op: "goto",
    args: {},
    priority,
    idempotencyKey: id,
  });

  test("the queue is bounded and rejects ambient work before higher priorities", () => {
    const queue = new CommandQueue({ capacity: 1 });
    queue.accept(command("c-1", "ambient"), "a-1", 1);

    assert.throws(() => queue.accept(command("c-2", "ambient"), "a-2", 2), /queue is full/);
    assert.doesNotThrow(() => queue.accept(command("c-3", "safety"), "a-3", 3));
    assert.equal(queue.queuedCount(), 1);
    assert.equal(queue.peek()?.command.id, "c-3");
  });

  test("a terminal task cannot be revived", () => {
    const queue = new CommandQueue({ capacity: 2 });
    const accepted = queue.accept(command("c-1", "plan"), "a-1", 1);
    queue.settle(accepted.record.taskId, "completed");

    assert.throws(() => queue.settle(accepted.record.taskId, "failed"), /already completed/);
  });

  test("progress extends only an orchestrator default deadline", () => {
    const queue = new CommandQueue({ capacity: 2 });
    const automatic = queue.accept(
      { ...command("c-auto", "command"), deadlineTick: 100 },
      "a-auto",
      1,
      true,
    );
    const explicit = queue.accept(
      { ...command("c-explicit", "command"), deadlineTick: 100 },
      "a-explicit",
      1,
      false,
    );

    queue.extend(automatic.record.taskId, 200);
    queue.extend(explicit.record.taskId, 200);

    assert.equal(automatic.record.command.deadlineTick, 200);
    assert.equal(explicit.record.command.deadlineTick, 100);
  });

  test("retained history stays bounded without losing recent terminal checks", () => {
    const queue = new CommandQueue({ capacity: 2, historyLimit: 2 });
    for (let index = 0; index < 10; index += 1) {
      queue.accept(command(`c-${index}`, "ambient"), `a-${index}`, index);
      queue.settle(`task-${index + 1}`, "completed");
    }

    assert.equal(queue.snapshot().length, 2);
    assert.throws(() => queue.settle("task-9", "failed"), /already completed/);
    assert.throws(() => queue.settle("task-1", "failed"), /unknown task/);
  });
});
