package com.craftmate.body.mixin;

import com.craftmate.body.bridge.ThirdPersonCamera;
import com.mojang.blaze3d.vertex.PoseStack;
import net.minecraft.client.renderer.GameRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * The observation camera is a fixed orbit, so vanilla view bob and hurt tilt
 * would move the body away from the centre line. Both are first-person
 * feedback; the audience view gets a steady frame instead.
 */
@Mixin(GameRenderer.class)
public abstract class GameRendererMixin {
	@Inject(method = "bobView", at = @At("HEAD"), cancellable = true)
	private void craftmate$cancelViewBob(
		PoseStack poseStack,
		float partialTick,
		CallbackInfo callback
	) {
		if (ThirdPersonCamera.active()) callback.cancel();
	}

	@Inject(method = "bobHurt", at = @At("HEAD"), cancellable = true)
	private void craftmate$cancelHurtBob(
		PoseStack poseStack,
		float partialTick,
		CallbackInfo callback
	) {
		if (ThirdPersonCamera.active()) callback.cancel();
	}
}
