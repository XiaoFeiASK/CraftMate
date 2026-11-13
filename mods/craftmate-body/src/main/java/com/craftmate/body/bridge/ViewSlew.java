package com.craftmate.body.bridge;

/**
 * Bounded rotation. A player never snaps from one heading to another in a
 * single tick, and the audience reads an instant snap as a machine. Every
 * walking loop turns through this helper. Mining still aims the body because
 * vanilla recomputes the pick target from the player's own rotation every
 * tick.
 */
final class ViewSlew {
	/** 120 degrees per second at 20 ticks per second. */
	static final float WALK_TURN_PER_TICK = 6.0f;
	/** Slower than walking: a look-around should not whip the body. */
	static final float LOOK_TURN_PER_TICK = 4.0f;
	static final float PITCH_PER_TICK = 3.0f;
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

	/** Vanilla yaw for a direction, where 0 faces south (+Z). */
	static float yawTo(double dx, double dz) {
		return (float) Math.toDegrees(Math.atan2(-dx, dz));
	}

	/** Vanilla pitch for a direction: positive looks down. */
	static float pitchTo(double dx, double dy, double dz) {
		double length = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (length < 1.0e-6) return 0.0f;
		return (float) Math.toDegrees(
			-Math.asin(Math.max(-1.0, Math.min(1.0, dy / length)))
		);
	}

	/** Vanilla's shortest signed angle, implemented without a client class. */
	static float wrap(float degrees) {
		float value = degrees % 360.0f;
		if (value >= 180.0f) value -= 360.0f;
		if (value < -180.0f) value += 360.0f;
		return value;
	}
}
