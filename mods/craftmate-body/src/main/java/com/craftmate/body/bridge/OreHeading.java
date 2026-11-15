package com.craftmate.body.bridge;

/**
 * Chooses the grid direction a branch tunnel should take to reach a nearby
 * ore. The body cannot mine an ore it cannot see, and a blind main-axis
 * branch happily tunnels past seams that are one block to the side. Turning
 * the branch toward the surveyed ore each step makes the tunnel zig-zag onto
 * the seam instead of walking beside it forever.
 */
final class OreHeading {
	private OreHeading() {
	}

	/**
	 * Dominant-axis heading from the body to the ore center, or null when the
	 * body already stands on that column.
	 */
	static int[] toward(double bodyX, double bodyZ, int oreX, int oreZ) {
		double dx = oreX + 0.5 - bodyX;
		double dz = oreZ + 0.5 - bodyZ;
		if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) return null;
		if (Math.abs(dx) >= Math.abs(dz)) {
			return new int[] { dx >= 0.0 ? 1 : -1, 0 };
		}
		return new int[] { 0, dz >= 0.0 ? 1 : -1 };
	}
}
