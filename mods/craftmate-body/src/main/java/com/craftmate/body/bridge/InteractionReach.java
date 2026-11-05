package com.craftmate.body.bridge;

/**
 * Vanilla interaction distance is measured from the player's eye to the
 * block, but an agent's reachable standing cell is not always a cardinal
 * neighbour of that block. Keep the geometry pure so targeting can be tested
 * without a live client.
 */
final class InteractionReach {
	private InteractionReach() {
	}

	static double eyeDistance(
		double standX,
		double standY,
		double standZ,
		double eyeHeight,
		double centerX,
		double centerY,
		double centerZ
	) {
		return Math.sqrt(
			Math.pow(standX - centerX, 2)
				+ Math.pow(standY + eyeHeight - centerY, 2)
				+ Math.pow(standZ - centerZ, 2)
		);
	}

	static boolean withinReach(
		double standX,
		double standY,
		double standZ,
		double eyeHeight,
		double centerX,
		double centerY,
		double centerZ,
		double range
	) {
		return eyeDistance(
			standX,
			standY,
			standZ,
			eyeHeight,
			centerX,
			centerY,
			centerZ
		) <= range;
	}
}
