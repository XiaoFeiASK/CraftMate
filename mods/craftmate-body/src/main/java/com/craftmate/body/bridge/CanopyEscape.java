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
			|| (onGround && floorIsLog && leafNeighbours >= 2);
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
}
