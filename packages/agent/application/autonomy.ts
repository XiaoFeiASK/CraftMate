import type {
  BridgeHealth,
  ShowMode,
  SkillCall,
  WorldSnapshot,
} from "@craftmate/contracts";

export const AUTONOMY_COOLDOWN_MS = 1_200;
export const AUTONOMY_STEP_BLOCKS = 4;
/** Turn only after a blocked/failed route, never as a fixed four-point loop. */
export const AUTONOMY_TURN_DEGREES = 45;
/** A repeated unreachable route turns farther so the body can leave a dead end. */
export const AUTONOMY_STUCK_TURN_DEGREES = 90;
/** Stay near the spawn while exploring, so a mistake cannot strand the body. */
export const AUTONOMY_MAX_RADIUS = 12;

export interface AutonomyState {
  readonly now: number;
  readonly mode: ShowMode;
  readonly bridge: BridgeHealth | null;
  /** Last autonomous action attempt, measured on the same clock as `now`. */
  readonly lastAttemptAt: number;
  /** Rotates the short exploration heading so a blocked path is not retried forever. */
  readonly sequence: number;
  /** Fixed exploration centre captured when autonomous play begins. */
  readonly origin: { readonly x: number; readonly z: number } | null;
  /** World spawn is a more stable centre than the first observed position. */
  readonly spawn?: { readonly x: number; readonly z: number } | null;
  /**
   * Navigation heading in degrees. Kept outside the world snapshot so a
   * display camera looking at a tree cannot silently change where the body
   * explores next.
   */
  readonly heading?: number | null;
  /**
   * A failed chop or dig pauses mining for a few seconds. The body then takes
   * a walk instead of selecting the same obstructed tree every cooldown.
   */
  readonly miningBlockedUntil?: number;
  /** Number of consecutive failed routes at the current heading. */
  readonly routeFailures?: number;
}

export interface AutonomousAction {
  readonly intent: "mine" | "move";
  readonly text: string;
  readonly reason: string;
  readonly skill: SkillCall;
}

/**
 * The smallest useful autonomy policy: do one bounded action at a time, then
 * let the bridge report completion before choosing again. This is deliberately
 * deterministic and cheap; open-ended goals still belong to the planner.
 */
export function nextAutonomousAction(state: AutonomyState): AutonomousAction | null {
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
  if (bridge.queued > 0 || bridge.running > 0) return null;
  if (state.now - state.lastAttemptAt < AUTONOMY_COOLDOWN_MS) return null;

  const skills = new Set(bridge.skills);
  const log = nearbyLog(world);
  const miningAllowed = state.now >= (state.miningBlockedUntil ?? 0);
  if (miningAllowed && skills.has("chop_tree") && log !== null) {
    return {
      intent: "mine",
      text: `自主砍${log}`,
      reason: "自主循环：附近有原木",
      skill: {
        name: "chop_tree",
        args: { count: 1 },
        idempotencyKey: crypto.randomUUID(),
      },
    };
  }

  const position = world.position;
  if (skills.has("goto") && position !== null && position !== undefined) {
    const centre = state.spawn ?? state.origin;
    const failures = state.routeFailures ?? 0;
    const turn = failures >= 2 ? AUTONOMY_STUCK_TURN_DEGREES : AUTONOMY_TURN_DEGREES;
    const heading = state.heading ?? world.yaw ?? 0;
    // A caller that owns a persistent heading applies its own turn after a
    // failed route; multiplying by `sequence` would turn several times.
    const turns = state.heading === undefined || state.heading === null ? state.sequence : 0;
    const yaw = (heading + turns * turn) * (Math.PI / 180);
    const target = {
      x: position.x - Math.sin(yaw) * AUTONOMY_STEP_BLOCKS,
      y: position.y,
      z: position.z + Math.cos(yaw) * AUTONOMY_STEP_BLOCKS,
    };
    if (
      centre !== null &&
      centre !== undefined &&
      Math.hypot(target.x - centre.x, target.z - centre.z) >
        AUTONOMY_MAX_RADIUS
    ) {
      const distance = Math.hypot(position.x - centre.x, position.z - centre.z);
      const inward = distance <= AUTONOMY_STEP_BLOCKS
        ? 0
        : (distance - AUTONOMY_STEP_BLOCKS) / distance;
      return {
        intent: "move",
        text: "自主返回活动中心",
        reason: "自主循环：已接近探索边界，先朝活动中心走几步",
        skill: {
          name: "goto",
          args: {
            target: {
              x: centre.x + (position.x - centre.x) * inward,
              y: position.y,
              z: centre.z + (position.z - centre.z) * inward,
            },
          },
          idempotencyKey: crypto.randomUUID(),
        },
      };
    }
    return {
      intent: "move",
      text: "自主沿当前方向探索",
      reason:
        state.sequence === 0
          ? "自主循环：附近没有可砍的树，沿当前朝向前进"
          : "自主循环：上一次路线不可走，转向后继续探索",
      skill: {
        name: "goto",
        args: {
          target,
        },
        idempotencyKey: crypto.randomUUID(),
      },
    };
  }
  return null;
}

function nearbyLog(world: WorldSnapshot): string | null {
  const block = (world.nearbyBlocks ?? []).find((entry) =>
    /(^|:)[a-z_]+_(log|wood|stem|hyphae)$/u.test(entry.id),
  );
  return block?.id ?? null;
}
