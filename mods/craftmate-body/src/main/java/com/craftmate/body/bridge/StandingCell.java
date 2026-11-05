package com.craftmate.body.bridge;

/**
 * Pure standability rules. A path cell is standable only when it has a solid
 * floor, two blocks of headroom and no fluid at the feet or head. The helper
 * lets the vertical search policy be tested without a live Minecraft level.
 */
final class StandingCell {
	private StandingCell() {
	}

	interface Column {
		/** True when the block below {@code y} is solid, dry and not leaves. */
		boolean floorAt(int y);

		/** True when both blocks at and above {@code y} are passable and dry. */
		boolean headroomAt(int y);
	}

	/**
	 * Returns the first standable feet Y at or above {@code requestedY}, or
	 * {@code Integer.MIN_VALUE}. Searching downward first treated the block
	 * below the player as a second floor and made every caller's `== y` test
	 * fail, which collapsed A* to the start cell on ordinary terrain.
	 */
	static int firstStandable(int requestedY, int maxStepUp, Column column) {
		for (int offset = 0; offset <= maxStepUp; offset++) {
			int y = requestedY + offset;
			if (column.floorAt(y) && column.headroomAt(y)) return y;
		}
		return Integer.MIN_VALUE;
	}
}
