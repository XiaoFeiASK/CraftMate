package com.craftmate.body.bridge;

/**
 * Pure ordering for placement candidates. The client can only see a fixed
 * crosshair ray, so a placement skill must turn toward a nearby face instead
 * of failing merely because the player happened to look at their feet.
 */
final class PlacementTarget {
	private static final double MAX_EYE_DISTANCE = 4.5;
	private static final double EPSILON = 1.0e-6;

	interface Surface {
		/** Distance from the eye to the block's nearest point, not its center. */
		double distanceSqr();

		/** The adjacent cell is free and will hold the placed block. */
		boolean destinationFree();
	}

	/**
	 * Prefer a surface whose adjacent cell is free, then the closest one. A
	 * caller may still retry after a rollback, but it must not submit to an
	 * occupied cell and call that a placement attempt.
	 */
	static <T extends Surface> T choose(Iterable<T> candidates) {
		T best = null;
		double bestScore = Double.POSITIVE_INFINITY;
		for (T candidate : candidates) {
			double distance = candidate.distanceSqr();
			if (distance > MAX_EYE_DISTANCE * MAX_EYE_DISTANCE) continue;
			double score = (candidate.destinationFree() ? 0.0 : 1_000_000.0) + distance;
			if (score < bestScore) {
				bestScore = score;
				best = candidate;
			}
		}
		return best;
	}

	static boolean withinReach(double distanceSqr) {
		return distanceSqr <= MAX_EYE_DISTANCE * MAX_EYE_DISTANCE;
	}

	/**
	 * The server rejects a full block that intersects the player hitbox. A
	 * successful client ray is therefore not a legal placement attempt.
	 */
	static boolean overlapsPlayer(
		net.minecraft.world.phys.AABB playerBounds,
		int x,
		int y,
		int z
	) {
		return playerBounds.intersects(
			x + EPSILON,
			y + EPSILON,
			z + EPSILON,
			x + 1.0 - EPSILON,
			y + 1.0 - EPSILON,
			z + 1.0 - EPSILON
		);
	}

	/**
	 * The body's current column and the blocks directly below it are its
	 * footing. Placing there would remove the floor the next walk depends on.
	 */
	static boolean overlapsStandingCell(
		net.minecraft.core.BlockPos feet,
		int x,
		int y,
		int z
	) {
		return x == feet.getX()
			&& z == feet.getZ()
			&& y >= feet.getY() - 2
			&& y <= feet.getY();
	}
}
