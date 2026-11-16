import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BridgeCapability, SkillName } from "./bridge.ts";
import {
  FABRIC_BODY_CAPABILITIES,
  FABRIC_BODY_SKILLS,
  SKILL_CAPABILITY,
  parseSkillArgs,
  skillCallSchema,
  skillNameSchema,
} from "./skills.ts";

describe("skills", () => {
  test("parses supported skill arguments", () => {
    const parsed = parseSkillArgs("mine_block", { block: "minecraft:stone" });
    if (parsed?.name !== "mine_block") throw new Error("mine_block was not parsed");
    assert.equal(parsed.args.block, "minecraft:stone");
    assert.equal(parseSkillArgs("mine_block", { block: "minecraft:stone", count: 0 }), null);
    assert.deepEqual(
      parseSkillArgs("mine_block", {
        block: "minecraft:stone",
        count: 1,
        at: { x: 4, y: 32, z: -7 },
      }),
      {
        name: "mine_block",
        args: { block: "minecraft:stone", count: 1, at: { x: 4, y: 32, z: -7 } },
      },
    );
    assert.deepEqual(
      parseSkillArgs("mine_block", {
        block: "minecraft:dirt",
        count: 1,
        at: { x: 4, y: 32, z: -7 },
        requireDrop: false,
      }),
      {
        name: "mine_block",
        args: {
          block: "minecraft:dirt",
          count: 1,
          at: { x: 4, y: 32, z: -7 },
          requireDrop: false,
        },
      },
    );
    assert.deepEqual(parseSkillArgs("chop_tree", {}), { name: "chop_tree", args: { count: 1 } });
    assert.equal(parseSkillArgs("chop_tree", { count: 17 }), null);
    assert.deepEqual(parseSkillArgs("collect_items", {}), {
      name: "collect_items",
      args: { count: 1 },
    });
    assert.deepEqual(parseSkillArgs("collect_items", { item: "minecraft:oak_log", count: 3 }), {
      name: "collect_items",
      args: { item: "minecraft:oak_log", count: 3 },
    });
    assert.equal(parseSkillArgs("collect_items", { count: 65 }), null);
    assert.deepEqual(parseSkillArgs("craft", { item: "minecraft:stick", count: 4 }), {
      name: "craft",
      args: { item: "minecraft:stick", count: 4 },
    });
    assert.equal(parseSkillArgs("craft", { item: "minecraft:stick", count: 65 }), null);
    assert.deepEqual(parseSkillArgs("deposit", {}), { name: "deposit", args: {} });
    assert.deepEqual(
      parseSkillArgs("deposit", { container: { x: 1, y: 64, z: 2 } }),
      { name: "deposit", args: { container: { x: 1, y: 64, z: 2 } } },
    );
    assert.deepEqual(
      parseSkillArgs("deposit", {
        container: { x: 1, y: 64, z: 2 },
        item: "minecraft:oak_log",
      }),
      {
        name: "deposit",
        args: { container: { x: 1, y: 64, z: 2 }, item: "minecraft:oak_log" },
      },
    );
    assert.deepEqual(
      parseSkillArgs("deposit", {
        container: { x: 1, y: 64, z: 2 },
        item: "minecraft:cobblestone",
        maxStacks: 1,
      }),
      {
        name: "deposit",
        args: {
          container: { x: 1, y: 64, z: 2 },
          item: "minecraft:cobblestone",
          maxStacks: 1,
        },
      },
    );
    assert.equal(parseSkillArgs("deposit", { maxStacks: 0 }), null);
    assert.equal(parseSkillArgs("deposit", { maxStacks: 37 }), null);
    assert.deepEqual(parseSkillArgs("smelt", {
      input: "minecraft:raw_iron",
      output: "minecraft:iron_ingot",
      count: 3,
      fuel: "minecraft:coal",
    }), {
      name: "smelt",
      args: {
        input: "minecraft:raw_iron",
        output: "minecraft:iron_ingot",
        count: 3,
        fuel: "minecraft:coal",
      },
    });
    assert.equal(
      parseSkillArgs("goto", { target: { x: 1, y: 64, z: 2 } })?.name,
      "goto",
    );
    const digging = parseSkillArgs("goto", {
      target: { x: 1, y: 64, z: 2 },
      mode: "dig",
    });
    if (digging?.name !== "goto") throw new Error("dig goto was not parsed");
    assert.equal(digging.args.mode, "dig");
    assert.equal(
      parseSkillArgs("goto", {
        target: { x: 1, y: 64, z: 2 },
        mode: "tunnel",
      }),
      null,
    );
    const plan = parseSkillArgs("run_plan", {
      planId: "iron-finish",
      title: "完成铁套",
      entryNodeId: "node:iron",
      goalFamily: "iron-set",
      targetFamilies: [
        {
          id: "iron-ore",
          kind: "block",
          ids: ["minecraft:iron_ore", "minecraft:deepslate_iron_ore"],
        },
      ],
      steps: [
        {
          id: "smelt",
          skill: "smelt",
          args: {
            input: "minecraft:raw_iron",
            output: "minecraft:iron_ingot",
            count: 3,
          },
          guards: [{ type: "inventory", item: "minecraft:raw_iron", min: 3 }],
        },
        {
          id: "pickaxe",
          skill: "craft",
          args: { item: "minecraft:iron_pickaxe", count: 1 },
          guards: [{ type: "inventory", item: "minecraft:iron_ingot", min: 3 }],
          targetFamilyId: "iron-ore",
        },
      ],
      maxDurationSeconds: 180,
    });
    if (plan?.name !== "run_plan") throw new Error("run_plan was not parsed");
    assert.equal(plan.args.steps.length, 2);
    assert.equal(plan.args.stopOnFailure, true);
    assert.equal(plan.args.maxDurationSeconds, 180);
    assert.equal(
      parseSkillArgs("run_plan", {
        planId: "bad",
        title: "非法节点",
        entryNodeId: "node",
        goalFamily: "test",
        steps: [
          {
            id: "bad",
            skill: "mine_block",
            args: { block: "minecraft:stone", count: 0 },
          },
        ],
      }),
      null,
    );
    assert.equal(
      parseSkillArgs("run_plan", {
        planId: "nested",
        title: "嵌套任务",
        entryNodeId: "node",
        goalFamily: "test",
        steps: [
          {
            id: "child",
            skill: "run_plan",
            args: {
              planId: "child",
              title: "child",
              entryNodeId: "node",
              goalFamily: "test",
              steps: [{ id: "wait", skill: "wait", args: { ticks: 1 } }],
            },
          },
        ],
      }),
      null,
    );
    assert.equal(
      parseSkillArgs("run_plan", {
        planId: "too-long",
        title: "超长计划",
        entryNodeId: "node",
        goalFamily: "test",
        maxDurationSeconds: 181,
        steps: [{ id: "wait", skill: "wait", args: { ticks: 1 } }],
      }),
      null,
    );
    assert.equal(
      parseSkillArgs("run_plan", {
        planId: "too-many",
        title: "超长计划",
        entryNodeId: "node",
        goalFamily: "test",
        steps: Array.from({ length: 33 }, (_, index) => ({
          id: `wait-${index}`,
          skill: "wait" as const,
          args: { ticks: 1 },
        })),
      }),
      null,
    );
    assert.equal(
      parseSkillArgs("run_plan", {
        planId: "unknown-family",
        title: "未知目标族",
        entryNodeId: "node",
        goalFamily: "test",
        steps: [
          {
            id: "mine",
            skill: "mine_block",
            args: { block: "minecraft:iron_ore", count: 1 },
            targetFamilyId: "missing",
          },
        ],
      }),
      null,
    );
    assert.equal(
      parseSkillArgs("run_plan", {
        planId: "bad-guard",
        title: "非法守卫",
        entryNodeId: "node",
        goalFamily: "test",
        steps: [
          {
            id: "wait",
            skill: "wait",
            args: { ticks: 1 },
            guards: [{ type: "script", expression: "player.health > 0" }],
          },
        ],
      }),
      null,
    );
  });
});

