package com.craftmate.body.bridge;

/**
 * Bounded rotation. A player never snaps from one heading to another in a
 * single tick, and the audience reads an instant snap as a machine. Every
 * walking loop turns through this helper, while interaction aim stays exact
 * because the crosshair has to be on the block this tick.
 */
final class ViewSlew {
	/** 240 degrees per second at 20 ticks per second. */
	static final float WALK_TURN_PER_TICK = 12.0f;
	/** Slower than walking: a look-around should not whip the body. */
	static final float LOOK_TURN_PER_TICK = 8.0f;
	static final float PITCH_PER_TICK = 5.0f;
	/** Walking while off-heading makes the body arc into walls. */
	static final float WALK_ALIGNMENT = 25.0f;

	private ViewSlew() {
	}

	/** Shortest-path step toward a yaw, clamped to {@code maxDelta}. */
	static float stepYaw(float current, float target, float maxDelta) {
		float delta = wrap(target - current);
		if (Math.abs(delta) <= maxDelta) return wrap(target);
		return wrap(current + Math.copySign(maxDelta, delta));
	}

	/** Pitch has no wraparound; clamp it to the vanilla vertical range. */
	static float stepPitch(float current, float target, float maxDelta) {
		float clamped = Math.max(-90.0f, Math.min(90.0f, target));
		float delta = clamped - current;
		if (Math.abs(delta) <= maxDelta) return clamped;
		return current + Math.copySign(maxDelta, delta);
	}

	static boolean aligned(float current, float target, float tolerance) {
		return Math.abs(wrap(target - current)) <= tolerance;
	}

	/** Vanilla's shortest signed angle, implemented without a client class. */
	static float wrap(float degrees) {
		float value = degrees % 360.0f;
		if (value >= 180.0f) value -= 360.0f;
		if (value < -180.0f) value += 360.0f;
		return value;
	}
}
