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

	/**
	 * A descent that reached an aquifer must be allowed to sink. The head may
	 * go under because a flooded stair can be deeper than the surface; the air
	 * reserve is the limit. Surfacing resumes while there is still enough air
	 * to swim back up, and only a task that explicitly asked for the descent
	 * may suppress the normal surface reflex.
	 */
	static boolean mayDive(
		boolean bodyInWater,
		boolean onGround,
		int airSupply,
		boolean descentRequested
	) {
		return descentRequested
			&& bodyInWater
			&& !onGround
			&& airSupply > 100;
	}
}
