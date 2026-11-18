package com.craftmate.body.bridge;

import java.util.List;
import net.minecraft.client.CameraType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * The built-in third-person-back view. It is not a separate camera mode:
 * vanilla F5/mouse-button switching still selects first person, front view or
 * this orbital back view.
 */
public final class ThirdPersonCamera {
	private static final float DEFAULT_FRAME_SECONDS = 1.0f / 60.0f;
	private static final float MAX_FRAME_SECONDS = 0.1f;
	private static final double ANCHOR_HORIZONTAL_OMEGA = 8.5;
	private static final double ANCHOR_VERTICAL_OMEGA = 11.0;
	private static final double ANCHOR_MAX_SPEED = 28.0;
	private static final double ANCHOR_TELEPORT_DISTANCE = 16.0;
	private static final float OCCLUSION_FADE_SECONDS = 0.12f;
	private static final float OCCLUSION_ALPHA = 0.28f;
	private static final int OCCLUDER_CAP = 24;
	private static final long MANUAL_HOLD_NANOS = 2_000_000_000L;

	private static final OrbitalRig RIG = new OrbitalRig();
	private static final DampedSpring anchorX = new DampedSpring();
	private static final DampedSpring anchorY = new DampedSpring();
	private static final DampedSpring anchorZ = new DampedSpring();

	private static boolean ready;
	private static boolean lookActive;
	private static long lastFrameNanos;
	private static long manualUntilNanos;
	private static Object lastLevel;
	private static Object lastPlayer;
	private static List<BlockPos> occluders = List.of();
	private static float occlusionFade;
	private static float displayedYaw;
	private static float displayedPitch;

	public record Frame(double x, double y, double z, float yaw, float pitch, double distance) {
	}

	private ThirdPersonCamera() {
	}

	/** True only while vanilla is rendering the third-person back view. */
	public static boolean active() {
		Minecraft client = Minecraft.getInstance();
		return client.options != null &&
			client.player != null &&
			client.options.getCameraType() == CameraType.THIRD_PERSON_BACK &&
			!client.player.isSleeping() &&
			!client.player.isDeadOrDying() &&
			!client.player.isSpectator();
	}

	public static void worldChanged(Minecraft client) {
		if (client.level == lastLevel && client.player == lastPlayer) return;
		ready = false;
		lookActive = false;
		lastFrameNanos = 0;
		manualUntilNanos = 0;
		RIG.reset();
		anchorX.reset();
		anchorY.reset();
		anchorZ.reset();
		occluders = List.of();
		occlusionFade = 0.0f;
		displayedYaw = 0.0f;
		displayedPitch = 0.0f;
		lastLevel = client.level;
		lastPlayer = client.player;
	}

	public static void addOrbit(float deltaYaw, float deltaPitch) {
		RIG.addOrbit(deltaYaw, deltaPitch);
		lookActive = false;
		manualUntilNanos = System.nanoTime() + MANUAL_HOLD_NANOS;
	}

	public static void addZoom(double notches) {
		RIG.addZoom(notches);
		manualUntilNanos = System.nanoTime() + MANUAL_HOLD_NANOS;
	}

	/** Programmatic look_at support. Manual drag clears this ownership. */
	public static void steerTo(Vec3 target) {
		if (System.nanoTime() < manualUntilNanos) return;
		Minecraft client = Minecraft.getInstance();
		LocalPlayer player = client.player;
		if (player == null || target == null) return;
		Vec3 direction = target.subtract(player.getEyePosition());
		if (direction.lengthSqr() < 1.0e-6) return;
		float yaw = OrbitalRig.aimYaw(0.0, 0.0, direction.x, direction.z);
		float pitch = OrbitalRig.aimPitch(0.0, 0.0, 0.0, direction.x, direction.y, direction.z);
		RIG.aimAt(yaw, pitch);
		lookActive = true;
	}

	public static void clearLookTarget() {
		lookActive = false;
	}

	public static boolean lookSettled(float toleranceDegrees) {
		if (!active() || System.nanoTime() < manualUntilNanos) return true;
		return lookActive &&
			Math.abs(DampedSpring.wrapDegrees(RIG.targetYaw() - RIG.yaw())) <=
				toleranceDegrees &&
			Math.abs(RIG.targetPitch() - RIG.pitch()) <= toleranceDegrees &&
			Math.abs(RIG.yawVelocity()) <= 4.0f &&
			Math.abs(RIG.pitchVelocity()) <= 4.0f;
	}

	public static float displayYaw(LocalPlayer player) {
		return active() && ready ? displayedYaw : player.getViewYRot(1.0f);
	}

