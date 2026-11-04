import type { InventorySlot, NearbyBlock, NearbyEntity, WorldFacts } from "./types.ts";

/**
 * The subset of the body snapshot this layer reads. Every field is optional
 * so the domain can compile against an older `WorldSnapshot` while #39's
 * `inventory` / `timeOfDay` / `day` / `sleeping` fields are still rolling out.
 * A missing field stays missing; it is never defaulted to `false` or `0`.
 */
export interface SnapshotView {
  readonly inWorld?: boolean;
  readonly world?: string | null;
  readonly position?: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly health?: number | null;
  readonly food?: number | null;
  readonly timeOfDay?: number | null;
  readonly day?: number | null;
  readonly sleeping?: boolean | null;
  readonly screenOpen?: boolean | null;
  readonly onGround?: boolean | null;
  readonly selectedItem?: string | null;
  readonly inventory?: readonly {
    readonly section?: "hotbar" | "main" | "armor" | "offhand";
    readonly slot?: number;
    readonly item: string;
    readonly count: number;
    readonly durability?: number;
    readonly maxDurability?: number;
  }[];
  readonly hotbar?: readonly {
    readonly slot: number;
    readonly item: string;
    readonly count: number;
  }[];
  readonly nearbyBlocks?: readonly {
    readonly id: string;
    readonly count?: number;
  }[];
  readonly entities?: readonly {
    readonly name: string;
    readonly type: string;
    readonly distance: number;
  }[];
}

/**
 * Converts a wire snapshot (or a partial test fixture) into the read-only
 * domain facts. Missing fields stay missing on purpose: a planner must not
 * treat "not reported" as "false" or "zero".
 */
export function worldFactsFromSnapshot(snapshot: SnapshotView | null): WorldFacts {
  if (snapshot === null) return emptyWorldFacts();
  const inventory = normalizeInventory(snapshot.inventory, snapshot.hotbar);
  const nearbyBlocks = normalizeBlocks(snapshot.nearbyBlocks);
  const entities = normalizeEntities(snapshot.entities);
  const stations = inferStations(nearbyBlocks);
  const facts: WorldFacts = {
    inWorld: snapshot.inWorld === true,
    inventory,
    nearbyBlocks,
    entities,
    dimension: dimensionOf(snapshot.world),
    ...(stations.length === 0 ? {} : { stations }),
  };
  return withOptionals(facts, {
    world: snapshot.world,
    position: snapshot.position,
    health: snapshot.health,
    food: snapshot.food,
    timeOfDay: snapshot.timeOfDay,
    day: snapshot.day,
    sleeping: snapshot.sleeping,
    screenOpen: snapshot.screenOpen,
    onGround: snapshot.onGround,
    selectedItem: snapshot.selectedItem,
  });
}

export function emptyWorldFacts(): WorldFacts {
  return { inWorld: false, inventory: [] };
}

export function normalizeItem(id: string): string {
  const trimmed = id.trim().toLowerCase();
  if (trimmed.length === 0) return trimmed;
  return trimmed.includes(":") ? trimmed : `minecraft:${trimmed}`;
}

export function inventoryCount(facts: WorldFacts, item: string): number {
  const id = normalizeItem(item);
  return facts.inventory.reduce((total, slot) => (slot.item === id ? total + slot.count : total), 0);
}

export function inventoryItems(facts: WorldFacts): readonly string[] {
  return [...new Set(facts.inventory.map((slot) => slot.item))].sort();
}

/** Items whose id matches any of the supplied tags, resolved from inventory. */
export function inventoryBySuffix(facts: WorldFacts, suffix: RegExp): readonly InventorySlot[] {
  return facts.inventory.filter((slot) => suffix.test(slot.item));
}

export function hasItem(facts: WorldFacts, item: string, count = 1): boolean {
  return inventoryCount(facts, item) >= count;
}

export function hasAny(facts: WorldFacts, items: readonly string[]): boolean {
  return items.some((item) => inventoryCount(facts, item) > 0);
}

export function countAny(facts: WorldFacts, items: readonly string[]): number {
  return items.reduce((total, item) => total + inventoryCount(facts, item), 0);
}

export function nearbyHas(facts: WorldFacts, pattern: RegExp): NearbyBlock | null {
  return (facts.nearbyBlocks ?? []).find((block) => pattern.test(block.id)) ?? null;
}

export function nearestEntity(
  facts: WorldFacts,
  pattern: RegExp,
  maxDistance = Number.POSITIVE_INFINITY,
): NearbyEntity | null {
  const matches = (facts.entities ?? [])
    .filter((entity) => pattern.test(entity.type) && entity.distance <= maxDistance)
    .sort((left, right) => left.distance - right.distance);
  return matches[0] ?? null;
}

export function dimensionOf(world: string | null | undefined): string {
  if (world === null || world === undefined) return "unverified";
  const lower = world.toLowerCase();
  if (lower.includes("the_nether") || lower.includes("nether")) return "nether";
  if (lower.includes("the_end") || lower.includes("the_end")) return "end";
  return "overworld";
}

export function isNight(facts: WorldFacts): boolean | null {
  const time = facts.timeOfDay;
  if (time === null || time === undefined) return null;
  return time >= 12_500 && time < 23_500;
}

