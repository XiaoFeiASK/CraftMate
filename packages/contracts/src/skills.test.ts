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
  });
});

describe("fabric body capability catalogue", () => {
  test("executable skills map to advertised capabilities", () => {
    assert.equal(FABRIC_BODY_SKILLS.length, 10);
    const capabilities: readonly BridgeCapability[] = FABRIC_BODY_CAPABILITIES;
    for (const skill of FABRIC_BODY_SKILLS) {
      assert.ok(capabilities.includes(SKILL_CAPABILITY[skill] as BridgeCapability));
    }
  });

  test("contract catalogue is not mistaken for current body capabilities", () => {
    const implemented = new Set([
      "goto", "look_at", "mine_block", "say", "wait", "attack", "equip", "eat", "use_block", "place_block",
    ]);
    for (const skill of skillNameSchema.options) {
      assert.equal((FABRIC_BODY_SKILLS as readonly SkillName[]).includes(skill), implemented.has(skill));
    }
    assert.equal(implemented.size, FABRIC_BODY_SKILLS.length);
  });
});
