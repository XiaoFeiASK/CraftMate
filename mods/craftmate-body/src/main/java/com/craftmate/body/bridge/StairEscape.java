package com.craftmate.body.bridge;

/**
 * A staircase cell can be hidden behind the exposed edge of the block next to
 * it. That is normal terrain, not a dead end: mine the block the eye ray
 * actually hit, then retry the step. These predicates keep the retarget rule
 * separate from the client state machine so it is covered by fast tests.
 */
final class StairEscape {
	private StairEscape() {
	}

	static boolean canClearSightBlocker(
		boolean blocksMotion,
		boolean submerged,
		float destroySpeed,
		boolean requiresCorrectTool,
		boolean hasCorrectTool
	) {
		return blocksMotion
			&& !submerged
			&& destroySpeed >= 0.0f
			&& (!requiresCorrectTool || hasCorrectTool);
	}

	/** A retarget is only useful while the blocking cell still exists. */
	static boolean obstructionNeedsWork(boolean air) {
		return !air;
	}
}
