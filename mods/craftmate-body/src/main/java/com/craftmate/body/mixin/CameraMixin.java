package com.craftmate.body.mixin;

import com.craftmate.body.bridge.CameraController;
import net.minecraft.client.Camera;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.BlockGetter;
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

	@Inject(method = "setup", at = @At("RETURN"))
	private void craftmate$applyDisplayRotation(
		BlockGetter level,
		Entity entity,
		boolean detachedCamera,
		boolean thirdPerson,
		float partialTick,
		CallbackInfo callback
	) {
		if (detached || !(entity instanceof LocalPlayer player)) return;
		float[] pose = CameraController.framePose(player);
		if (pose != null) setRotation(pose[0], pose[1]);
	}
}
