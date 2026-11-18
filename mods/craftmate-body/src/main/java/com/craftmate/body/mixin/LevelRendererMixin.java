package com.craftmate.body.mixin;

import com.craftmate.body.render.OccluderOverlay;
import com.mojang.blaze3d.vertex.PoseStack;
import net.minecraft.client.Camera;
import net.minecraft.client.renderer.GameRenderer;
import net.minecraft.client.renderer.LevelRenderer;
import net.minecraft.client.renderer.LightTexture;
import org.joml.Matrix4f;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(LevelRenderer.class)
public abstract class LevelRendererMixin {
	@Inject(method = "renderLevel", at = @At("TAIL"))
	private void craftmate$renderOccluderOverlay(
		PoseStack poseStack,
		float partialTick,
		long finishNanos,
		boolean renderBlockOutline,
		Camera camera,
		GameRenderer gameRenderer,
		LightTexture lightTexture,
		Matrix4f projectionMatrix,
		CallbackInfo callback
	) {
		OccluderOverlay.render(camera, partialTick);
	}
}
