package com.craftmate.body.bridge;

import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.Minecraft;
import net.minecraft.client.MouseHandler;
import org.lwjgl.glfw.GLFW;

/** Keyboard, scroll and drag input for the built-in third-person view. */
public final class OrbitalInput {
	private static boolean dragging;
	private static double lastDragX;
	private static double lastDragY;

	private OrbitalInput() {
	}

	public static void tick(Minecraft client) {
		if (!ThirdPersonCamera.active() || client.screen != null) {
			endDrag(client);
			return;
		}
		long window = client.getWindow().getWindow();
		float yaw = 0.0f;
		float pitch = 0.0f;
		if (InputConstants.isKeyDown(window, GLFW.GLFW_KEY_LEFT)) {
			yaw -= OrbitalRig.KEY_YAW_DEGREES_PER_TICK;
		}
		if (InputConstants.isKeyDown(window, GLFW.GLFW_KEY_RIGHT)) {
			yaw += OrbitalRig.KEY_YAW_DEGREES_PER_TICK;
		}
		if (InputConstants.isKeyDown(window, GLFW.GLFW_KEY_UP)) {
			pitch += OrbitalRig.KEY_PITCH_DEGREES_PER_TICK;
		}
		if (InputConstants.isKeyDown(window, GLFW.GLFW_KEY_DOWN)) {
			pitch -= OrbitalRig.KEY_PITCH_DEGREES_PER_TICK;
		}
		if (yaw != 0.0f || pitch != 0.0f) ThirdPersonCamera.addOrbit(yaw, pitch);
	}

	public static boolean beginDrag(Minecraft client) {
		if (!ThirdPersonCamera.active() || client.screen != null) return false;
		MouseHandler mouse = client.mouseHandler;
		if (mouse == null || !mouse.isMouseGrabbed()) return false;
		dragging = true;
		lastDragX = mouse.xpos();
		lastDragY = mouse.ypos();
		return true;
	}

	public static boolean dragTo(Minecraft client, double x, double y) {
		if (!dragging || !ThirdPersonCamera.active() || client.screen != null) {
			endDrag(client);
			return false;
		}
		double dx = x - lastDragX;
		double dy = y - lastDragY;
		lastDragX = x;
		lastDragY = y;
		if (dx != 0.0 || dy != 0.0) {
			ThirdPersonCamera.addOrbit(
				(float) (dx * OrbitalRig.MOUSE_DEGREES_PER_PIXEL),
				(float) (-dy * OrbitalRig.MOUSE_DEGREES_PER_PIXEL)
			);
		}
		return true;
	}

	public static boolean dragging() {
		return dragging;
	}

	public static void endDrag(Minecraft client) {
		if (!dragging) return;
		dragging = false;
		if (client.mouseHandler != null) client.mouseHandler.setIgnoreFirstMove();
	}

	public static void scroll(Minecraft client, double notches) {
		if (!ThirdPersonCamera.active() || client.screen != null) return;
		ThirdPersonCamera.addZoom(notches);
	}
}
