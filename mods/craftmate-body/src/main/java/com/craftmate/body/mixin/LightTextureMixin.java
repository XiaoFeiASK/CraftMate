package com.craftmate.body.mixin;

import com.craftmate.body.bridge.AudienceLight;
import com.mojang.blaze3d.platform.NativeImage;
import net.minecraft.client.renderer.LightTexture;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Applies the audience-only brightness curve just before the lightmap is
 * uploaded to the GPU. Vanilla rebuilt the pixels immediately above this
 * point, so changing them at TAIL would be overwritten by the next upload.
 */
@Mixin(LightTexture.class)
public abstract class LightTextureMixin {
	@Shadow
	private NativeImage lightPixels;

	@Inject(
		method = "updateLightTexture",
		at = @At(
			value = "INVOKE",
			target = "Lnet/minecraft/client/renderer/texture/DynamicTexture;upload()V",
			shift = At.Shift.BEFORE
		)
	)
	private void craftmate$liftViewerLightmap(float partialTick, CallbackInfo callback) {
		if (!AudienceLight.enabled()) return;
		for (int y = 0; y < lightPixels.getHeight(); y++) {
			for (int x = 0; x < lightPixels.getWidth(); x++) {
				lightPixels.setPixelRGBA(
					x,
					y,
					AudienceLight.liftPixel(lightPixels.getPixelRGBA(x, y))
				);
			}
		}
	}
}
