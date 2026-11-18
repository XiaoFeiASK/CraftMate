package com.craftmate.body.mixin;

import com.craftmate.body.bridge.OrbitalInput;
import com.craftmate.body.bridge.ThirdPersonCamera;
import net.minecraft.client.Minecraft;
import net.minecraft.client.MouseHandler;
import org.lwjgl.glfw.GLFW;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(MouseHandler.class)
public abstract class MouseHandlerMixin {
	@Inject(method = "onPress", at = @At("HEAD"), cancellable = true)
	private void craftmate$orbitalPress(
		long window,
		int button,
		int action,
		int modifiers,
		CallbackInfo callback
	) {
		if (!ThirdPersonCamera.active() || button != GLFW.GLFW_MOUSE_BUTTON_LEFT) return;
		Minecraft client = Minecraft.getInstance();
		if (client.screen != null) return;
		if (action == GLFW.GLFW_PRESS) {
			if (OrbitalInput.beginDrag(client)) callback.cancel();
		} else if (action == GLFW.GLFW_RELEASE && OrbitalInput.dragging()) {
			OrbitalInput.endDrag(client);
			callback.cancel();
		}
	}

	@Inject(method = "onMove", at = @At("HEAD"), cancellable = true)
	private void craftmate$orbitalMove(
		long window,
		double x,
		double y,
		CallbackInfo callback
	) {
		if (!OrbitalInput.dragging()) return;
		if (OrbitalInput.dragTo(Minecraft.getInstance(), x, y)) callback.cancel();
	}

	@Inject(method = "onScroll", at = @At("HEAD"), cancellable = true)
	private void craftmate$orbitalScroll(
		long window,
		double xOffset,
		double yOffset,
		CallbackInfo callback
	) {
		if (!ThirdPersonCamera.active()) return;
		Minecraft client = Minecraft.getInstance();
		if (client.screen != null) return;
		OrbitalInput.scroll(client, yOffset);
		callback.cancel();
	}
}
