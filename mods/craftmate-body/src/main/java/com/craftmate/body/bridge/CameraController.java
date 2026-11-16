package com.craftmate.body.bridge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Owns the rotation shown by the rendered camera. The body's real rotation is
 * used for movement and block orientation, while the audience-facing camera
 * follows an explicit intent through a bounded slew.
 */
public final class CameraController {
	/**
	 * Spring limits, in degrees per second. Yaw may lead pitch because a
	 * horizontal look is the common case; pitch stays slower so scanning a
	 * hillside does not feel like a headless camera. The per-frame cap keeps
	 * a long render stall (or a debugger pause) from consuming a second of
	 * backlog in one frame, which is exactly the jump the audience sees.
	 */
	private static final float MAX_YAW_SPEED_DEGREES = 90.0f;
	private static final float MAX_PITCH_SPEED_DEGREES = 60.0f;
	private static final float MAX_ACCELERATION_DEGREES = 420.0f;
	private static final float MAX_FRAME_STEP_DEGREES = 6.0f;
	private static final float DEFAULT_FRAME_SECONDS = 1.0f / 60.0f;
	private static final float MAX_FRAME_SECONDS = 0.1f;
	private static final float RELEASE_TOLERANCE = 0.35f;
	private static final float YAW_GAIN = 6.0f;
	private static final float PITCH_GAIN = 6.0f;

