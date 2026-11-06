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
	 * Pillaring is a vertical-shaft escape, not a way to climb open sky. In a
	 * cave the ceiling is solid; in a one-block hole the body is walled in.
	 * With neither signal the body is simply standing at a cliff edge, and
	 * placing a tower there burns every building block without going
	 * anywhere. That is what produced the sky pillar in the live run.
	 */
	static boolean shouldStartPillar(boolean ceilingSolid, int horizontalWalls) {
		return ceilingSolid || horizontalWalls >= 3;
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
