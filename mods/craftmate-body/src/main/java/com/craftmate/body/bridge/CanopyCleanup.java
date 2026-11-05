package com.craftmate.body.bridge;

/**
 * When every trunk approach is blocked by the tree's own canopy, the body
 * must clear the leaves it can actually hit. Picking "the nearest leaf" in
 * the whole search box can select a leaf across a ravine or one that is not
 * on the walk path; that looks like progress but never opens the trunk.
 */
final class CanopyCleanup {
	private CanopyCleanup() {
	}

	/**
	 * A leaf is a useful cleanup target only when it is part of the canopy
	 * around the trunk and within the same interaction range as the trunk.
	 * The actual visible-face check still happens in the destroy state
	 * machine; this only rejects unrelated distant foliage.
	 */
	static boolean relevant(
		int leafX,
		int leafY,
		int leafZ,
		int trunkX,
		int trunkY,
		int trunkZ,
		double distanceSqr,
		double maxDistance
	) {
		int horizontal = Math.max(Math.abs(leafX - trunkX), Math.abs(leafZ - trunkZ));
		int vertical = Math.abs(leafY - trunkY);
		if (horizontal > 2 || vertical > 3) return false;
		return distanceSqr <= maxDistance * maxDistance;
	}
}
