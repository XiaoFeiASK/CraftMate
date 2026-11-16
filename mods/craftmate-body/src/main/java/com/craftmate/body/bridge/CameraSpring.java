package com.craftmate.body.bridge;

/**
 * Pure third-person camera framing and position spring. Keeping this free of
 * Minecraft classes makes the jump/clamp guarantees testable without a client.
 */
public final class CameraSpring {
	public static final double SHOULDER_BACK = 3.2;
	public static final double SHOULDER_UP = 0.35;
	/** Camera anchor is the torso, expressed as a fraction of entity height. */
	public static final double TORSO_HEIGHT_FRACTION = 0.55;
	/** Audience framing keeps most of the look pitch while retaining body weight. */
	public static final double LOOK_PITCH_WEIGHT = 0.6;
	public static final double BODY_PITCH_WEIGHT = 0.4;
	/** 120 ms position settle, slow enough to hide node transitions. */
	public static final double TIME_CONSTANT_SECONDS = 0.12;
	public static final double MAX_STEP_PER_FRAME = 0.45;
	public static final double LOOK_AHEAD_SECONDS = 0.10;
	public static final double MAX_LOOK_AHEAD = 0.5;
	public static final double OCCLUSION_MARGIN = 0.28;

	private double x;
	private double y;
	private double z;
	private boolean initialized;

	public record Target(double x, double y, double z) {
	}

	public boolean initialized() {
		return initialized;
	}

	public void reset() {
		x = 0.0;
		y = 0.0;
		z = 0.0;
		initialized = false;
	}

	public double x() {
		return x;
	}

	public double y() {
		return y;
	}

	public double z() {
		return z;
	}

	public void snap(double targetX, double targetY, double targetZ) {
		x = targetX;
		y = targetY;
		z = targetZ;
		initialized = true;
	}

	public void snap(Target target) {
		snap(target.x(), target.y(), target.z());
	}

	/**
	 * Critically-smoothed exponential approach with an explicit per-frame
	 * ceiling. A long render stall cannot consume seconds of backlog at once.
	 */
	public void step(Target target, double dt) {
		if (!initialized) {
			snap(target);
			return;
		}
		double seconds = Math.max(0.0, Math.min(0.1, dt));
		double alpha = 1.0 - Math.exp(-seconds / TIME_CONSTANT_SECONDS);
		double dx = (target.x() - x) * alpha;
		double dy = (target.y() - y) * alpha;
		double dz = (target.z() - z) * alpha;
		double distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (distance > MAX_STEP_PER_FRAME) {
			double scale = MAX_STEP_PER_FRAME / distance;
			dx *= scale;
			dy *= scale;
			dz *= scale;
		}
		x += dx;
		y += dy;
		z += dz;
	}

	public double distanceTo(double targetX, double targetY, double targetZ) {
		double dx = targetX - x;
		double dy = targetY - y;
		double dz = targetZ - z;
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	}

	/**
	 * Centred third-person framing around the torso. Yaw 0 faces south (+Z).
	 * There is deliberately no lateral offset: the character remains on the
	 * horizontal centre line at every heading.
	 */
	public static Target followTarget(
		double anchorX,
		double anchorY,
		double anchorZ,
		float yawDegrees,
		float pitchDegrees,
		double velocityX,
		double velocityZ
	) {
		double yaw = Math.toRadians(yawDegrees);
		double pitch = Math.toRadians(pitchDegrees);
		double forwardX = -Math.sin(yaw) * Math.cos(pitch);
		double forwardY = -Math.sin(pitch);
		double forwardZ = Math.cos(yaw) * Math.cos(pitch);

		double lookX = velocityX * LOOK_AHEAD_SECONDS;
		double lookZ = velocityZ * LOOK_AHEAD_SECONDS;
		double lookLength = Math.hypot(lookX, lookZ);
		if (lookLength > MAX_LOOK_AHEAD) {
			double scale = MAX_LOOK_AHEAD / lookLength;
			lookX *= scale;
			lookZ *= scale;
		}
		return new Target(
			anchorX + lookX - forwardX * SHOULDER_BACK,
			anchorY - forwardY * SHOULDER_BACK + SHOULDER_UP,
			anchorZ + lookZ - forwardZ * SHOULDER_BACK
		);
	}

	/** Blend camera intent with the body's current pitch. */
	public static float framingPitch(float lookPitch, float bodyPitch) {
		return (float) (lookPitch * LOOK_PITCH_WEIGHT + bodyPitch * BODY_PITCH_WEIGHT);
	}

	/**
	 * Applies an occlusion hit distance while preserving the follow offset
	 * direction. Restoring is handled by the spring, so a wall exit is smooth
	 * instead of a one-frame pop.
	 */
	public static Target clipped(
		double anchorX,
		double anchorY,
		double anchorZ,
		Target desired,
		double hitDistance
	) {
		double dx = desired.x() - anchorX;
		double dy = desired.y() - anchorY;
		double dz = desired.z() - anchorZ;
		double length = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (length < 1.0e-6) return desired;
		double allowed = Math.max(0.25, Math.min(length, hitDistance - OCCLUSION_MARGIN));
		double scale = allowed / length;
		return new Target(
			anchorX + dx * scale,
			anchorY + dy * scale,
			anchorZ + dz * scale
		);
	}
}
