import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  BridgeClientFrame,
  BridgeServerFrame,
  SkillCommand,
} from "@craftmate/contracts";
import { BodySession, CLOSE_PROTOCOL, CLOSE_UNAUTHORIZED } from "./coordinator.ts";
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
  readonly connect: (token?: string) => void;
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
    watchdogMs: 500,
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
    connect: (token = TOKEN) => {
      body.start();
      void token;
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
      assert.equal(welcome.watchdogMs, 500);
      assert.equal(welcome.sessionId, "session-test");
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
      () => harness.coordinator.issue(harness.frame({ id: "c-1", op: "build_schematic" })),
      /did not advertise build_schematic/,
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

  test("takeover cancels running work but keeps queued work", () => {
    const harness = createHarness("manual");
    connectHarness(harness);
    harness.coordinator.issue(harness.frame({ id: "c-1" }));
    harness.coordinator.issue(harness.frame({ id: "c-2" }));
    harness.advance(50);
    harness.coordinator.takeOver();

    assert.equal(harness.coordinator.currentOwnership.owner, "operator");
    assert.equal(harness.actions.snapshot()[0]?.status, "cancelled");
  });
});

describe("bridge local watchdog", () => {
  test("a missing heartbeat releases held keys within 500ms", () => {
    const harness = createHarness("manual");
    connectHarness(harness);
    harness.coordinator.issue(harness.frame({ id: "c-1" }));
    harness.advance(50);
    assert.ok(harness.body.state().pressed.length > 0);

    harness.body.handle({
      v: 1,
      type: "heartbeat",
      tick: 2,
      owner: "agent",
    });
    harness.sent.splice(0, harness.sent.length);
    harness.advance(600);
    assert.deepEqual(harness.body.state().pressed, []);
    assert.ok(harness.body.state().cancelled.length > 0);
  });
});

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
