package com.craftmate.body.bridge;

/**
 * A body that dug a one-block shaft cannot leave it with horizontal A*
 * because every neighbour is a solid wall. The escape plan is deliberately
 * small: open exactly one wall cell and step into it. It never mines the
 * floor, so the body cannot deepen the hole it is trying to leave.
 */
final class ShaftEscape {
	private ShaftEscape() {
	}

	/**
	 * @param horizontalWalls number of solid horizontal neighbours
	 * @param hasPickaxe true when a carried tool can harvest the wall
	 */
	static boolean shouldDigOut(int horizontalWalls, boolean hasPickaxe) {
		return horizontalWalls >= 3 && hasPickaxe;
	}

	/**
	 * Chooses a wall cell only when it is solid and its centre is on the
	 * crosshair. An obstructed or already-open cell is not an escape.
	 */
	static boolean canBreakWall(boolean solid, boolean centreVisible) {
		return solid && centreVisible;
	}
}