	public static float displayPitch(LocalPlayer player) {
		return active() && ready ? displayedPitch : player.getViewXRot(1.0f);
	}

	public static double cameraDistance() {
		return RIG.initialized() ? RIG.distance() : OrbitalRig.DEFAULT_RADIUS;
	}

	public static Frame frame(
		BlockGetter level,
		Entity entity,
		LocalPlayer player,
		float partialTick
	) {
		if (!active() || entity != player) return null;
		ensureReady(player, partialTick);
		long now = System.nanoTime();
		float dt = lastFrameNanos == 0
			? DEFAULT_FRAME_SECONDS
			: Math.min(
				MAX_FRAME_SECONDS,
				(now - lastFrameNanos) / 1_000_000_000.0f
			);
		lastFrameNanos = now;

		Vec3 eye = player.getEyePosition(partialTick);
		Vec3 smoothedEye = stepAnchor(eye, dt);
		Vec3 bodyCentre = player.getPosition(partialTick).add(
			0.0,
			player.getBbHeight() * 0.5,
			0.0
		);
		OrbitalRig.Frame orbit = RIG.step(dt, smoothedEye, bodyCentre);
		displayedYaw = orbit.yaw();
		displayedPitch = orbit.pitch();
		probeOcclusion(level, entity, orbit, dt);
		return new Frame(
			orbit.x(),
			orbit.y(),
			orbit.z(),
			orbit.yaw(),
			orbit.pitch(),
			orbit.distance()
		);
	}

	public static boolean revealBody(Entity entity) {
		Minecraft client = Minecraft.getInstance();
		return overlayVisible() &&
			entity == client.player &&
			client.player != null;
	}

	public static boolean overlayVisible() {
		return active() && occlusionFade > 0.001f;
	}

	public static List<BlockPos> occluders() {
		return occluders;
	}

	public static float overlayAlpha() {
		return occlusionFade * OCCLUSION_ALPHA;
	}

	private static void ensureReady(LocalPlayer player, float partialTick) {
		if (ready) return;
		RIG.initialize(
			player.getYRot(),
			OrbitalRig.DEFAULT_PITCH_DEGREES,
			OrbitalRig.DEFAULT_RADIUS
		);
		Vec3 eye = player.getEyePosition(partialTick);
		anchorX.snap(eye.x);
		anchorY.snap(eye.y);
		anchorZ.snap(eye.z);
		occluders = List.of();
		occlusionFade = 0.0f;
		displayedYaw = player.getYRot();
		displayedPitch = OrbitalRig.DEFAULT_PITCH_DEGREES;
		ready = true;
	}

	private static Vec3 stepAnchor(Vec3 target, float dt) {
		if (
			!anchorX.initialized() ||
				Math.abs(target.x - anchorX.position()) > ANCHOR_TELEPORT_DISTANCE ||
				Math.abs(target.y - anchorY.position()) > ANCHOR_TELEPORT_DISTANCE ||
				Math.abs(target.z - anchorZ.position()) > ANCHOR_TELEPORT_DISTANCE
		) {
			anchorX.snap(target.x);
			anchorY.snap(target.y);
			anchorZ.snap(target.z);
			return target;
		}
		anchorX.step(target.x, dt, ANCHOR_HORIZONTAL_OMEGA, ANCHOR_MAX_SPEED);
		anchorY.step(target.y, dt, ANCHOR_VERTICAL_OMEGA, ANCHOR_MAX_SPEED);
		anchorZ.step(target.z, dt, ANCHOR_HORIZONTAL_OMEGA, ANCHOR_MAX_SPEED);
		return new Vec3(anchorX.position(), anchorY.position(), anchorZ.position());
	}

	private static void probeOcclusion(
		BlockGetter level,
		Entity entity,
		OrbitalRig.Frame frame,
		float dt
	) {
		AABB body = entity.getBoundingBox().deflate(0.08, 0.04, 0.08);
		Vec3 camera = new Vec3(frame.x(), frame.y(), frame.z());
		OcclusionProbe.Result result = OcclusionProbe.probe(
			camera,
			body,
			pos -> CameraProbe.isOpaqueSolid(level, pos),
			OCCLUDER_CAP,
			BlockPos.containing(camera)
		);
		if (result.occluded()) occluders = result.blocks();
		float step = Math.max(0.0f, Math.min(0.1f, dt)) / OCCLUSION_FADE_SECONDS;
		if (result.occluded()) {
			occlusionFade = Math.min(1.0f, occlusionFade + step);
		} else {
			occlusionFade = Math.max(0.0f, occlusionFade - step);
			if (occlusionFade <= 0.001f) {
				occlusionFade = 0.0f;
				occluders = List.of();
			}
		}
	}
}
