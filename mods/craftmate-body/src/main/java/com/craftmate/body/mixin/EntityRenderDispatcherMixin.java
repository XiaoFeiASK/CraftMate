package com.craftmate.body.mixin;

import com.craftmate.body.bridge.CameraController;
import com.mojang.blaze3d.platform.GlStateManager;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.PoseStack;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.entity.EntityRenderDispatcher;
import net.minecraft.world.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Keeps the local body visible when a third-person camera has been clipped
 * against a wall. Disabling depth for this one render pass is the smallest
 * reliable silhouette: it does not alter world geometry or lighting, and it
 * ends as soon as the camera has a clear line of sight again.
 */
@Mixin(EntityRenderDispatcher.class)
public abstract class EntityRenderDispatcherMixin {
	@Inject(
		method = "render(Lnet/minecraft/world/entity/Entity;DDDFFLcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/MultiBufferSource;I)V",
		at = @At("HEAD")
	)
	private void craftmate$beginVisibleThroughTerrain(
		Entity entity,
		double x,
		double y,
		double z,
		float yaw,
		float partialTick,
		PoseStack poseStack,
		MultiBufferSource buffers,
		int packedLight,
		CallbackInfo callback
	) {
		if (!CameraController.revealThroughTerrain(entity)) return;
		RenderSystem.disableDepthTest();
		RenderSystem.depthMask(false);
		RenderSystem.enableBlend();
		RenderSystem.blendFunc(
			GlStateManager.SourceFactor.SRC_ALPHA,
			GlStateManager.DestFactor.ONE_MINUS_SRC_ALPHA
		);
		RenderSystem.setShaderColor(1.0f, 1.0f, 1.0f, 0.72f);
	}

	@Inject(
		method = "render(Lnet/minecraft/world/entity/Entity;DDDFFLcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/MultiBufferSource;I)V",
		at = @At("RETURN")
	)
	private void craftmate$endVisibleThroughTerrain(
		Entity entity,
		double x,
		double y,
		double z,
		float yaw,
		float partialTick,
		PoseStack poseStack,
		MultiBufferSource buffers,
		int packedLight,
		CallbackInfo callback
	) {
		if (!CameraController.revealThroughTerrain(entity)) return;
		RenderSystem.setShaderColor(1.0f, 1.0f, 1.0f, 1.0f);
		RenderSystem.defaultBlendFunc();
		RenderSystem.disableBlend();
		RenderSystem.depthMask(true);
		RenderSystem.enableDepthTest();
	}
}
