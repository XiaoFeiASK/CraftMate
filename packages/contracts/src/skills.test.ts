import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BridgeCapability, SkillName } from "./bridge.ts";
import { FABRIC_BODY_CAPABILITIES, FABRIC_BODY_SKILLS, SKILL_CAPABILITY, parseSkillArgs, skillNameSchema } from "./skills.ts";

describe("skills", () => {
  test("parses supported skill arguments", () => {
    const parsed = parseSkillArgs("mine_block", { block: "minecraft:stone" });
    if (parsed?.name !== "mine_block") throw new Error("mine_block was not parsed");
    assert.equal(parsed.args.block, "minecraft:stone");
    assert.equal(parseSkillArgs("mine_block", { block: "minecraft:stone", count: 0 }), null);
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
  });
});

describe("fabric body capability catalogue", () => {
  test("executable skills map to advertised capabilities", () => {
    assert.equal(FABRIC_BODY_SKILLS.length, 16);
    assert.ok((FABRIC_BODY_SKILLS as readonly SkillName[]).includes("sleep"));
    const capabilities: readonly BridgeCapability[] = FABRIC_BODY_CAPABILITIES;
    for (const skill of FABRIC_BODY_SKILLS) {
      assert.ok(capabilities.includes(SKILL_CAPABILITY[skill] as BridgeCapability));
    }
  });

  test("contract catalogue is not mistaken for current body capabilities", () => {
    const implemented = new Set([
      "goto", "look_at", "mine_block", "chop_tree", "collect_items", "craft", "deposit", "say", "wait", "attack", "equip", "eat", "use_block", "place_block", "pillar_up", "sleep",
    ]);
    for (const skill of skillNameSchema.options) {
      assert.equal((FABRIC_BODY_SKILLS as readonly SkillName[]).includes(skill), implemented.has(skill));
    }
    assert.equal(implemented.size, FABRIC_BODY_SKILLS.length);
  });
});
