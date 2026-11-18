package com.craftmate.body.bridge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.phys.Vec3;

/**
 * Compatibility facade for the agent's look_at action. The rendered
 * third-person camera lives in {@link ThirdPersonCamera}; this class only
 * turns an explicit look target into orbital angles and reports when the
 * spring has settled.
 */
public final class CameraController {
	private CameraController() {
	}

	public static void steerTo(LocalPlayer player, Vec3 target) {
		ThirdPersonCamera.steerTo(target);
	}

	public static void clearLookTarget() {
		ThirdPersonCamera.clearLookTarget();
	}

	public static boolean settled(LocalPlayer player, float toleranceDegrees) {
		return ThirdPersonCamera.lookSettled(toleranceDegrees);
	}

	public static void reset(Minecraft client) {
		ThirdPersonCamera.clearLookTarget();
	}

	public static float displayYaw(LocalPlayer player) {
		return ThirdPersonCamera.displayYaw(player);
	}

	public static float displayPitch(LocalPlayer player) {
		return ThirdPersonCamera.displayPitch(player);
	}

}
