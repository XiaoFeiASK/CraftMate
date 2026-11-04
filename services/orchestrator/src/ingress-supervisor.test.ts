import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createIngressSupervisor } from "./ingress-supervisor.ts";

class FakeChild extends EventEmitter {
  readonly pid = 42;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killedWith: string[] = [];
  readonly sent: unknown[] = [];
  connected = true;

  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith.push(signal ?? "SIGTERM");
    this.signalCode = signal ?? "SIGTERM";
    this.emit("exit", null, this.signalCode);
    return true;
  }
}

test("configuring a room starts Ingress, changes in place, and clearing stops it", async () => {
  const children: FakeChild[] = [];
  const launched: NodeJS.ProcessEnv[] = [];
  const health: string[] = [];
  const supervisor = createIngressSupervisor({
    entry: "/tmp/craftmate-ingress.ts",
    publishHealth: (next) => health.push(`${next.state}:${next.detail}`),
    spawnProcess: ((_command, _args, options) => {
      const child = new FakeChild();
      children.push(child);
      launched.push(options?.env ?? {});
      return child as unknown as ChildProcess;
    }) as typeof import("node:child_process").spawn,
  });

  await supervisor.configure({ roomId: "123", dyhubUrl: "ws://127.0.0.1:8757" });
  assert.equal(children.length, 1);
  assert.equal(launched[0]?.DOUYIN_ROOM_ID, "123");
  assert.equal(launched[0]?.DYHUB_URL, "ws://127.0.0.1:8757");

  await supervisor.configure({ roomId: "456", dyhubUrl: "ws://localhost:8757" });
  assert.equal(children.length, 1);
  assert.deepEqual(children[0]?.sent, [
    { type: "configure", config: { roomId: "456", dyhubUrl: "ws://localhost:8757" } },
  ]);

  await supervisor.configure({ roomId: "", dyhubUrl: "ws://127.0.0.1:8757" });
  assert.deepEqual(children[0]?.killedWith, ["SIGTERM"]);
  assert.ok(health.at(-1)?.startsWith("closed:"));
  await supervisor.close();
});

test("an unchanged room does not restart an already running Ingress", async () => {
  let starts = 0;
  const child = new FakeChild();
  const supervisor = createIngressSupervisor({
    entry: "/tmp/craftmate-ingress.ts",
    publishHealth: () => undefined,
    spawnProcess: (() => {
      starts += 1;
      return child as unknown as ChildProcess;
    }) as typeof import("node:child_process").spawn,
  });

  const config = { roomId: "123", dyhubUrl: "ws://127.0.0.1:8757" };
  await supervisor.configure(config);
  await supervisor.configure(config);
  assert.equal(starts, 1);
  await supervisor.close();
});
