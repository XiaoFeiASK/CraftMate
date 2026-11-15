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
	 * An explicit target above the body is a vertical goal, not opportunistic
	 * sky pillaring. The caller still has to prove the body can recover the
	 * pillar material and that a canopy escape was not required.
	 */
	static boolean shouldStartTargetClimb(
		boolean targetAbove,
		boolean ceilingSolid,
		int horizontalWalls
	) {
		return targetAbove || shouldStartPillar(ceilingSolid, horizontalWalls);
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

	/**
	 * A mine entrance on a roof or chest platform is above the walking floor
	 * and cannot be entered. An entrance below the body is ordinary downhill
	 * terrain; treating it as invalid made the search pick the same lower cell
	 * again on the next tick, forever.
	 */
	static boolean entranceAboveWalkingLevel(int entranceY, int bodyY) {
		return entranceY > bodyY + 2;
	}

	/**
	 * Entrance selection is a camp decision, not a body-position decision.
	 * A body deep in its own stair still counts as "near home" in 3D, so the
	 * old relocation/search anchored on it and moved the mine to the bottom
	 * of the shaft. Only the home's own walking level may choose a site.
	 */
	static boolean nearHomeLevel(int bodyY, int homeY) {
		return Math.abs(bodyY - homeY) <= 12;
	}

	/**
	 * A persisted entrance has a stair the body already dug. The candidate
	 * site probe expects a pristine descending line, so it reports
	 * `descent_blocked` for the body's own tunnel and would erase a perfectly
	 * usable route. Keep the entrance for that probe; the real next step is
	 * planned from the stair blueprint.
	 */
	static boolean keepRememberedEntrance(String problem) {
		return "descent_blocked".equals(problem);
	}

	/**
	 * A one-cell vertical shaft the body dug upward has no walk route down.
	 * Breaking the support is safe only when the body is actually walled in
	 * and the block below that support is solid, so each drop is one block.
	 */
	static boolean canDescendShaft(
		int solidWalls,
		boolean harvestableSupport,
		boolean solidLanding,
		boolean clearHead
	) {
		return solidWalls >= 3 && harvestableSupport && solidLanding && clearHead;
	}

	/**
	 * The height check exists to reject an entrance remembered on a chest
	 * platform or hut roof. A body walking a lower terrace of the same camp,
	 * or climbing back up its own stair after a food trip, is not evidence
	 * of that: the camp's own site search already allows ground within four
	 * blocks of the home. Rejecting the entrance there reset its direction
	 * and abandoned the open staircase.
	 */
	static boolean atHomeWalkingLevel(int bodyY, int homeY) {
		return Math.abs(bodyY - homeY) <= 4;
	}

	/**
	 * A remembered entrance must stay inside the camp's mine site. The
	 * selection search never looks farther than its radius; an entrance
	 * outside that ring was chosen from an underground body position or a
	 * stale camp and must be rebuilt near the real home.
	 */
	static boolean entranceWithinHomeSite(
		int entranceX,
		int entranceY,
		int entranceZ,
		int homeX,
		int homeY,
		int homeZ,
		int radius
	) {
		return Math.abs(entranceY - homeY) <= 6
			&& Math.hypot(entranceX - homeX, entranceZ - homeZ) <= radius;
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
	 *
	 * <p>The tolerance is one block, not two and a half: a body two blocks
	 * below a chest accepted a descending leg as progress, walked down,
	 * replanned back up, and ping-ponged until every goto timed out. A jump
	 * clears a single block; anything higher needs the escape to build.
	 */
	static boolean routeAdvancesTowardTarget(
		boolean complete,
		double destinationY,
		double playerY,
		double targetY
	) {
		if (complete) return true;
		if (targetY - playerY <= 1.0) return true;
		return destinationY >= playerY + 1.0;
	}

	/**
	 * The goal window accepts cells within one block of the request in every
	 * axis. When the request is one level above the body, the body's own cell
	 * therefore counted as "near" the goal and the pathfinder returned a
	 * one-cell route that completed without moving. The next snapshot saw the
	 * same position and issued the identical stair command forever. A start
	 * cell can only be the goal when the requested level is its own level.
	 */
	static boolean startCellReachesGoal(int startY, int goalY) {
		return startY == goalY;
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
