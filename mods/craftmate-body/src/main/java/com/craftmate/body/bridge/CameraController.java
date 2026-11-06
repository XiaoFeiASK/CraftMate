package com.craftmate.body.bridge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;

/**
 * Owns the rotation shown by the rendered camera. The player's real rotation
 * stays available for Minecraft's interaction checks and movement, while the
 * audience-facing camera follows an explicit intent through a bounded slew.
 */
public final class CameraController {
	/**
	 * Spring limits, in degrees per second. Yaw may lead pitch because a
	 * horizontal look is the common case; pitch stays slower so scanning a
	 * hillside does not feel like a headless camera. The per-frame cap keeps
	 * a long render stall (or a debugger pause) from consuming a second of
	 * backlog in one frame, which is exactly the jump the audience sees.
	 */
	private static final float MAX_YAW_SPEED_DEGREES = 220.0f;
	private static final float MAX_PITCH_SPEED_DEGREES = 150.0f;
	private static final float MAX_ACCELERATION_DEGREES = 1_200.0f;
	private static final float MAX_FRAME_STEP_DEGREES = 26.0f;
	private static final float DEFAULT_FRAME_SECONDS = 1.0f / 60.0f;
	private static final float MAX_FRAME_SECONDS = 0.1f;
	private static final float RELEASE_TOLERANCE = 0.35f;

	private static boolean active;
	private static boolean releasing;
	private static boolean retained;
	private static float displayYaw;
	private static float displayPitch;
	private static float desiredYaw;
	private static float desiredPitch;
	private static float yawVelocity;
	private static float pitchVelocity;
	private static long lastFrameNanos;

	private CameraController() {
	}

	/** Puts the camera on a world point using the player's actual eye position. */
	public static void steerTo(LocalPlayer player, Vec3 target) {
		Vec3 direction = target.subtract(player.getEyePosition());
		if (direction.lengthSqr() < 1.0e-6) return;
		steerTo(
			player,
			(float) Math.toDegrees(Math.atan2(-direction.x, direction.z)),
			(float) Math.toDegrees(-Math.asin(direction.y / direction.length()))
		);
	}

	/** Keeps the current rendered pose while the body aims elsewhere. */
	public static void hold(LocalPlayer player) {
		begin(player);
		retained = false;
		desiredYaw = displayYaw;
		desiredPitch = displayPitch;
		releasing = false;
	}

	/** Steers only the heading, leaving the pitch intentionally stable. */
	public static void steerHeading(LocalPlayer player, float yaw, float pitch) {
		begin(player);
		retained = false;
		desiredYaw = yaw;
		desiredPitch = Mth.clamp(pitch, -90.0f, 90.0f);
		releasing = false;
	}

	private static void steerTo(LocalPlayer player, float yaw, float pitch) {
		begin(player);
		retained = false;
		desiredYaw = yaw;
		desiredPitch = Mth.clamp(pitch, -90.0f, 90.0f);
		releasing = false;
	}

	/** True once the rendered pose has held the requested target closely. */
	public static boolean settled(float toleranceDegrees) {
		return active
			&& Math.abs(Mth.wrapDegrees(desiredYaw - displayYaw)) <= toleranceDegrees
			&& Math.abs(desiredPitch - displayPitch) <= toleranceDegrees
			&& Math.abs(yawVelocity) <= 4.0f
			&& Math.abs(pitchVelocity) <= 4.0f;
	}

	/**
	 * Smoothly returns to the player's view. Render frames keep applying the
	 * controller until the offset is negligible, so ending an action never
	 * produces a one-frame camera jump.
	 */
	public static void release() {
		if (!active || retained) return;
		releasing = true;
	}

	/** Keeps an explicit observation pose after its task has completed. */
	public static void retain() {
		if (!active) return;
		retained = true;
		releasing = false;
	}

	public static boolean retained() {
		return retained;
	}

