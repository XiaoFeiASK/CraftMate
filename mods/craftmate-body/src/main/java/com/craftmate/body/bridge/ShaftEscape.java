package com.craftmate.body.bridge;

/**
 * A body that dug a one-block shaft cannot leave it with horizontal A*
 * because every neighbour is a solid wall. The escape plan is deliberately
 * small: open exactly one wall cell and step into it. It never mines the
 * floor, so the body cannot deepen the hole it is trying to leave.
 */
final class ShaftEscape {
	private static final double EXPLORE_ARRIVAL_HEIGHT = 1.25;
	private static final double EXACT_ARRIVAL_HEIGHT = 0.75;

	private ShaftEscape() {
	}

	/**
	 * Pillaring is an enclosed-pocket recovery, not a way to climb open sky.
	 * A real solid ceiling or a one-cell shaft with four solid walls is the
	 * only legal site. Tree canopy and a three-walled cliff edge are open
	 * terrain: the old `!canSeeSky` fallback treated both as underground and
	 * produced the live sky pillar.
	 */
	static boolean shouldStartPillar(boolean ceilingSolid, int horizontalWalls) {
		return ceilingSolid || horizontalWalls >= 4;
	}

	/**
	 * Leaves and logs block movement but are not shelter. Treating a canopy
	 * as a roof turned a surface tree into an "enclosed" state and allowed
	 * the body to pillar into open sky.
	 */
	static boolean isStructuralBarrier(
		boolean blocksMotion,
		boolean leaves,
		boolean logs
	) {
		return blocksMotion && !leaves && !logs;
	}

	/** A recovery pillar is a bounded escape, not an unlimited tower. */
	static final int MAX_RECOVERY_PILLAR_STEPS = 12;

	/**
	 * A ledge that just failed is not a new idea on the next planner tick.
	 * The same take-off and landing cells are attempted at most once inside
	 * this window; the agent records the durable blacklist separately.
	 */
	static final int LEDGE_REPEAT_WINDOW_TICKS = 20 * 600;

	static boolean ledgeAttemptExhausted(int priorAttempts, int ticksSinceAttempt) {
		return (
			priorAttempts >= 1
				&& ticksSinceAttempt >= 0
				&& ticksSinceAttempt < LEDGE_REPEAT_WINDOW_TICKS
		);
	}

	/** Two consecutive tunnels in one direction are enough evidence. */
	static final int MAX_TUNNEL_DIRECTION_FAILURES = 2;

	static boolean tunnelDirectionExhausted(int consecutiveFailures) {
		return consecutiveFailures >= MAX_TUNNEL_DIRECTION_FAILURES;
	}

	static boolean withinRecoveryPillarBudget(int steps) {
		return steps >= 0 && steps < MAX_RECOVERY_PILLAR_STEPS;
	}

	/**
	 * Never build a pillar the body cannot undo. Above open sky, stacking
	 * always leads somewhere. Underground that is not true: without a tool
	 * for the material underfoot the body can get stuck on one block with a
	 * stone roof and no way to retreat.
	 */
	static boolean canRecoverFromPillar(boolean skyAbove, boolean canBreakBuildingBlock) {
		return skyAbove || canBreakBuildingBlock;
	}

	/**
	 * Mining a ceiling block can open the floor beneath the body and drop it
	 * into a lower pocket mid-pillar. The jump target must follow the new feet
	 * level; otherwise every jump is measured from a stale base and the body
	 * keeps leaping at a block it can no longer reach.
	 */
	static boolean shouldRebasePillar(boolean grounded, int feetY, int baseY) {
		return grounded && feetY < baseY;
	}

	/** Stop climbing once the requested floor has been reached. */
	static boolean pillarReachedTarget(int feetY, int baseY, double targetY) {
		return feetY > baseY && targetY <= feetY + 0.5;
	}