	private static boolean active;
	private static boolean releasing;
	private static boolean retained;
	private static float displayYaw;
	private static float displayPitch;
	private static float desiredYaw;
	private static float desiredPitch;
	private static float lookPitch;
	private static float yawVelocity;
	private static float pitchVelocity;
	private static boolean holdPose;
	private static long lastFrameNanos;
	private static Object lastLevel;
	private static Object lastPlayer;
	private static Object lastBodyPlayer;
	private static float lastBodyYaw;
	private static float lastBodyPitch;
	private static final CameraSpring POSITION = new CameraSpring();
	private static long lastPositionNanos;
	/** A continuous plan owns the camera across its child tasks. */
	private static int planHolds;
	private static boolean positionSettled = true;

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
		lookPitch = displayPitch;
		holdPose = true;
		releasing = false;
	}

	/** Steers only the heading, leaving the pitch intentionally stable. */
	public static void steerHeading(LocalPlayer player, float yaw, float pitch) {
		begin(player);
		retained = false;
		holdPose = false;
		desiredYaw = yaw;
		lookPitch = Mth.clamp(pitch, -90.0f, 90.0f);
		releasing = false;
	}

	private static void steerTo(LocalPlayer player, float yaw, float pitch) {
		begin(player);
		retained = false;
		holdPose = false;
		desiredYaw = yaw;
		lookPitch = Mth.clamp(pitch, -90.0f, 90.0f);
		releasing = false;
	}

	/** True once the rendered pose has held the requested target closely. */
	public static boolean settled(LocalPlayer player, float toleranceDegrees) {
		float expectedPitch = targetPitch(player);
		return active
			&& Math.abs(Mth.wrapDegrees(desiredYaw - displayYaw)) <= toleranceDegrees
			&& Math.abs(expectedPitch - displayPitch) <= toleranceDegrees
			&& Math.abs(yawVelocity) <= 4.0f
			&& Math.abs(pitchVelocity) <= 4.0f;
	}

	/**
	 * Smoothly returns to the player's view. Render frames keep applying the
	 * controller until the offset is negligible, so ending an action never
	 * produces a one-frame camera jump.
	 */
	public static void release() {
		if (!active || retained || planHolds > 0) return;
		releasing = true;
		positionSettled = false;
	}

	public static void holdForPlan() {
		planHolds++;
	}

	public static void releasePlanHold() {
		if (planHolds > 0) planHolds--;
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
		holdPose = false;
		lastFrameNanos = 0;
		lastPositionNanos = 0;
		POSITION.reset();
		planHolds = 0;
		positionSettled = true;
		lastLevel = client.level;
		lastPlayer = client.player;
		LocalPlayer player = client.player;
		if (player != null) {
			displayYaw = player.getViewYRot(1.0f);
			displayPitch = player.getViewXRot(1.0f);
			desiredYaw = displayYaw;
			desiredPitch = displayPitch;
			lookPitch = displayPitch;
			lastBodyPlayer = player;
			lastBodyYaw = displayYaw;
			lastBodyPitch = displayPitch;
		}
	}

	/**
	 * Third-person camera position. Vanilla has already placed the camera
	 * behind the body at four blocks; this replaces only that third-person
	 * pose with the adaptive shoulder framing. First person is left untouched.
	 */
	public static Vec3 framePosition(
		BlockGetter level,
		Entity entity,
		LocalPlayer player,
		float partialTick,
		boolean thirdPerson,
		Vec3 vanillaPosition
	) {
		if (!thirdPerson) {
			positionSettled = true;
			return null;
		}
		if (!active || entity != player || player.isSleeping()) {
			return null;
		}
		long now = System.nanoTime();
		float dt = lastPositionNanos == 0
			? DEFAULT_FRAME_SECONDS
			: Math.min(MAX_FRAME_SECONDS, (now - lastPositionNanos) / 1_000_000_000.0f);
		lastPositionNanos = now;

		Vec3 anchor = entity.getPosition(partialTick).add(
			0,
			entity.getBbHeight() * CameraSpring.TORSO_HEIGHT_FRACTION,
			0
		);
		Vec3 desired = new Vec3(vanillaPosition.x, vanillaPosition.y, vanillaPosition.z);
		if (!releasing) {
			Vec3 movement = entity.getDeltaMovement();
			CameraSpring.Target follow = CameraSpring.followTarget(
				anchor.x,
				anchor.y,
				anchor.z,
				displayYaw,
				displayPitch,
				movement.x,
				movement.z
			);
			desired = new Vec3(follow.x(), follow.y(), follow.z());
			HitResult hit = level.clip(new ClipContext(
				anchor,
				desired,
				ClipContext.Block.VISUAL,
				ClipContext.Fluid.NONE,
				entity
			));
			if (hit.getType() != HitResult.Type.MISS) {
				CameraSpring.Target clipped = CameraSpring.clipped(
					anchor.x,
					anchor.y,
					anchor.z,
					follow,
					hit.getLocation().distanceTo(anchor)
				);
				desired = new Vec3(clipped.x(), clipped.y(), clipped.z());
			}
		}
		POSITION.step(
			new CameraSpring.Target(desired.x, desired.y, desired.z),
			dt
		);
		if (releasing && POSITION.distanceTo(
			vanillaPosition.x,
			vanillaPosition.y,
			vanillaPosition.z
		) <= 0.06) {
			positionSettled = true;
		} else {
			positionSettled = false;
		}
		return new Vec3(POSITION.x(), POSITION.y(), POSITION.z());
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
		}
		desiredPitch = targetPitch(player);
		float yawError = Mth.wrapDegrees(desiredYaw - displayYaw);
		float pitchError = desiredPitch - displayPitch;
		yawVelocity = approach(
			yawVelocity,
			yawError,
			dt,
			MAX_YAW_SPEED_DEGREES,
			YAW_GAIN
		);
		pitchVelocity = approach(
			pitchVelocity,
			pitchError,
			dt,
			MAX_PITCH_SPEED_DEGREES,
			PITCH_GAIN
		);
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
				&& positionSettled
		) {
			active = false;
			return null;
		}
		return new float[] { displayYaw, displayPitch };
	}

	/**
	 * A new world or respawn replaces the entity. Drop any held pose instead
	 * of interpolating from a viewpoint in the previous world. This runs once
	 * per client tick, so it must compare identities: resetting whenever the
	 * controller is active snapped the rendered camera back to the body's
	 * aimed rotation every tick and defeated the spring entirely.
	 */
	public static void worldChanged(Minecraft client) {
		if (client.level == lastLevel && client.player == lastPlayer) return;
		reset(client);
	}

	/**
	 * Remembers the body pose from before the current client tick runs. Mining
	 * turns the real player instantly so vanilla selects the right block, but
	 * the rendered camera must start from the pose the audience last saw, not
	 * from that already-snapped body rotation.
	 */
	public static void observe(Minecraft client) {
		LocalPlayer player = client.player;
		if (player == null) return;
		lastBodyPlayer = player;
		lastBodyYaw = player.getViewYRot(1.0f);
		lastBodyPitch = player.getViewXRot(1.0f);
	}

	private static void begin(LocalPlayer player) {
		if (active) return;
		boolean sameBody = lastBodyPlayer == player;
		displayYaw = sameBody ? lastBodyYaw : player.getViewYRot(1.0f);
		displayPitch = sameBody ? lastBodyPitch : player.getViewXRot(1.0f);
		desiredYaw = displayYaw;
		desiredPitch = displayPitch;
		lookPitch = displayPitch;
		holdPose = false;
		yawVelocity = 0;
		pitchVelocity = 0;
		lastFrameNanos = 0;
		releasing = false;
		active = true;
	}

	private static float targetPitch(LocalPlayer player) {
		if (holdPose) return displayPitch;
		if (releasing) return player.getViewXRot(1.0f);
		return CameraSpring.framingPitch(lookPitch, player.getViewXRot(1.0f));
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
		float maxSpeedDegrees,
		float gain
	) {
		float desiredVelocity = Mth.clamp(
			error * gain,
			-maxSpeedDegrees,
			maxSpeedDegrees
		);
		float maxDelta = MAX_ACCELERATION_DEGREES * dt;
		return velocity + Mth.clamp(desiredVelocity - velocity, -maxDelta, maxDelta);
	}
}
