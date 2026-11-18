package com.craftmate.body.mixin;

import com.craftmate.body.bridge.ThirdPersonCamera;
import net.minecraft.client.Camera;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.BlockGetter;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(Camera.class)
public abstract class CameraMixin {
	@Shadow
	protected abstract void setRotation(float yRot, float xRot);

	@Shadow
	protected abstract void setPosition(double x, double y, double z);

	@Inject(method = "setup", at = @At("RETURN"))
	private void craftmate$applyDisplayRotation(
		BlockGetter level,
		Entity entity,
		boolean detachedCamera,
		boolean mirrored,
		float partialTick,
		CallbackInfo callback
	) {
		if (mirrored || !detachedCamera || !(entity instanceof LocalPlayer player)) return;
		ThirdPersonCamera.Frame frame = ThirdPersonCamera.frame(
			level,
			entity,
			player,
			partialTick
		);
		if (frame == null) return;
		setRotation(frame.yaw(), frame.pitch());
		setPosition(frame.x(), frame.y(), frame.z());
	}

	@Inject(method = "getMaxZoom", at = @At("HEAD"), cancellable = true)
	private void craftmate$bypassVanillaCameraCollision(
		double requestedDistance,
		CallbackInfoReturnable<Double> callback
	) {
		if (ThirdPersonCamera.active()) {
			callback.setReturnValue(ThirdPersonCamera.cameraDistance());
		}
	}
}