export function isDay(facts: WorldFacts): boolean | null {
  const night = isNight(facts);
  return night === null ? null : !night;
}

export function isHungry(facts: WorldFacts): boolean {
  return facts.food !== undefined && facts.food !== null && facts.food < 18;
}

export function isLowHealth(facts: WorldFacts): boolean {
  return facts.health !== undefined && facts.health !== null && facts.health < 8;
}

export function hasHostileNearby(facts: WorldFacts, radius = 8): boolean {
  const hostile =
    /zombie|husk|drowned|skeleton|stray|creeper|spider|witch|pillager|vindicator|evoker|enderman|slime|magma_cube|blaze|ghast|wither|piglin|hoglin|phantom/iu;
  return (facts.entities ?? []).some(
    (entity) => entity.distance <= radius && hostile.test(entity.type),
  );
}

function normalizeInventory(
  inventory: SnapshotView["inventory"],
  hotbar: SnapshotView["hotbar"],
): readonly InventorySlot[] {
  if (inventory !== undefined && inventory.length > 0) {
    const merged = new Map<string, InventorySlot>();
    for (const slot of inventory) {
      if (slot.count <= 0) continue;
      const item = normalizeItem(slot.item);
      const section = slot.section ?? "main";
      const key = `${section}:${slot.slot ?? "-"}:${item}`;
      const existing = merged.get(key);
      merged.set(
        key,
        existing === undefined
          ? {
              item,
              count: slot.count,
              section,
              ...(slot.slot === undefined ? {} : { slot: slot.slot }),
            }
          : { ...existing, count: existing.count + slot.count },
      );
    }
    return sortInventory([...merged.values()]);
  }
  if (hotbar === undefined) return [];
  return sortInventory(
    hotbar
      .filter((slot) => slot.count > 0)
      .map((slot) => ({ item: normalizeItem(slot.item), count: slot.count, section: "hotbar" as const, slot: slot.slot })),
  );
}

function sortInventory(slots: readonly InventorySlot[]): readonly InventorySlot[] {
  return [...slots].sort(
    (left, right) =>
      (left.section ?? "main").localeCompare(right.section ?? "main") ||
      (left.slot ?? 0) - (right.slot ?? 0) ||
      left.item.localeCompare(right.item),
  );
}

function normalizeBlocks(blocks: SnapshotView["nearbyBlocks"]): readonly NearbyBlock[] {
  return (blocks ?? []).map((block) => ({
    id: normalizeItem(block.id),
    ...(block.count === undefined ? {} : { count: block.count }),
  }));
}

function normalizeEntities(entities: SnapshotView["entities"]): readonly NearbyEntity[] {
  return (entities ?? []).map((entity) => ({
    name: entity.name,
    type: normalizeEntityType(entity.type),
    distance: entity.distance,
  }));
}

function normalizeEntityType(type: string): string {
  return normalizeItem(type);
}

function inferStations(
  blocks: readonly NearbyBlock[],
): Array<"crafting_table" | "furnace" | "blast_furnace" | "bed" | "portal"> {
  const stations = new Set<"crafting_table" | "furnace" | "blast_furnace" | "bed" | "portal">();
  for (const block of blocks) {
    if (block.id === "minecraft:crafting_table") stations.add("crafting_table");
    if (block.id === "minecraft:furnace") stations.add("furnace");
    if (block.id === "minecraft:blast_furnace") stations.add("blast_furnace");
    if (/_bed$/u.test(block.id)) stations.add("bed");
    // Obsidian is a material; only a real portal block proves a usable portal.
    if (block.id === "minecraft:nether_portal") stations.add("portal");
  }
  return [...stations];
}

/**
 * Copies only reported values. `undefined` means the body did not observe the
 * field; collapsing it to a default would let the planner claim verification.
 */
function withOptionals(
  base: WorldFacts,
  optional: {
    readonly world?: string | null | undefined;
    readonly position?: WorldFacts["position"] | undefined;
    readonly health?: number | null | undefined;
    readonly food?: number | null | undefined;
    readonly timeOfDay?: number | null | undefined;
    readonly day?: number | null | undefined;
    readonly sleeping?: boolean | null | undefined;
    readonly screenOpen?: boolean | null | undefined;
    readonly onGround?: boolean | null | undefined;
    readonly selectedItem?: string | null | undefined;
  },
): WorldFacts {
  return {
    ...base,
    ...(optional.world === undefined ? {} : { world: optional.world }),
    ...(optional.position === undefined ? {} : { position: optional.position }),
    ...(optional.health === undefined ? {} : { health: optional.health }),
    ...(optional.food === undefined ? {} : { food: optional.food }),
    ...(optional.timeOfDay === undefined ? {} : { timeOfDay: optional.timeOfDay }),
    ...(optional.day === undefined ? {} : { day: optional.day }),
    ...(optional.sleeping === undefined ? {} : { sleeping: optional.sleeping }),
    ...(optional.screenOpen === undefined ? {} : { screenOpen: optional.screenOpen }),
    ...(optional.onGround === undefined ? {} : { onGround: optional.onGround }),
    ...(optional.selectedItem === undefined ? {} : { selectedItem: optional.selectedItem }),
  };
}