describe("fabric body capability catalogue", () => {
  test("executable skills map to advertised capabilities", () => {
    assert.equal(FABRIC_BODY_SKILLS.length, 18);
    assert.ok((FABRIC_BODY_SKILLS as readonly SkillName[]).includes("sleep"));
    assert.ok((FABRIC_BODY_SKILLS as readonly SkillName[]).includes("smelt"));
    const capabilities: readonly BridgeCapability[] = FABRIC_BODY_CAPABILITIES;
    for (const skill of FABRIC_BODY_SKILLS) {
      assert.ok(capabilities.includes(SKILL_CAPABILITY[skill] as BridgeCapability));
    }
  });

  test("contract catalogue is not mistaken for current body capabilities", () => {
    const implemented = new Set([
      "goto", "look_at", "mine_block", "chop_tree", "collect_items", "craft", "deposit", "say", "wait", "attack", "equip", "eat", "use_block", "place_block", "pillar_up", "smelt", "sleep",
      "run_plan",
    ]);
    for (const skill of skillNameSchema.options) {
      assert.equal((FABRIC_BODY_SKILLS as readonly SkillName[]).includes(skill), implemented.has(skill));
    }
    assert.equal(implemented.size, FABRIC_BODY_SKILLS.length);
  });
});

describe("plan dispatch contract", () => {
  test("a skill call cannot smuggle a nested plan past the Agent gate", () => {
    assert.equal(
      skillCallSchema.safeParse({
        name: "run_plan",
        idempotencyKey: "nested",
        args: {
          planId: "outer",
          title: "outer",
          entryNodeId: "node",
          goalFamily: "test",
          steps: [
            {
              id: "inner",
              skill: "run_plan",
              args: {
                planId: "inner",
                title: "inner",
                entryNodeId: "node",
                goalFamily: "test",
                steps: [{ id: "wait", skill: "wait", args: { ticks: 1 } }],
              },
            },
          ],
        },
      }).success,
      false,
    );
  });
});
