package com.craftmate.body.mixin;

import com.craftmate.body.bridge.CameraController;
import net.minecraft.client.Camera;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.phys.Vec3;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Camera.class)
public abstract class CameraMixin {
	@Shadow
	private boolean detached;

	@Shadow
	protected abstract void setRotation(float yRot, float xRot);

	@Shadow
	protected abstract void setPosition(Vec3 position);

	@Shadow
	public abstract Vec3 getPosition();

	@Inject(method = "setup", at = @At("RETURN"))
	private void craftmate$applyDisplayRotation(
		BlockGetter level,
		Entity entity,
		boolean detachedCamera,
		boolean mirrored,
		float partialTick,
		CallbackInfo callback
	) {
		if (mirrored || !(entity instanceof LocalPlayer player)) return;
		float[] pose = CameraController.framePose(player);
		if (pose != null) setRotation(pose[0], pose[1]);
		/*
		 * In 1.20.1 `detached` is the same flag as vanilla third person,
		 * while the fourth argument is the mirrored-camera toggle. The old
		 * guard returned whenever `detached` was true, so the rendered pose
		 * was never controlled in third person at all.
		 */
		if (!detached) return;
		Vec3 framed = CameraController.framePosition(
			level,
			entity,
			player,
			partialTick,
			true,
			getPosition()
		);
		if (framed != null) setPosition(framed);
	}
}
