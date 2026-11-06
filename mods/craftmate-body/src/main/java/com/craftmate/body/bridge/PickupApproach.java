package com.craftmate.body.bridge;

/** The vertical part of walking into a dropped item. */
final class PickupApproach {
	private PickupApproach() {
	}

	/**
	 * A freshly mined block can leave a one-cell pit whose lip stops normal
	 * horizontal movement. Jumping is only useful while grounded and when the
	 * item is clearly below the feet; jumping over lava would destroy the run.
	 */
	static boolean shouldJumpDown(
		double playerY,
		double dropY,
		boolean onGround,
		boolean lava
	) {
		return onGround && !lava && dropY < playerY - 0.6;
	}
}