	/** Immediate reset for human takeover, disconnect, or a changed world. */
	public static void reset(Minecraft client) {
		active = false;
		releasing = false;
		retained = false;
		yawVelocity = 0;
		pitchVelocity = 0;
		lastFrameNanos = 0;
		LocalPlayer player = client.player;
		if (player != null) {
			displayYaw = player.getViewYRot(1.0f);
			displayPitch = player.getViewXRot(1.0f);
			desiredYaw = displayYaw;
			desiredPitch = displayPitch;
		}
	}

	public static float displayYaw(LocalPlayer player) {
		return active ? displayYaw : player.getViewYRot(1.0f);
	}

	public static float displayPitch(LocalPlayer player) {
		return active ? displayPitch : player.getViewXRot(1.0f);
	}

	/**
	 * Called from the camera setup hook once per rendered frame. Returns null
	 * when vanilla should own the camera rotation.
	 */
	public static float[] framePose(LocalPlayer player) {
		if (!active) return null;
		long now = System.nanoTime();
		float dt = lastFrameNanos == 0
			? DEFAULT_FRAME_SECONDS
			: Math.min(MAX_FRAME_SECONDS, (now - lastFrameNanos) / 1_000_000_000.0f);
		lastFrameNanos = now;

		if (releasing) {
			desiredYaw = player.getViewYRot(1.0f);
			desiredPitch = player.getViewXRot(1.0f);
		}
		float yawError = Mth.wrapDegrees(desiredYaw - displayYaw);
		float pitchError = desiredPitch - displayPitch;
		yawVelocity = approach(yawVelocity, yawError, dt, MAX_YAW_SPEED_DEGREES);
		pitchVelocity = approach(pitchVelocity, pitchError, dt, MAX_PITCH_SPEED_DEGREES);
		displayYaw = Mth.wrapDegrees(
			displayYaw +
				Mth.clamp(yawVelocity * dt, -MAX_FRAME_STEP_DEGREES, MAX_FRAME_STEP_DEGREES)
		);
		displayPitch = Mth.clamp(
			displayPitch +
				Mth.clamp(pitchVelocity * dt, -MAX_FRAME_STEP_DEGREES, MAX_FRAME_STEP_DEGREES),
			-90.0f,
			90.0f
		);

		if (
			releasing
				&& Math.abs(Mth.wrapDegrees(desiredYaw - displayYaw)) <= RELEASE_TOLERANCE
				&& Math.abs(desiredPitch - displayPitch) <= RELEASE_TOLERANCE
				&& Math.abs(yawVelocity) <= 2.0f
				&& Math.abs(pitchVelocity) <= 2.0f
		) {
			active = false;
			return null;
		}
		return new float[] { displayYaw, displayPitch };
	}

	/**
	 * A new world or respawn replaces the entity. Drop any held pose instead
	 * of interpolating from a viewpoint in the previous world.
	 */
	public static void worldChanged(Minecraft client) {
		if (active || retained || releasing) reset(client);
	}

	private static void begin(LocalPlayer player) {
		if (active) return;
		displayYaw = player.getViewYRot(1.0f);
		displayPitch = player.getViewXRot(1.0f);
		desiredYaw = displayYaw;
		desiredPitch = displayPitch;
		yawVelocity = 0;
		pitchVelocity = 0;
		lastFrameNanos = 0;
		releasing = false;
		active = true;
	}

	/**
	 * Critically damped angular approach. Speed and acceleration are both
	 * bounded so a low-frame-rate recovery cannot consume a backlog in one
	 * frame and look like a snap.
	 */
	private static float approach(
		float velocity,
		float error,
		float dt,
		float maxSpeedDegrees
	) {
		float desiredVelocity = Mth.clamp(
			error * 14.0f,
			-maxSpeedDegrees,
			maxSpeedDegrees
		);
		float maxDelta = MAX_ACCELERATION_DEGREES * dt;
		return velocity + Mth.clamp(desiredVelocity - velocity, -maxDelta, maxDelta);
	}
}
