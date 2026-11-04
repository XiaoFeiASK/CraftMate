import type {
  BridgeHealth,
  ShowMode,
  SkillCall,
  WorldSnapshot,
} from "@craftmate/contracts";

export const AUTONOMY_COOLDOWN_MS = 1_200;
/** Back off after a failed action so one blocked tree cannot spam the chat. */
export const AUTONOMY_FAILURE_COOLDOWN_MS = 6_000;
/** Do not start a new walk while a hostile is this close. */
export const AUTONOMY_HOSTILE_RADIUS = 8;

export interface AutonomyState {
  readonly now: number;
  readonly mode: ShowMode;
  readonly bridge: BridgeHealth | null;
  /** Operator switch. Absent means off: no idle action without explicit opt-in. */
  readonly enabled?: boolean;
  /** Last autonomous action attempt, measured on the same clock as `now`. */
  readonly lastAttemptAt: number;
  /** Number of consecutive failed steps of any kind, used for backoff. */
  readonly consecutiveFailures?: number;
  /**
   * A failed chop pauses mining for a few seconds instead of selecting the
   * same obstructed tree every cooldown. There is no walking fallback.
   */
  readonly miningBlockedUntil?: number;
}

export interface AutonomousAction {
  readonly intent: "mine";
  readonly text: string;
  readonly reason: string;
  readonly skill: SkillCall;
}

/**
 * Idle behaviour is opt-in and evidence-based. The previous policy sent a
 * `goto` four blocks along the current heading whenever it could not find a
 * tree; on real terrain those arbitrary points are often unreachable, so the
 * only visible result was a failed command every few seconds. This policy
 * never invents a destination: without a nearby log it stays still and waits
 * for the audience, the operator, or a later observation.
 */
export function nextAutonomousAction(state: AutonomyState): AutonomousAction | null {
  if (state.enabled !== true) return null;
  if (state.mode !== "agent") return null;
  const bridge = state.bridge;
  if (
    bridge === null ||
    !bridge.connected ||
    bridge.owner !== "agent" ||
    bridge.permission !== "agent"
  ) {
    return null;
  }
  const world = bridge.world;
  if (world === null || !world.inWorld) return null;
  if (world.health !== null && world.health !== undefined && world.health <= 0) return null;
  // A dead or nearly dead body must survive before exploring. Without this,
  // respawn recovery restarts the same walk straight back into the mob that
  // killed it, producing a death loop that also traps the player's screen.
  if (world.health !== null && world.health !== undefined && world.health < 10) return null;
  // The player's pause menu, inventory or chat belongs to the player. A
  // command would either fight that screen or silently close it.
  if (world.screenOpen === true) return null;
  if (hasNearbyHostile(world)) return null;
  if (bridge.queued > 0 || bridge.running > 0) return null;
  const failures = state.consecutiveFailures ?? 0;
  const cooldown = Math.min(
    AUTONOMY_COOLDOWN_MS * 2 ** Math.min(failures, 4),
    AUTONOMY_FAILURE_COOLDOWN_MS,
  );
  if (state.now - state.lastAttemptAt < cooldown) return null;

  const skills = new Set(bridge.skills);
  const log = nearbyLog(world);
  const miningAllowed = state.now >= (state.miningBlockedUntil ?? 0);
  if (miningAllowed && skills.has("chop_tree") && log !== null) {
    return {
      intent: "mine",
      text: "自主砍一根原木",
      reason: "自主循环：附近有原木",
      skill: {
        name: "chop_tree",
        args: { count: 1 },
        idempotencyKey: crypto.randomUUID(),
      },
    };
  }
  return null;
}

/**
 * Ordinary play must not keep walking into a fight it cannot win. The body
 * already reports passive and hostile entities; only the known hostile types
 * count, so a villager or an item on the ground never blocks exploration.
 */
function hasNearbyHostile(world: WorldSnapshot): boolean {
  return (world.entities ?? []).some((entity) => {
    if (entity.distance > AUTONOMY_HOSTILE_RADIUS) return false;
    const type = entity.type.toLowerCase();
    return (
      type.includes("zombie") ||
      type.includes("husk") ||
      type.includes("drowned") ||
      type.includes("skeleton") ||
      type.includes("creeper") ||
      type.includes("spider") ||
      type.includes("witch") ||
      type.includes("pillager") ||
      type.includes("enderman") ||
      type.includes("slime") ||
      type.includes("magma_cube") ||
      type.includes("blaze") ||
      type.includes("ghast") ||
      type.includes("wither")
    );
  });
}

function nearbyLog(world: WorldSnapshot): string | null {
  const block = (world.nearbyBlocks ?? []).find((entry) =>
    /(^|:)[a-z_]+_(log|wood|stem|hyphae)$/u.test(entry.id),
  );
  return block?.id ?? null;
}
