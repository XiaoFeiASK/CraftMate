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
		return shouldStartPillar(ceilingSolid, horizontalWalls, false);
	}

	/**
	 * A body under a real roof can always turn spare building blocks into a
	 * safe floor as it jumps. Requiring a player-made one-block shaft left
	 * the live body stranded in an open underground cave: the ceiling was
	 * air, every horizontal staircase needed a pickaxe it did not have, and
	 * the planner reissued the same impossible goto forever.
	 */
	static boolean shouldStartPillar(
		boolean ceilingSolid,
		int horizontalWalls,
		boolean underground
	) {
		return ceilingSolid || horizontalWalls >= 3 || underground;
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
		return grounded && targetDeltaY <= 2.5 && horizontalDistance >= 3.0;
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
