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
  readonly yaw?: number | null;
  readonly cameraYaw?: number | null;
  readonly health?: number | null;
  readonly food?: number | null;
  readonly foodAcquired?: boolean | null;
  readonly foodConsumed?: boolean | null;
  readonly craftingTableCrafted?: boolean | null;
  readonly craftingTablePlaced?: boolean | null;
  readonly chestCrafted?: boolean | null;
  readonly chestPlaced?: boolean | null;
  readonly bedPlaced?: boolean | null;
  readonly chest?: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly bed?: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly furnace?: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly furnacePlaced?: boolean | null;
  readonly craftingTableNearby?: boolean | null;
  readonly craftingTableReachable?: boolean | null;
  readonly craftingTable?: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly timeOfDay?: number | null;
  readonly day?: number | null;
  readonly sleeping?: boolean | null;
  readonly sleptThroughNight?: boolean | null;
  readonly screenOpen?: boolean | null;
  readonly onGround?: boolean | null;
  readonly surfaceY?: number | null;
  readonly canSeeSky?: boolean | null;
  readonly lightLevel?: number | null;
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
    readonly x?: number;
    readonly y?: number;
    readonly z?: number;
    readonly distance?: number;
    readonly bearing?: number;
    readonly visible?: boolean;
  }[];
  readonly reachableBlock?: {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly z: number;
  } | null;
  readonly entities?: readonly {
    readonly name: string;
    readonly type: string;
    readonly distance: number;
    readonly x?: number;
    readonly y?: number;
    readonly z?: number;
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
  const stations = inferStations(nearbyBlocks).filter(
    (station) =>
      station !== "crafting_table" || snapshot.craftingTableReachable !== false,
  );
  const reachableBlock =
    snapshot.reachableBlock === undefined || snapshot.reachableBlock === null
      ? snapshot.reachableBlock
      : {
          id: normalizeItem(snapshot.reachableBlock.id),
          x: snapshot.reachableBlock.x,
          y: snapshot.reachableBlock.y,
          z: snapshot.reachableBlock.z,
        };
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
    yaw: snapshot.yaw,
    cameraYaw: snapshot.cameraYaw,
    health: snapshot.health,
    food: snapshot.food,
    foodAcquired: snapshot.foodAcquired,
    foodConsumed: snapshot.foodConsumed,
    craftingTableCrafted: snapshot.craftingTableCrafted,
    craftingTablePlaced: snapshot.craftingTablePlaced,
    chestCrafted: snapshot.chestCrafted,
    chestPlaced: snapshot.chestPlaced,
    bedPlaced: snapshot.bedPlaced,
    chest: snapshot.chest,
    bed: snapshot.bed,
    furnace: snapshot.furnace,
    furnacePlaced: snapshot.furnacePlaced,
    craftingTableNearby: snapshot.craftingTableNearby,
    craftingTableReachable: snapshot.craftingTableReachable,
    craftingTable: snapshot.craftingTable,
    timeOfDay: snapshot.timeOfDay,
    day: snapshot.day,
    sleeping: snapshot.sleeping,
    sleptThroughNight: snapshot.sleptThroughNight,
    screenOpen: snapshot.screenOpen,
    onGround: snapshot.onGround,
    surfaceY: snapshot.surfaceY,
    canSeeSky: snapshot.canSeeSky,
    lightLevel: snapshot.lightLevel,
    selectedItem: snapshot.selectedItem,
    reachableBlock,
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

/**
 * Items whose vanilla recipe needs a 3x3 grid. Their presence in this body's
 * inventory is durable evidence that a crafting table existed, even after a
 * reconnect clears session facts or the body walks out of observation range.
 * Only self-made tools are used: chests, furnaces and beds also occur in
 * generated structures and would not prove that this body crafted a table.
 */
export function hasCraftingTableProduct(facts: WorldFacts): boolean {
  const craftedTool =
    /(^|:)(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|axe|sword|shovel)$/u;
  return facts.inventory.some((slot) => craftedTool.test(slot.item));
}

/**
 * Pickaxe tiers that satisfy "can mine stone". The earlier milestone required
 * a wooden pickaxe specifically, so a body that already carried a stone or
 * iron pickaxe could never complete it and the planner kept asking for a
 * downgrade it could not craft.
 */
export function hasStoneCapablePickaxe(facts: WorldFacts): boolean {
  return facts.inventory.some((slot) =>
    /(^|:)(wooden|stone|iron|golden|diamond|netherite)_pickaxe$/u.test(slot.item) &&
    slot.durability !== 0,
  );
}

/** Best pickaxe tier present, used to skip pointless lower-tier crafts. */
export function pickaxeTier(facts: WorldFacts): number {
  const ranks: Record<string, number> = {
    wooden: 1,
    golden: 1,
    stone: 2,
    iron: 3,
    diamond: 4,
    netherite: 5,
  };
  let best = 0;
  for (const slot of facts.inventory) {
    if (slot.durability === 0) continue;
    const match = /^minecraft:([a-z]+)_pickaxe$/u.exec(slot.item);
    if (match === null) continue;
    best = Math.max(best, ranks[match[1] ?? ""] ?? 0);
  }
  return best;
}

/**
 * Remaining pickaxe uses reported by the body, or null when the body does not
 * report durability. Treating "unknown" as zero would strand older bodies.
 */
export function pickaxeUses(
  facts: WorldFacts,
  minimumTier = 1,
): number | null {
  const ranks: Record<string, number> = {
    wooden: 1,
    golden: 1,
    stone: 2,
    iron: 3,
    diamond: 4,
    netherite: 5,
  };
  const pickaxes = facts.inventory.filter((slot) => {
    const match = /^minecraft:([a-z]+)_pickaxe$/u.exec(slot.item);
    return match !== null && (ranks[match[1] ?? ""] ?? 0) >= minimumTier;
  });
  if (!pickaxes.some((slot) => slot.durability !== undefined)) return null;
  return pickaxes.reduce(
    (total, slot) => total + Math.max(0, slot.durability ?? 0),
    0,
  );
}

/** A pickaxe with enough remaining uses to start a real mining action. */
export function hasUsablePickaxe(
  facts: WorldFacts,
  minimumTier = 1,
  minimumUses = 1,
): boolean {
  const ranks: Record<string, number> = {
    wooden: 1,
    golden: 1,
    stone: 2,
    iron: 3,
    diamond: 4,
    netherite: 5,
  };
  return facts.inventory.some((slot) => {
    if (slot.durability !== undefined && slot.durability < minimumUses) return false;
    const match = /^minecraft:([a-z]+)_pickaxe$/u.exec(slot.item);
    return match === null ? false : (ranks[match[1] ?? ""] ?? 0) >= minimumTier;
  });
}

/**
 * "Underground" is an observation, not a guess. `canSeeSky` is authoritative
 * when reported; otherwise use the depth below the current column's surface.
 */
export function isUnderground(facts: WorldFacts): boolean {
  if (facts.canSeeSky === true) return false;
  if (facts.canSeeSky === false) return true;
  const y = facts.position?.y;
  const surface = facts.surfaceY;
  return y !== undefined && y !== null && surface !== undefined && surface !== null
    ? y < surface - 4
    : false;
}

/** Blocks below the local surface, or null when height is not observed. */
export function depthBelowSurface(facts: WorldFacts): number | null {
  const y = facts.position?.y;
  const surface = facts.surfaceY;
  return y === undefined || y === null || surface === undefined || surface === null
    ? null
    : Math.max(0, surface - y);
}

export function countAny(facts: WorldFacts, items: readonly string[]): number {
  return items.reduce((total, item) => total + inventoryCount(facts, item), 0);
}

export function nearbyHas(facts: WorldFacts, pattern: RegExp): NearbyBlock | null {
  const matches = (facts.nearbyBlocks ?? []).filter((block) => pattern.test(block.id));
  // Count-only summaries are deliberately prepended by the body so the most
  // common blocks survive the wire cap. They carry no position, which made
  // `nearbyHas` return a log without coordinates even when the same snapshot
  // contained a line-of-sight target. Prefer the nearest located observation.
  return matches
    .filter((block) => block.visible === true && block.distance !== undefined)
    .sort((left, right) => left.distance! - right.distance!)[0]
    ?? matches[0]
    ?? null;
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

/**
 * A land mob can be inside the planar hunt window while standing on the
 * surface directly above a cave. The body's bounded walker cannot climb that
 * cliff, so issuing an attack only produces "no reachable route" and hides a
 * real nearby opportunity (wood, food drops) behind a retry loop. Missing
 * coordinates keep the old behavior because an older body may not report
 * them.
 */
export function nearestEntityWithinHeight(
  facts: WorldFacts,
  pattern: RegExp,
  maxDistance = Number.POSITIVE_INFINITY,
  maxVertical = 12,
): NearbyEntity | null {
  const origin = facts.position;
  return (
    (facts.entities ?? [])
      .filter(
        (entity) =>
          pattern.test(entity.type) &&
          entity.distance <= maxDistance &&
          (origin === undefined ||
            origin === null ||
            entity.y === undefined ||
            Math.abs(entity.y - origin.y) <= maxVertical),
      )
      .sort((left, right) => left.distance - right.distance)[0] ?? null
  );
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
              ...(slot.durability === undefined ? {} : { durability: slot.durability }),
              ...(slot.maxDurability === undefined ? {} : { maxDurability: slot.maxDurability }),
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
    ...(block.x === undefined ? {} : { x: block.x }),
    ...(block.y === undefined ? {} : { y: block.y }),
    ...(block.z === undefined ? {} : { z: block.z }),
    ...(block.distance === undefined ? {} : { distance: block.distance }),
    ...(block.bearing === undefined ? {} : { bearing: block.bearing }),
    ...(block.visible === undefined ? {} : { visible: block.visible }),
  }));
}

