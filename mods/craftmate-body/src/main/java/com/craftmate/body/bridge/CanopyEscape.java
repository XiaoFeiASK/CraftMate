package com.craftmate.body.bridge;

/**
 * A body can end up on top of a tree canopy. Leaves are solid enough to stand
 * on, but they are deliberately not a navigation floor, so every A* search
 * from the canopy has no standable neighbour and returns no route. The body
 * is not stuck: it can peel the leaf under its feet, drop exactly one block
 * onto the next leaf layer, and repeat until the remaining drop is short
 * enough to take without damage.
 */
final class CanopyEscape {
	/** Vanilla starts applying fall damage after three blocks. */
	static final int SAFE_DROP = 3;
	/**
	 * A canopy escape reports progress every second while it peels leaves, so
	 * the coordinator rightfully keeps the command alive. If the body cannot
	 * actually leave the tree, those frames must not turn into an unbounded
	 * task: fail at the same bounded pace as other recovery actions.
	 */
	static final int ESCAPE_BUDGET_TICKS = 20 * 30;

	private CanopyEscape() {
	}

	/** True while the body stands on leaves instead of real ground. */
	static boolean standingOnLeaves(boolean onGround, boolean floorIsLeaves) {
		return onGround && floorIsLeaves;
	}

	/**
	 * Chopping a tree can leave the body standing on the top log while leaf
	 * blocks still surround its head and feet. The log is solid enough to be
	 * a navigation floor, but every horizontal exit is a wall of leaves, so
	 * A* returns no route. Treat an exposed log with at least two leaf
	 * neighbours as the same canopy trap as a leaf floor.
	 */
	static boolean standingInTreeCanopy(
		boolean onGround,
		boolean floorIsLeaves,
		boolean floorIsLog,
		int leafNeighbours
	) {
		return standingOnLeaves(onGround, floorIsLeaves)
			|| (onGround && floorIsLog && leafNeighbours >= 1);
	}

	/**
	 * Chopping a trunk can leave the upper logs floating around the body's
	 * feet. The body is then clipped inside a log: every horizontal route is
	 * blocked, and a leaf-only canopy check misses because the support block
	 * below is ordinary ground. Mining the cell the body occupies is the only
	 * reliable way out.
	 */
	static boolean trappedInsideTree(boolean onGround, boolean feetIsWoody) {
		return onGround && feetIsWoody;
	}

	/**
	 * A tree house, a wool platform or a placed block can sit on top of the
	 * same leaf crown. The support is not a leaf or a log, so the normal
	 * canopy test misses it, yet every horizontal route is still foliage.
	 * A natural support also qualifies when it is an isolated pedestal with
	 * no same-layer walkable neighbour; ordinary grass beside a tree keeps
	 * its normal routes and stays a tunneling problem.
	 *
	 * <p>A block placed by this body's own pillar escape is not a platform.
	 * The escape builds a 1x1 column through the foliage, so its top block
	 * looks exactly like an isolated platform. Peeling it dropped the body
	 * one block and immediately re-triggered the same test, which produced a
	 * live loop that mined its own scaffolding out from under itself.
	 */
	static boolean standingOnRaisedCanopyPlatform(
		boolean onGround,
		boolean atSurface,
		int leafNeighbours,
		boolean naturalGround,
		boolean isolated,
		boolean ownPillar
	) {
		return !ownPillar
			&& onGround
			&& atSurface
			&& leafNeighbours >= 2
			&& (!naturalGround || isolated);
	}

	/**
	 * Peeling the block below the feet is safe when the body lands on another
	 * canopy layer, or when the exposed fall is within the damage threshold
	 * and the landing itself is not hazardous.
	 */
	static boolean canPeel(boolean belowIsCanopy, int dropBlocks, boolean landingSafe) {
		if (belowIsCanopy) return true;
		return canLeaveCanopy(dropBlocks, landingSafe);
	}

	/** The last leaf may only be removed for a short, safe drop. */
	static boolean canLeaveCanopy(int dropBlocks, boolean landingSafe) {
		return landingSafe && dropBlocks >= 0 && dropBlocks <= SAFE_DROP;
	}

	/**
	 * Once the final leaf layer is reached and the drop is too long, walking
	 * across the canopy toward a lower landing is the only safe descent.
	 */
	static boolean shouldWalkToLanding(boolean onLastLayer, int dropBlocks) {
		return onLastLayer && dropBlocks > SAFE_DROP;
	}

	/**
	 * `blocksMotion()` is false for leaves, so the generic body-space probe
	 * calls a leaf cell walkable even though its collision box stops the
	 * body. Choosing such a step froze the live body against a birch crown:
	 * every tick steered into the same leaf and the goto timed out without
	 * moving a block. A canopy walk may only enter truly open cells.
	 */
	static boolean walkableCanopyCell(
		boolean bodySpace,
		boolean feetLeaves,
		boolean headLeaves,
		boolean feetLogs,
		boolean headLogs
	) {
		return bodySpace && !feetLeaves && !headLeaves && !feetLogs && !headLogs;
	}

	/**
	 * Vanilla resolves a diagonal move one axis at a time. If either
	 * orthogonal cell is closed, both axes cancel and the body stands still
	 * even though the diagonal destination itself is open.
	 */
	static boolean diagonalCanopyStepClear(
		boolean diagonal,
		boolean firstOrthogonalClear,
		boolean secondOrthogonalClear
	) {
		return !diagonal || (firstOrthogonalClear && secondOrthogonalClear);
	}

	/**
	 * A peeled or felled tree can leave the body on a one-block trunk top
	 * with no leaves left and no standable neighbour. The walk grid then has
	 * no route or safe ledge, and every goto failed from the same perch. This
	 * is still a canopy descent, not normal terrain.
	 */
	static boolean standingOnBareTreeTop(
		boolean onGround,
		boolean logSupport,
		boolean isolated
	) {
		return onGround && logSupport && isolated;
	}

	/** True once a canopy escape has spent its whole bounded budget. */
	static boolean timedOut(int startedAge, int currentAge) {
		return startedAge >= 0 && currentAge - startedAge >= ESCAPE_BUDGET_TICKS;
	}
}
