import type { PlanStep } from "@craftmate/contracts";
import {
  acquisitionTree,
  inventoryCount,
  normalizeItemId,
  recipesFor,
  smeltingFor,
  type AcquisitionNode,
  type CraftingRecipe,
  type WorldFacts,
} from "../domain/index.ts";
import { guardsForSkill } from "./plan-compiler.ts";

export interface CompiledAcquisition {
  readonly item: string;
  readonly count: number;
  readonly steps: readonly PlanStep[];
  readonly tree: AcquisitionNode | null;
}

export interface AcquisitionTarget {
  readonly item: string;
  readonly count: number;
}

interface Snapshot {
  readonly counts: Map<string, number>;
  readonly steps: number;
  readonly tablePlaced: boolean;
}

/**
 * Turns a knowledge-graph acquisition branch into executable craft/smelt
 * steps, but only when every leaf is already in the backpack. Mining, looting
 * and trading stay with the survival planner: this compiler never pretends a
 * missing resource is available. Counts are reserved across siblings, so two
 * gear recipes cannot spend the same ingot.
 */
export function compileAcquisitionChain(
  item: string,
  count: number,
  facts: WorldFacts,
  options: { readonly maxSteps?: number; readonly maxDepth?: number } = {},
): CompiledAcquisition | null {
  const target = normalizeItemId(item);
  const requested = Math.max(1, Math.trunc(count));
  const maxSteps = options.maxSteps ?? 12;
  const maxDepth = options.maxDepth ?? 8;
  const compiler = new ChainCompiler(facts, maxSteps, maxDepth);
  if (!compiler.ensure(target, requested, 0, new Set())) return null;
  if (compiler.steps.length === 0 || compiler.steps.length > maxSteps) return null;
  return {
    item: target,
    count: requested,
    steps: compiler.steps,
    tree: acquisitionTree(target, requested, {
      available: (candidate) => inventoryCount(facts, candidate),
      ...(facts.stations === undefined ? {} : { stations: facts.stations }),
    }),
  };
}

/**
 * Compiles several independent targets against one shared inventory ledger.
 * Unaffordable targets are skipped, which is what an iron-set batch needs:
 * three ingots buy a pickaxe, not six full pieces.
 */
export function compileAcquisitionBatch(
  targets: readonly AcquisitionTarget[],
  facts: WorldFacts,
  options: {
    readonly maxSteps?: number;
    readonly maxDepth?: number;
    readonly skipUnavailable?: boolean;
  } = {},
): CompiledAcquisition | null {
  const maxSteps = options.maxSteps ?? 14;
  const maxDepth = options.maxDepth ?? 8;
  const compiler = new ChainCompiler(facts, maxSteps, maxDepth);
  let first: AcquisitionTarget | null = null;
  for (const target of targets) {
    const item = normalizeItemId(target.item);
    const count = Math.max(1, Math.trunc(target.count));
    const snapshot = compiler.snapshot();
    if (compiler.ensure(item, count, 0, new Set())) {
      first ??= { item, count };
      continue;
    }
    compiler.restore(snapshot);
    if (options.skipUnavailable === false) return null;
  }
  if (first === null || compiler.steps.length === 0 || compiler.steps.length > maxSteps) {
    return null;
  }
  return {
    item: first.item,
    count: first.count,
    steps: compiler.steps,
    tree: acquisitionTree(first.item, first.count, {
      available: (candidate) => inventoryCount(facts, candidate),
      ...(facts.stations === undefined ? {} : { stations: facts.stations }),
    }),
  };
}

class ChainCompiler {
  readonly steps: PlanStep[] = [];
  private readonly counts = new Map<string, number>();
  private readonly requirements = new Map<string, number>();
  private readonly facts: WorldFacts;
  private readonly maxSteps: number;
  private readonly maxDepth: number;
  private tablePlaced = false;
  private serial = 0;

  constructor(
    facts: WorldFacts,
    maxSteps: number,
    maxDepth: number,
  ) {
    this.facts = facts;
    this.maxSteps = maxSteps;
    this.maxDepth = maxDepth;
    for (const slot of facts.inventory) {
      const item = normalizeItemId(slot.item);
      this.counts.set(item, (this.counts.get(item) ?? 0) + Math.max(0, slot.count));
    }
  }

  ensure(item: string, need: number, depth: number, stack: Set<string>): boolean {
    if (need <= 0) return true;
    if ((this.counts.get(item) ?? 0) >= need) return true;
    if (depth > this.maxDepth || stack.has(item)) return false;
    if (this.steps.length >= this.maxSteps) return false;
    const previousRequirement = this.requirements.get(item);
    if (previousRequirement === undefined || need > previousRequirement) {
      this.requirements.set(item, need);
    }
    stack.add(item);
    try {
      /*
       * Raw ore -> ingot is the canonical path. Trying crafting first made a
       * direct ingot top-up bounce through ingot -> nugget -> ingot, which is
       * a net-zero cycle when the backpack already holds part of the target.
       */
      if (this.trySmelt(item, need, depth, stack)) return true;
      if (this.tryCraft(item, need, depth, stack)) return true;
      return false;
    } finally {
      stack.delete(item);
      if (previousRequirement === undefined) {
        this.requirements.delete(item);
      } else {
        this.requirements.set(item, previousRequirement);
      }
    }
  }

