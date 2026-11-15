package com.craftmate.body.bridge;

/**
 * Pure third-person camera framing and position spring. Keeping this free of
 * Minecraft classes makes the jump/clamp guarantees testable without a client.
 */
public final class CameraSpring {
	public static final double SHOULDER_BACK = 3.2;
	public static final double SHOULDER_RIGHT = 0.6;
	public static final double SHOULDER_UP = 0.35;
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
	 * Gentle right-shoulder framing. Yaw 0 faces south (+Z); right is the
	 * cross product of forward and world up, so the offset stays stable at
	 * every heading. Velocity is bounded so walking does not push the frame
	 * far ahead of the body.
	 */
	public static Target shoulderTarget(
		double eyeX,
		double eyeY,
		double eyeZ,
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
		double rightX = -Math.cos(yaw);
		double rightZ = -Math.sin(yaw);

		double lookX = velocityX * LOOK_AHEAD_SECONDS;
		double lookZ = velocityZ * LOOK_AHEAD_SECONDS;
		double lookLength = Math.hypot(lookX, lookZ);
		if (lookLength > MAX_LOOK_AHEAD) {
			double scale = MAX_LOOK_AHEAD / lookLength;
			lookX *= scale;
			lookZ *= scale;
		}
		return new Target(
			eyeX + lookX - forwardX * SHOULDER_BACK
				+ rightX * SHOULDER_RIGHT,
			eyeY - forwardY * SHOULDER_BACK + SHOULDER_UP,
			eyeZ + lookZ - forwardZ * SHOULDER_BACK
				+ rightZ * SHOULDER_RIGHT
		);
	}

	/**
	 * Applies an occlusion hit distance while preserving the shoulder offset
	 * direction. Restoring is handled by the spring, so a wall exit is smooth
	 * instead of a one-frame pop.
	 */
	public static Target clipped(
		double eyeX,
		double eyeY,
		double eyeZ,
		Target desired,
		double hitDistance
	) {
		double dx = desired.x() - eyeX;
		double dy = desired.y() - eyeY;
		double dz = desired.z() - eyeZ;
		double length = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (length < 1.0e-6) return desired;
		double allowed = Math.max(0.25, Math.min(length, hitDistance - OCCLUSION_MARGIN));
		double scale = allowed / length;
		return new Target(
			eyeX + dx * scale,
			eyeY + dy * scale,
			eyeZ + dz * scale
		);
	}
}
