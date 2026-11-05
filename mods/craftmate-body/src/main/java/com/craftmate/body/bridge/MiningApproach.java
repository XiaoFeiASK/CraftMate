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

	private MiningApproach() {
	}

	static Mode next(boolean routeAvailable, boolean relevantLeaf) {
		if (routeAvailable) return Mode.WALK_TO_LOG;
		return relevantLeaf ? Mode.CLEAR_CANOPY : Mode.WALK_TO_LOG;
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
}