  private tryCraft(
    item: string,
    need: number,
    depth: number,
    stack: Set<string>,
  ): boolean {
    const deficit = need - (this.counts.get(item) ?? 0);
    for (const recipe of recipesFor(item)) {
      const snapshot = this.snapshot();
      if (!this.ensureStation(recipe, depth, stack)) {
        this.restore(snapshot);
        continue;
      }
      const batches = Math.max(
        1,
        Math.ceil(deficit / Math.max(1, recipe.output.count)),
      );
      let valid = true;
      for (const ingredient of recipe.ingredients) {
        const required = ingredient.count * batches;
        const chosen = this.choose(
          ingredient.choices,
          required,
          depth,
          stack,
          snapshot,
        );
        if (chosen === null || !this.take(chosen, required)) {
          valid = false;
          break;
        }
      }
      if (!valid) {
        this.restore(snapshot);
        continue;
      }
      this.add(item, recipe.output.count * batches);
      this.steps.push({
        id: this.stepId(`craft:${short(item)}`),
        skill: "craft",
        args: { item, count: deficit },
        label: `合成 ${short(item)} ×${deficit}`,
        guards: [
          ...guardsForSkill("craft", { item, count: deficit }, this.facts),
        ],
        ...(recipe.station === "crafting_table"
          ? { targetFamilyId: "station:crafting_table" }
          : {}),
        evidence: [`inventory gain: ${item}`],
      });
      return true;
    }
    return false;
  }

  private trySmelt(
    item: string,
    need: number,
    depth: number,
    stack: Set<string>,
  ): boolean {
    const deficit = need - (this.counts.get(item) ?? 0);
    for (const recipe of smeltingFor(item)) {
      const snapshot = this.snapshot();
      const batches = Math.max(
        1,
        Math.ceil(deficit / Math.max(1, recipe.output.count)),
      );
      const required = recipe.input.count * batches;
      const chosen = this.choose(
        recipe.input.choices,
        required,
        depth,
        stack,
        snapshot,
      );
      if (chosen === null || !this.take(chosen, required)) {
        this.restore(snapshot);
        continue;
      }
      this.add(item, recipe.output.count * batches);
      this.steps.push({
        id: this.stepId(`smelt:${short(item)}`),
        skill: "smelt",
        args: { input: chosen, output: item, count: batches },
        label: `熔炼 ${short(item)} ×${batches}`,
        guards: [
          ...guardsForSkill(
            "smelt",
            { input: chosen, output: item, count: batches },
            this.facts,
          ),
        ],
        evidence: [`inventory gain: ${item}`],
      });
      return true;
    }
    return false;
  }

  private choose(
    choices: readonly string[],
    need: number,
    depth: number,
    stack: Set<string>,
    recipeSnapshot: Snapshot,
  ): string | null {
    const ordered = [...choices].sort(
      (left, right) =>
        (this.counts.get(right) ?? 0) - (this.counts.get(left) ?? 0) ||
        left.localeCompare(right),
    );
    for (const choice of ordered) {
      const snapshot = this.snapshot();
      if (this.ensure(choice, need, depth + 1, stack)) return choice;
      // A failed choice must not leave a half-crafted branch behind.
      this.restore(snapshot);
    }
    this.restore(recipeSnapshot);
    return null;
  }

  private ensureStation(
    recipe: CraftingRecipe,
    depth: number,
    stack: Set<string>,
  ): boolean {
    if (recipe.station !== "crafting_table" || this.tablePlaced) return true;
    if (this.tableInReach()) {
      this.tablePlaced = true;
      return true;
    }
    if ((this.counts.get("minecraft:crafting_table") ?? 0) < 1) {
      if (!this.ensure("minecraft:crafting_table", 1, depth + 1, stack)) {
        return false;
      }
    }
    if (!this.take("minecraft:crafting_table", 1)) return false;
    this.steps.push({
      id: this.stepId("place:crafting_table"),
      skill: "place_block",
      args: { block: "minecraft:crafting_table", count: 1 },
      label: "放置工作台",
      guards: [],
      evidence: ["nearbyBlocks contains crafting_table"],
    });
    this.tablePlaced = true;
    return true;
  }

  private tableInReach(): boolean {
    const position = this.facts.position;
    const table = this.facts.craftingTable;
    return (
      (this.facts.stations ?? []).includes("crafting_table") ||
      this.facts.craftingTableNearby === true ||
      (position !== undefined &&
        position !== null &&
        table !== undefined &&
        table !== null &&
        Math.hypot(
          table.x - position.x,
          table.y - position.y,
          table.z - position.z,
        ) <= 4.5)
    );
  }

  private take(item: string, count: number): boolean {
    const available = this.counts.get(item) ?? 0;
    if (available < count) return false;
    /*
     * Never spend stock that an ancestor branch still has to deliver. This
     * rejects the ingot -> nugget -> ingot loop even when a partial ingot
     * stack happens to satisfy the nugget recipe's single-ingot input.
     */
    const required = this.requirements.get(item);
    if (required !== undefined && available - count < required) return false;
    this.counts.set(item, available - count);
    return true;
  }

  private add(item: string, count: number): void {
    this.counts.set(item, (this.counts.get(item) ?? 0) + count);
  }

  private stepId(label: string): string {
    this.serial++;
    return `acq:${this.serial}:${label}`.slice(0, 100);
  }

  snapshot(): Snapshot {
    return {
      counts: new Map(this.counts),
      steps: this.steps.length,
      tablePlaced: this.tablePlaced,
    };
  }

  restore(snapshot: Snapshot): void {
    this.counts.clear();
    for (const [item, count] of snapshot.counts) this.counts.set(item, count);
    this.steps.length = snapshot.steps;
    this.tablePlaced = snapshot.tablePlaced;
  }
}

function short(item: string): string {
  return item.replace(/^minecraft:/u, "");
}