	/**
	 * A two-block-thick ceiling must be opened from the bottom up. The upper
	 * cell has no exposed face until the lower one is air, so targeting it
	 * first produces a hit result on the lower block and a destroy packet on
	 * a hidden block that vanilla silently rejects.
	 */
	static int firstCeilingOffset(boolean solidAtHeadPlusTwo, boolean solidAtHeadPlusThree) {
		if (solidAtHeadPlusTwo) return 2;
		if (solidAtHeadPlusThree) return 3;
		return -1;
	}

	/**
	 * A retreat reveals the next block of the body's own pillar. Keep peeling
	 * the same column instead of stopping one block down and re-planning a
	 * route that still does not exist.
	 */
	static boolean continuesPillarRetreat(
		boolean grounded,
		boolean sameColumn,
		int brokenY,
		int supportY,
		boolean supportWasPlaced
	) {
		return grounded
			&& sameColumn
			&& supportWasPlaced
			&& supportY == brokenY - 1;
	}

	/**
	 * @param horizontalWalls number of solid horizontal neighbours
	 * @param hasPickaxe true when a carried tool can harvest the wall
	 */
	static boolean shouldDigOut(int horizontalWalls, boolean hasPickaxe) {
		return horizontalWalls >= 3 && hasPickaxe;
	}

	/**
	 * A same-level or downhill goto cannot be solved by building upward.
	 * When the safe walker has no route, a human clears a two-block tunnel
	 * toward the target instead. The body must be grounded and close enough
	 * in height for a horizontal corridor to make sense.
	 */
	static boolean shouldTunnel(
		boolean grounded,
		double targetDeltaY,
		double horizontalDistance
	) {
		// A horizontal corridor cannot descend forty blocks. The old
		// `targetDeltaY <= 2.5` accepted every target below the body, so a
		// remembered table one mineshaft lower made the body oscillate between
		// two cells until the tunnel budget expired. Tunnelling is only an
		// alternative to walking on roughly the same floor; deeper targets need
		// the planner to issue a staircase/descend task instead.
		return (
			grounded
				&& targetDeltaY >= -2.5
				&& targetDeltaY <= 2.5
				&& horizontalDistance >= 3.0
		);
	}

	/**
	 * When the requested target is above the body, a horizontal detour is not
	 * escape progress. The live body repeatedly mined three stair steps, then
	 * found a short route back to its old cave floor and followed it, only to
	 * start the same climb again. A partial route is useful for a vertical
	 * target only when its destination is actually higher than the body.
	 */
	static boolean routeAdvancesTowardTarget(
		boolean complete,
		double destinationY,
		double playerY,
		double targetY
	) {
		if (complete) return true;
		if (targetY - playerY <= 2.5) return true;
		return destinationY >= playerY + 1.0;
	}

	/**
	 * Exploration targets name a column and tolerate a neighbouring slope.
	 * An exact station target does not: accepting a body one full block below
	 * the requested floor made a chest trip "complete" without moving, and
	 * the runtime reissued the same goto every few hundred milliseconds.
	 */
	static double arrivalHeight(boolean acceptPartial) {
		return acceptPartial ? EXPLORE_ARRIVAL_HEIGHT : EXACT_ARRIVAL_HEIGHT;
	}

	/**
	 * Chooses a wall cell only when it is solid and its centre is on the
	 * crosshair. An obstructed or already-open cell is not an escape.
	 */
	static boolean canBreakWall(boolean solid, boolean centreVisible) {
		return solid && centreVisible;
	}

	/**
	 * Escape paths may find a correct tool in the main inventory, but mining
	 * only uses the hotbar. A respawn that reorders the inventory used to make
	 * every tunnel cell look unbreakable: the cell check scanned all slots, the
	 * mining step only scanned the hotbar, and the goto failed on its first
	 * tick. Swap the tool in like a player would instead of giving up.
	 */
	static boolean needsToolEquip(boolean requiresCorrectTool, boolean hotbarHasTool) {
		return requiresCorrectTool && !hotbarHasTool;
	}
}
