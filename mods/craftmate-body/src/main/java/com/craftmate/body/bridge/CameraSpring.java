package com.craftmate.body.bridge;

/**
 * Pure third-person camera framing and position spring. Keeping this free of
 * Minecraft classes makes the jump/clamp guarantees testable without a client.
 */
public final class CameraSpring {
	/**
	 * Audience framing is deliberately wider than vanilla third person. The
	 * goal is not a cinematic over-the-shoulder shot: a fixed seven-block
	 * observation distance shows the body, the tunnel face and the blocks it
	 * is interacting with at the same time. Terrain never shortens it.
	 */
	public static final double SHOULDER_BACK = 7.0;
	public static final double SHOULDER_UP = 1.25;
	/** Camera anchor is the torso, expressed as a fraction of entity height. */
	public static final double TORSO_HEIGHT_FRACTION = 0.55;
	/** Audience framing keeps most of the look pitch while retaining body weight. */
	public static final double LOOK_PITCH_WEIGHT = 0.75;
	public static final double BODY_PITCH_WEIGHT = 0.25;
	/** 120 ms position settle, slow enough to hide node transitions. */
	public static final double TIME_CONSTANT_SECONDS = 0.12;
	public static final double MAX_STEP_PER_FRAME = 0.45;
	public static final double LOOK_AHEAD_SECONDS = 0.04;
	public static final double MAX_LOOK_AHEAD = 0.18;

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
	 * Keeps the current viewing direction but pins the camera to an exact
	 * radius around the anchor. The character is small enough that a changing
	 * distance reads as an unwanted zoom; the spring may smooth direction but
	 * never scale. If the body walks into the camera, this pushes it back out.
	 */
	public void pinDistance(
		double anchorX,
		double anchorY,
		double anchorZ,
		double distance
	) {
		if (!initialized || distance <= 0.0) return;
		double dx = x - anchorX;
		double dy = y - anchorY;
		double dz = z - anchorZ;
		double length = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (length < 1.0e-6) {
			// A degenerate direction cannot be repaired from the current
			// sample; leave the position to the next follow target.
			return;
		}
		double scale = distance / length;
		x = anchorX + dx * scale;
		y = anchorY + dy * scale;
		z = anchorZ + dz * scale;
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

}
