package com.craftmate.body.bridge;

import net.minecraft.world.phys.Vec3;

/**
 * Pure orbit used by the built-in third-person camera. The player's eye is
 * the sphere centre; yaw, pitch and radius are independent spring targets so
 * a drag or scroll never snaps the rendered frame.
 */
public final class OrbitalRig {
	public static final double MIN_RADIUS = 2.5;
	public static final double DEFAULT_RADIUS = 8.5;
	public static final double MAX_RADIUS = 20.0;
	public static final float DEFAULT_PITCH_DEGREES = 14.0f;
	public static final float MIN_PITCH_DEGREES = -85.0f;
	public static final float MAX_PITCH_DEGREES = 85.0f;
	public static final float MOUSE_DEGREES_PER_PIXEL = 0.22f;
	public static final float KEY_YAW_DEGREES_PER_TICK = 3.6f;
	public static final float KEY_PITCH_DEGREES_PER_TICK = 2.4f;
	public static final double ZOOM_EXPONENT_PER_NOTCH = 0.16;
	public static final double YAW_OMEGA = 4.5;
	public static final double PITCH_OMEGA = 4.5;
	public static final double RADIUS_OMEGA = 9.0;
	public static final float MAX_YAW_SPEED = 240.0f;
	public static final float MAX_PITCH_SPEED = 160.0f;
	public static final double MAX_RADIUS_SPEED = 30.0;

	private final DampedSpring yaw = new DampedSpring();
	private final DampedSpring pitch = new DampedSpring();
	private final DampedSpring radius = new DampedSpring();
	private float targetYaw;
	private float targetPitch = DEFAULT_PITCH_DEGREES;
	private double targetRadius = DEFAULT_RADIUS;
	private boolean initialized;

	public record Frame(
		double x,
		double y,
		double z,
		float yaw,
		float pitch,
		double distance
	) {
	}

	public boolean initialized() {
		return initialized;
	}

	public void reset() {
		yaw.reset();
		pitch.reset();
		radius.reset();
		targetYaw = 0.0f;
		targetPitch = DEFAULT_PITCH_DEGREES;
		targetRadius = DEFAULT_RADIUS;
		initialized = false;
	}

	public void initialize(float startYaw, float startPitch, double startDistance) {
		targetYaw = (float) DampedSpring.wrapDegrees(startYaw);
		targetPitch = clampPitch(startPitch);
		targetRadius = clampRadius(startDistance);
		yaw.snapAngle(targetYaw);
		pitch.snap(targetPitch);
		radius.snap(targetRadius);
		initialized = true;
	}

	/** Adds a manual orbit gesture in degrees. */
	public void addOrbit(float deltaYaw, float deltaPitch) {
		if (!initialized) return;
		if (Float.isFinite(deltaYaw)) {
			targetYaw = (float) DampedSpring.wrapDegrees(targetYaw + deltaYaw);
		}
		if (Float.isFinite(deltaPitch)) {
			targetPitch = clampPitch(targetPitch + deltaPitch);
		}
	}

	/** Programmatic target used by look_at; manual input can override it. */
	public void aimAt(float yaw, float pitch) {
		if (!initialized || !Float.isFinite(yaw) || !Float.isFinite(pitch)) return;
		targetYaw = (float) DampedSpring.wrapDegrees(yaw);
		targetPitch = clampPitch(pitch);
	}

	/** Positive scroll moves the camera closer, as in a map or orbit view. */
	public void addZoom(double notches) {
		if (!initialized || !Double.isFinite(notches) || notches == 0.0) return;
		targetRadius = clampRadius(
			targetRadius * Math.exp(-notches * ZOOM_EXPONENT_PER_NOTCH)
		);
	}

	public Frame step(double dt, Vec3 eye, Vec3 lookTarget) {
		if (!initialized) initialize(0.0f, DEFAULT_PITCH_DEGREES, DEFAULT_RADIUS);
		float seconds = Double.isFinite(dt)
			? Math.max(0.0f, Math.min(0.1f, (float) dt))
			: 0.0f;
		yaw.stepAngle(targetYaw, seconds, YAW_OMEGA, MAX_YAW_SPEED);
		pitch.step(targetPitch, seconds, PITCH_OMEGA, MAX_PITCH_SPEED);
		radius.step(targetRadius, seconds, RADIUS_OMEGA, MAX_RADIUS_SPEED);
		return frame(eye, lookTarget);
	}

	public Frame frame(Vec3 eye, Vec3 lookTarget) {
		double yawRadians = Math.toRadians(yaw.position());
		double pitchRadians = Math.toRadians(pitch.position());
		double horizontal = Math.cos(pitchRadians) * radius.position();
		double x = eye.x + Math.sin(yawRadians) * horizontal;
		double y = eye.y + Math.sin(pitchRadians) * radius.position();
		double z = eye.z - Math.cos(yawRadians) * horizontal;
		return new Frame(
			x,
			y,
			z,
			aimYaw(x, z, lookTarget.x, lookTarget.z),
			aimPitch(x, y, z, lookTarget.x, lookTarget.y, lookTarget.z),
			radius.position()
		);
	}

	public float yaw() {
		return (float) yaw.position();
	}

	public float pitch() {
		return (float) pitch.position();
	}

	public double distance() {
		return radius.position();
	}

	public float targetYaw() {
		return targetYaw;
	}

	public float targetPitch() {
		return targetPitch;
	}

	public float yawVelocity() {
		return (float) yaw.velocity();
	}

	public float pitchVelocity() {
		return (float) pitch.velocity();
	}

	/** Yaw from a camera position towards a world point, in Minecraft degrees. */
	public static float aimYaw(double fromX, double fromZ, double toX, double toZ) {
		return (float) Math.toDegrees(Math.atan2(-(toX - fromX), toZ - fromZ));
	}

	/** Pitch from a camera position towards a world point, positive is down. */
	public static float aimPitch(
		double fromX,
		double fromY,
		double fromZ,
		double toX,
		double toY,
		double toZ
	) {
		double dx = toX - fromX;
		double dy = toY - fromY;
		double dz = toZ - fromZ;
		double horizontal = Math.hypot(dx, dz);
		return (float) Math.toDegrees(Math.atan2(-dy, horizontal));
	}

	private static float clampPitch(float value) {
		return Math.max(MIN_PITCH_DEGREES, Math.min(MAX_PITCH_DEGREES, value));
	}

	private static double clampRadius(double value) {
		if (!Double.isFinite(value)) return DEFAULT_RADIUS;
		return Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, value));
	}
}
