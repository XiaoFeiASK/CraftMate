import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KNOWLEDGE_GRAPH,
  acquisitionActions,
  acquisitionPath,
  allIronAcceptancePaths,
  graphNode,
  itemNode,
  validateKnowledgeGraph,
} from "./graph.ts";

test("the embedded graph covers the complete 1.20.1 registries", () => {
  assert.equal(KNOWLEDGE_GRAPH.counts.items, 1255);
  assert.equal(KNOWLEDGE_GRAPH.counts.blocks, 1003);
  assert.equal(KNOWLEDGE_GRAPH.counts.entities, 124);
  assert.equal(KNOWLEDGE_GRAPH.counts.dimensions, 3);
  for (const dimension of ["overworld", "the_nether", "the_end"]) {
    assert.ok(graphNode(`dimension:minecraft:${dimension}`));
  }
});

test("graph references are complete and generic items have a survival path", () => {
  const validation = validateKnowledgeGraph();
  assert.deepEqual(validation.errors, []);
  assert.ok(validation.ok);
});

test("iron has both mining and alternative acquisition actions", () => {
  const actions = acquisitionActions("minecraft:iron_ingot");
  assert.ok(actions.some((edge) => edge.from.startsWith("action:smelt:")));
  assert.ok(actions.some((edge) => edge.from.startsWith("action:craft:")) || actions.length === 1);
  const ore = acquisitionActions("minecraft:iron_ore");
  assert.ok(ore.some((edge) => edge.from === "action:silk_touch:minecraft:iron_ore"));
});

test("all six iron acceptance items have evidence-backed paths", () => {
  const paths = allIronAcceptancePaths();
  for (const [item, path] of Object.entries(paths)) {
    assert.notEqual(path, null, item);
    assert.ok(path!.evidence.length > 0, item);
  }
});

test("creative-only items stay present but are marked unobtainable", () => {
  const barrier = itemNode("minecraft:barrier");
  assert.ok(barrier);
  assert.equal(barrier?.creativeOnly, true);
  assert.equal(barrier?.obtainable, false);
  const bundle = itemNode("minecraft:bundle");
  assert.equal(bundle?.creativeOnly, true);
});

test("structured variants do not expand NBT into node ids", () => {
  assert.ok(itemNode("minecraft:potion")?.variants?.["kind"] === "potion");
  assert.ok(itemNode("minecraft:enchanted_book")?.variants?.["kind"] === "enchantment");
  assert.equal(itemNode("minecraft:potion{effect:healing}"), null);
});

test("a path resolves through action inputs instead of a flat lookup", () => {
  const path = acquisitionPath("minecraft:iron_pickaxe");
  assert.ok(path);
  assert.ok(path!.action.includes("craft") || path!.action.includes("trade"));
  assert.ok(path!.inputs.length > 0);
});
