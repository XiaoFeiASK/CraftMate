package com.craftmate.body.mixin;

import com.craftmate.body.bridge.ThirdPersonCamera;
import com.mojang.blaze3d.platform.GlStateManager;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.PoseStack;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.entity.EntityRenderDispatcher;
import net.minecraft.world.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Keeps the fully opaque local body visible when a solid block covers it.
 * The block faces are blended over this pass by LevelRendererMixin, which
 * reads like looking through the block rather than a transparent character.
 */
@Mixin(EntityRenderDispatcher.class)
public abstract class EntityRenderDispatcherMixin {
	@Unique
	private boolean craftmate$revealingBody;

	@Inject(
		method = "render(Lnet/minecraft/world/entity/Entity;DDDFFLcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/MultiBufferSource;I)V",
		at = @At("HEAD")
	)
	private void craftmate$beginRevealBody(
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
		if (!ThirdPersonCamera.revealBody(entity)) return;
		craftmate$revealingBody = true;
		RenderSystem.disableDepthTest();
		RenderSystem.depthMask(false);
		RenderSystem.enableBlend();
		RenderSystem.blendFunc(
			GlStateManager.SourceFactor.SRC_ALPHA,
			GlStateManager.DestFactor.ONE_MINUS_SRC_ALPHA
		);
		RenderSystem.setShaderColor(1.0f, 1.0f, 1.0f, 1.0f);
	}

	@Inject(
		method = "render(Lnet/minecraft/world/entity/Entity;DDDFFLcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/MultiBufferSource;I)V",
		at = @At("RETURN")
	)
	private void craftmate$endRevealBody(
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
		if (!craftmate$revealingBody) return;
		craftmate$revealingBody = false;
		RenderSystem.setShaderColor(1.0f, 1.0f, 1.0f, 1.0f);
		RenderSystem.defaultBlendFunc();
		RenderSystem.disableBlend();
		RenderSystem.depthMask(true);
		RenderSystem.enableDepthTest();
	}
}
