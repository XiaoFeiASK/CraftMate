/**
 * Hand-written mirror of the generated data shapes. The generator validates
 * every row before writing, so a Minecraft data change cannot silently change
 * the contract consumed by the planner.
 */
export interface KnowledgeMeta {
  readonly schemaVersion: 1;
  readonly minecraftVersion: string;
  readonly source: string;
  readonly sourceTag: string;
  readonly dataVersion: number;
  readonly generatedFrom: string;
}

export interface Ingredient {
  readonly choices: readonly string[];
  readonly tag?: string;
  readonly count: number;
}

export interface ItemStack {
  readonly item: string;
  readonly count: number;
}

export interface CraftingRecipe {
  readonly id: string;
  readonly type: "crafting_shaped" | "crafting_shapeless";
  readonly station: "inventory" | "crafting_table";
  readonly grid: 2 | 3;
  readonly ingredients: readonly Ingredient[];
  readonly output: ItemStack;
  readonly group: string | null;
}

export interface CookingRecipe {
  readonly id: string;
  readonly station: "furnace" | "blast_furnace" | "smoker" | "campfire";
  readonly input: Ingredient;
  readonly output: ItemStack;
  readonly cookingTimeTicks: number;
  readonly experience: number;
}

export interface Fuel {
  readonly item: string;
  readonly seconds: number;
}

export interface DropStack {
  readonly item: string;
  readonly min: number;
  readonly max: number;
}

export interface BlockDrop {
  readonly block: string;
  readonly drops: readonly DropStack[];
}

export interface EntityDrop {
  readonly entity: string;
  readonly drops: readonly DropStack[];
}

export interface ToolInfo {
  readonly type: string;
  readonly tier: string;
  readonly rank: number;
}

export interface BlockToolRequirement {
  readonly block: string;
  readonly tool: string;
  readonly minimumTier: string;
}

export interface ToolTiersData {
  readonly meta: KnowledgeMeta;
  readonly ranks: Readonly<Record<string, number>>;
  readonly tools: Readonly<Record<string, ToolInfo>>;
  readonly blocks: readonly BlockToolRequirement[];
}

export type ToolTier = "hand" | "wood" | "gold" | "stone" | "iron" | "diamond" | "netherite";

export const isKnowledgeMeta = (value: unknown): value is KnowledgeMeta =>
  isRecord(value) &&
  value["schemaVersion"] === 1 &&
  typeof value["minecraftVersion"] === "string" &&
  typeof value["source"] === "string" &&
  typeof value["sourceTag"] === "string" &&
  typeof value["dataVersion"] === "number" &&
  typeof value["generatedFrom"] === "string";

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isItemId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/u.test(value);

export const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
