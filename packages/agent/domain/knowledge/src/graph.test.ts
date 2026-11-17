import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KNOWLEDGE_GRAPH,
  acquisitionTree,
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

test("AND inputs are all present, while OR alternatives choose one branch", () => {
  const path = acquisitionPath("minecraft:iron_pickaxe");
  assert.ok(path);
  const items = path!.inputs.map((input) => input.item).sort();
  assert.ok(items.includes("minecraft:iron_ingot"));
  assert.ok(items.includes("minecraft:stick"));

  const stick = acquisitionPath("minecraft:stick");
  assert.ok(stick);
  assert.equal(stick!.inputs.length, 1);
  assert.match(stick!.inputs[0]!.item, /_planks$/u);
});

test("the acquisition tree prefers a stocked OR alternative", () => {
  const tree = acquisitionTree("minecraft:stick", 4, {
    available: (item) => (item === "minecraft:oak_planks" ? 4 : 0),
  });
  assert.ok(tree);
  const planks = tree!.children.find(
    (child) => child.key.startsWith("item:") && child.target.endsWith("_planks"),
  );
  assert.equal(planks?.target, "minecraft:oak_planks");
  assert.deepEqual(planks?.children, []);
});

test("the tree follows the stocked raw-iron smelt branch", () => {
  const stock = new Map([
    ["minecraft:raw_iron", 3],
    ["minecraft:coal", 2],
    ["minecraft:stick", 2],
  ]);
  const tree = acquisitionTree("minecraft:iron_pickaxe", 1, {
    available: (item) => stock.get(item) ?? 0,
  });
  assert.ok(tree);
  assert.ok(
    tree!.children.some((child) => child.target.includes(":smelt:")),
  );
  assert.ok(
    !tree!.children.some((child) => child.target.includes("iron_block")),
  );
});
