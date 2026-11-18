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

	/**
	 * A station the body built can be mined, recovered and placed again.
	 * Containers and beds hold state, so an escape must route around them.
	 * Planning and mining must use the same answer here: the live loop was a
	 * workbench that passed `ceilingMineable` and then hit an unconditional
	 * facility abort in `mineCeilingBlock`.
	 */
	static boolean mayClearEscapeFacility(
		boolean playerFacility,
		boolean recoverableFacility
	) {
		return !playerFacility || recoverableFacility;
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
	 * A body four blocks down its own stair is below the entrance by design.
	 * The height guard exists to reject an entrance on a roof or chest
	 * platform, not to relocate a perfectly good shaft every time the body
	 * descends. The live run alternated between mining a few steps and
	 * climbing back to the surface because the entrance was rebuilt at the
	 * same high ground on every cycle.
	 */
	static boolean insideOwnStair(
		int bodyX,
		int bodyY,
		int bodyZ,
		int entranceX,
		int entranceY,
		int entranceZ,
		int stepX,
		int stepZ
	) {
		if (bodyY >= entranceY || bodyY < entranceY - 64) return false;
		int depth = entranceY - bodyY;
		int expectedX = entranceX + stepX * depth;
		int expectedZ = entranceZ + stepZ * depth;
		return Math.abs(bodyX - expectedX) <= 2 && Math.abs(bodyZ - expectedZ) <= 2;
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
	 * A body can stand on the corner of a stair while `blockPosition()`
	 * reports the adjacent air column. Jump-placing from that column has no
	 * support to click, so the pillar loop aborts without moving. The real
	 * support is visible through the bounding box; walk over it first.
	 */
	static boolean shouldRecenterBeforePillar(
		boolean feetSupported,
		boolean supportOnAnotherColumn
	) {
		return !feetSupported && supportOnAnotherColumn;
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

	/**
	 * A pillar can drift into the neighbouring column when the body lands on
	 * the edge of its placed block. Continuing to centre on the original
	 * column then walks into a wall and times out. Once at least one jump has
	 * landed, follow the column the body actually occupies.
	 */
	static boolean shouldRecenterPillarColumn(
		int climbedSteps,
		int bodyX,
		int bodyZ,
		int centerX,
		int centerZ
	) {
		return climbedSteps > 0 && (bodyX != centerX || bodyZ != centerZ);
	}

	/**
	 * A torch, button or rail stands in the cell the body just vacated. It
	 * does not block movement, so the jump reaches the right height, but the
	 * cell is not replaceable and every placement packet is rejected
	 * silently. The body then jumps in place forever. Clear such a tiny
	 * decoration first; containers, signs and climbable blocks are left
	 * alone because they are either valuable or have their own escape route.
	 */
	static boolean shouldClearPillarCell(
		boolean replaceable,
		boolean blocksMotion,
		boolean hasBlockEntity,
		boolean climbable,
		float hardness
	) {
		return !replaceable
			&& !blocksMotion
			&& !hasBlockEntity
			&& !climbable
			&& hardness >= 0.0f
			&& hardness <= 1.0f;
	}

	/** Stop climbing once the requested floor has been reached. */
	static boolean pillarReachedTarget(int feetY, int baseY, double targetY) {
		return feetY > baseY && targetY <= feetY + 0.5;
	}

	/**
	 * Suffocation needs a solid block in one of the two cells the body
	 * occupies. A pillar that lands with either cell occupied must clear it
	 * before reporting success; otherwise the next walk command retries an
	 * impossible route while the body loses health inside its own shaft.
	 */
	static boolean bodyEmbedded(boolean feetSolid, boolean headSolid) {
		return feetSolid || headSolid;
	}

	/**
	 * Jump-placing uses the block column under the body. When that column is
	 * also the body's own column, the placement must wait until the jump has
	 * lifted the bounding box clear; otherwise the body is sealed into the
	 * block it just placed.
	 */
	static boolean bodyOccupiesCell(
		int cellX,
		int cellY,
		int cellZ,
		double playerX,
		double playerFeetY,
		double playerZ
	) {
		final double halfWidth = 0.3;
		final double bodyHeight = 1.8;
		return playerX + halfWidth > cellX
			&& playerX - halfWidth < cellX + 1
			&& playerZ + halfWidth > cellZ
			&& playerZ - halfWidth < cellZ + 1
			&& playerFeetY + bodyHeight > cellY
			&& playerFeetY < cellY + 1;
	}

	/**
	 * A complete route can still end in the body's current cell. Recovery
	 * treated that as progress, reported the requested target as reached,
	 * and left the body in a one-cell shaft where walk mode can never move.
	 * A route that does not leave the cell is only useful when the body is
	 * already inside the requested goal window.
	 */
	static boolean completeRouteMovesBody(
		boolean complete,
		double destinationDistance,
		double targetDistance,
		double goalWindow
	) {
		if (!complete) return true;
		return destinationDistance >= 0.75 || targetDistance <= goalWindow;
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
		/*
		 * This runs only after A* has no route at all. A dead-end tunnel or a
		 * shallow water pocket can have one or two walls, not the four of a
		 * self-dug shaft. Refusing those pockets made the live body report
		 * E_ENCLOSED every six seconds while a single mineable wall stood
		 * beside it. One harvestable wall is enough to open the next cell;
		 * the caller still verifies the wall is not a player facility and
		 * that the body can actually break it.
		 */
		return horizontalWalls >= 1 && hasPickaxe;
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
	 * A target above the body needs a staircase even when it is not directly
	 * overhead. A far surface destination used to fall through every escape:
	 * it was too high for a level tunnel, not directly above for a pillar,
	 * and the climb step was gated on that same "directly above" check. The
	 * body then reported E_ENCLOSED without trying the one legal move.
	 */
	static boolean shouldStairUp(
		boolean grounded,
		boolean mayDig,
		double targetDeltaY
	) {
		return grounded && mayDig && targetDeltaY > 0.9;
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
	 * A waypoint index is only valid while a route is installed. Escape
	 * steps can hand control back on an airborne frame, leaving the list
	 * empty; that is a reason to resume escaping, never an internal error.
	 */
	static boolean hasCurrentWaypoint(int index, int size) {
		return index >= 0 && index < size;
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
