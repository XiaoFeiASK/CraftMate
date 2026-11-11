/**
 * Prompt-side compression. These helpers only trim what the model sees; they
 * never rewrite the durable evidence or the planner's own world facts.
 */

export interface CompactIncident {
  readonly kind: string;
  readonly detail: string;
  readonly at: number;
}

export function compactIncidents(
  incidents: readonly CompactIncident[],
  limit = 4,
  maxDetailChars = 180,
): readonly CompactIncident[] {
  return incidents.slice(-Math.max(0, limit)).map((incident) => ({
    kind: incident.kind.slice(0, 40),
    detail: incident.detail.slice(0, Math.max(1, maxDetailChars)),
    at: incident.at,
  }));
}

/**
 * Keep every scalar fact but bound the two arrays that grow with a full
 * backpack. The planner still receives the complete durable snapshot; this is
 * only the copy placed in a model prompt.
 */
export function compactWorld(world: unknown, maxInventory = 24): unknown {
  if (world === null || typeof world !== "object" || Array.isArray(world)) return world;
  const record = { ...(world as Record<string, unknown>) };
  if (Array.isArray(record["inventory"])) {
    record["inventory"] = record["inventory"].slice(0, Math.max(0, maxInventory));
  }
  if (Array.isArray(record["hotbar"])) {
    record["hotbar"] = record["hotbar"].slice(0, 9);
  }
  return record;
}

export function compactMemories(
  memories: readonly string[],
  limit = 8,
  maxChars = 320,
): readonly string[] {
  return memories
    .slice(0, Math.max(0, limit))
    .map((memory) => memory.slice(0, Math.max(1, maxChars)));
}
