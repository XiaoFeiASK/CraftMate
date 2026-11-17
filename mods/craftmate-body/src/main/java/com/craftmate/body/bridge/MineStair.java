package com.craftmate.body.bridge;

/**
 * Pure stair-step ordering for the reusable mine. A descending step opens
 * three cells in front of the body: the body cell, its headroom, and the
 * landing one level lower. When all three are air the planner advances to the
 * landing; returning "no plan" there made the entrance reset forever.
 */
final class MineStair {
	/** No cell needs breaking; the planning cursor may step down. */
	static final int ADVANCE = -1;
	static final int BODY = 0;
	static final int HEAD = 1;
	static final int LANDING = 2;

	private MineStair() {
	}

	/**
	 * A decoration such as a wall torch is non-air but does not obstruct the
	 * body. Treating it as a stair obstacle makes the planner mine the torch
	 * it just placed, lose the light, and place another one forever.
	 */
	static boolean blocksStep(boolean air, boolean blocksMotion, boolean fluid) {
		return !air && blocksMotion && !fluid;
	}

	static int nextTarget(
		boolean bodySolid,
		boolean headSolid,
		boolean landingSolid
	) {
		if (bodySolid) return BODY;
		if (headSolid) return HEAD;
		if (landingSolid) return LANDING;
		return ADVANCE;
	}

	/**
	 * Headings to try when the remembered stair line has no usable floor at
	 * the body's depth. Perpendicular tunnels are the natural continuation of
	 * a dead-end shaft; the reverse heading is only a last resort because it
	 * usually looks back into the open stair the body just descended.
	 */
	static int[][] fallbackHeadings(int mainDx, int mainDz) {
		int[][] all = {
			{ 0, -1 },
			{ 1, 0 },
			{ 0, 1 },
			{ -1, 0 },
		};
		int[][] ordered = new int[all.length - 1][];
		int index = 0;
		for (int[] heading : all) {
			if (heading[0] == mainDx && heading[1] == mainDz) continue;
			if (heading[0] == -mainDx && heading[1] == -mainDz) continue;
			ordered[index++] = heading;
		}
		ordered[index] = new int[] { -mainDx, -mainDz };
		return ordered;
	}

	/**
	 * A deep stair with no next cell and no branch is a dead end, not an open
	 * route. Keeping its entrance forever made the planner mine arbitrary
	 * stone faces at the bottom of a flooded shaft; the body reported dozens
	 * of one-block "successes" while the tunnel never advanced. A shallow
	 * stair is still being started, and a stair with a branch has somewhere
	 * useful to go.
	 */
	static boolean abandonableDeadEnd(
		boolean hasPending,
		int depth,
		boolean hasBranch
	) {
		return !hasPending && !hasBranch && depth >= 4;
	}
}