function normalizeEntities(entities: SnapshotView["entities"]): readonly NearbyEntity[] {
  return (entities ?? []).map((entity) => ({
    name: entity.name,
    type: normalizeEntityType(entity.type),
    distance: entity.distance,
    ...(entity.x === undefined ? {} : { x: entity.x }),
    ...(entity.y === undefined ? {} : { y: entity.y }),
    ...(entity.z === undefined ? {} : { z: entity.z }),
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
    readonly yaw?: number | null | undefined;
    readonly cameraYaw?: number | null | undefined;
    readonly health?: number | null | undefined;
    readonly food?: number | null | undefined;
    readonly foodAcquired?: boolean | null | undefined;
    readonly foodConsumed?: boolean | null | undefined;
    readonly craftingTableCrafted?: boolean | null | undefined;
    readonly craftingTablePlaced?: boolean | null | undefined;
    readonly chestCrafted?: boolean | null | undefined;
    readonly chestPlaced?: boolean | null | undefined;
    readonly bedPlaced?: boolean | null | undefined;
    readonly chest?: { readonly x: number; readonly y: number; readonly z: number } | null | undefined;
    readonly bed?: { readonly x: number; readonly y: number; readonly z: number } | null | undefined;
    readonly furnace?: { readonly x: number; readonly y: number; readonly z: number } | null | undefined;
    readonly furnacePlaced?: boolean | null | undefined;
    readonly craftingTableNearby?: boolean | null | undefined;
    readonly craftingTableReachable?: boolean | null | undefined;
    readonly craftingTable?: { readonly x: number; readonly y: number; readonly z: number } | null | undefined;
    readonly timeOfDay?: number | null | undefined;
    readonly day?: number | null | undefined;
    readonly sleeping?: boolean | null | undefined;
    readonly sleptThroughNight?: boolean | null | undefined;
    readonly screenOpen?: boolean | null | undefined;
    readonly onGround?: boolean | null | undefined;
    readonly surfaceY?: number | null | undefined;
    readonly canSeeSky?: boolean | null | undefined;
    readonly lightLevel?: number | null | undefined;
    readonly selectedItem?: string | null | undefined;
    readonly reachableBlock?: WorldFacts["reachableBlock"] | undefined;
  },
): WorldFacts {
  return {
    ...base,
    ...(optional.world === undefined ? {} : { world: optional.world }),
    ...(optional.position === undefined ? {} : { position: optional.position }),
    ...(optional.yaw === undefined ? {} : { yaw: optional.yaw }),
    ...(optional.cameraYaw === undefined ? {} : { cameraYaw: optional.cameraYaw }),
    ...(optional.health === undefined ? {} : { health: optional.health }),
    ...(optional.food === undefined ? {} : { food: optional.food }),
    ...(optional.foodAcquired === undefined ? {} : { foodAcquired: optional.foodAcquired }),
    ...(optional.foodConsumed === undefined ? {} : { foodConsumed: optional.foodConsumed }),
    ...(optional.craftingTableCrafted === undefined ? {} : { craftingTableCrafted: optional.craftingTableCrafted }),
    ...(optional.craftingTablePlaced === undefined ? {} : { craftingTablePlaced: optional.craftingTablePlaced }),
    ...(optional.chestCrafted === undefined ? {} : { chestCrafted: optional.chestCrafted }),
    ...(optional.chestPlaced === undefined ? {} : { chestPlaced: optional.chestPlaced }),
    ...(optional.bedPlaced === undefined ? {} : { bedPlaced: optional.bedPlaced }),
    ...(optional.chest === undefined ? {} : { chest: optional.chest }),
    ...(optional.bed === undefined ? {} : { bed: optional.bed }),
    ...(optional.furnace === undefined ? {} : { furnace: optional.furnace }),
    ...(optional.furnacePlaced === undefined ? {} : { furnacePlaced: optional.furnacePlaced }),
    ...(optional.craftingTableNearby === undefined ? {} : { craftingTableNearby: optional.craftingTableNearby }),
    ...(optional.craftingTableReachable === undefined ? {} : { craftingTableReachable: optional.craftingTableReachable }),
    ...(optional.craftingTable === undefined ? {} : { craftingTable: optional.craftingTable }),
    ...(optional.timeOfDay === undefined ? {} : { timeOfDay: optional.timeOfDay }),
    ...(optional.day === undefined ? {} : { day: optional.day }),
    ...(optional.sleeping === undefined ? {} : { sleeping: optional.sleeping }),
    ...(optional.sleptThroughNight === undefined ? {} : { sleptThroughNight: optional.sleptThroughNight }),
    ...(optional.screenOpen === undefined ? {} : { screenOpen: optional.screenOpen }),
    ...(optional.onGround === undefined ? {} : { onGround: optional.onGround }),
    ...(optional.surfaceY === undefined ? {} : { surfaceY: optional.surfaceY }),
    ...(optional.canSeeSky === undefined ? {} : { canSeeSky: optional.canSeeSky }),
    ...(optional.lightLevel === undefined ? {} : { lightLevel: optional.lightLevel }),
    ...(optional.selectedItem === undefined ? {} : { selectedItem: optional.selectedItem }),
    ...(optional.reachableBlock === undefined ? {} : { reachableBlock: optional.reachableBlock }),
  };
}
