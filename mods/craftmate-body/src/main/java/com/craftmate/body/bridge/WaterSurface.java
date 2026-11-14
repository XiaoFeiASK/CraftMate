package com.craftmate.body.bridge;

/** Decides when the body must start swimming upward immediately. */
final class WaterSurface {
	private WaterSurface() {
	}

	/**
	 * Eye contact is the obvious signal, but it arrives one or two ticks after
	 * the feet hit deep water. Waiting for it lets the body sink before the
	 * jump key is pressed. Treat any airborne body in water as a swimmer;
	 * standing in a shallow stream still belongs to normal walking.
	 */
	static boolean needsJump(
		boolean bodyInWater,
		boolean eyesInWater,
		boolean onGround
	) {
		return eyesInWater || (bodyInWater && !onGround);
	}
}
