package com.craftmate.body.bridge;

/**
 * The body must distinguish "walk toward the trunk" from "open the canopy".
 * Returning a log when no walk cell exists made the mine loop turn in place
 * for the whole task budget and never change the world.
 */
final class MiningApproach {
	enum Mode {
		WALK_TO_LOG,
		CLEAR_CANOPY,
	}

	enum Obstruction {
		/** The crosshair already landed on another valid target. */
		USE_HIT_BLOCK,
		/** A leaf, soil or an enclosed body: open it instead of scanning the forest. */
		CLEAR_OBSTRUCTION,
		/** A hard block in the open; try a nearby alternative before failing. */
		SEARCH_ALTERNATIVE,
	}

	private MiningApproach() {
	}

	static Mode next(boolean routeAvailable, boolean relevantLeaf) {
		return next(routeAvailable, relevantLeaf, true);
	}

	/**
	 * A missing route is not proof that the trunk is unreachable. The bounded
	 * search can find no standable interaction cell while a straight approach
	 * would still open one. Walk first; clear a leaf only after the body has
	 * stopped making progress, otherwise each tick selects the same leaf and
	 * resets the walk state before a single step is taken.
	 */
	static Mode next(boolean routeAvailable, boolean relevantLeaf, boolean stalled) {
		if (routeAvailable) return Mode.WALK_TO_LOG;
		return relevantLeaf && stalled ? Mode.CLEAR_CANOPY : Mode.WALK_TO_LOG;
	}

	/**
	 * A destroy cycle is only legal while the player can still reach the
	 * block and the targeted face is exposed. The old loop kept holding attack
	 * after the player drifted out of range, producing an honest-looking but
	 * useless "breaking 0%" stream until the deadline.
	 */
	static boolean canDestroy(boolean withinReach, boolean faceVisible) {
		return withinReach && faceVisible;
	}

	/**
	 * A trunk hidden behind its own canopy is not a reason to scan every log
	 * in a 48-block volume. Clear the block that actually blocked the
	 * crosshair, or use it when it is already another valid log. A full-volume
	 * search repeated from {@code tick()} stalled the render thread for the
	 * whole command deadline.
	 */
	static Obstruction obstruction(
		boolean hitMatchesTarget,
		boolean hitIsLeaf,
		boolean hitIsSoft,
		boolean enclosed
	) {
		if (hitMatchesTarget) return Obstruction.USE_HIT_BLOCK;
		if (hitIsLeaf || hitIsSoft || enclosed) return Obstruction.CLEAR_OBSTRUCTION;
		return Obstruction.SEARCH_ALTERNATIVE;
	}
}
