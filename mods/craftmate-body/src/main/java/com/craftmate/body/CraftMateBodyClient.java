package com.craftmate.body;

import com.craftmate.body.bridge.BridgeClient;
import com.craftmate.body.bridge.CameraController;
import com.craftmate.body.bridge.GameActions;
import com.craftmate.body.stream.FrameServer;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.minecraft.client.Minecraft;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class CraftMateBodyClient implements ClientModInitializer {
	public static final String MOD_ID = "craftmate_body";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	private BridgeClient bridge;
	private FrameServer frames;

	@Override
	public void onInitializeClient() {
		bridge = BridgeClient.startDefault();
		frames = FrameServer.start(() -> Minecraft.getInstance().level != null);
		ClientTickEvents.END_CLIENT_TICK.register(client -> {
			bridge.tick(client);
			CameraController.worldChanged(client);
			if (!bridge.agentControlled()) {
				// The body can outlive a dead orchestrator. Refuse to keep
				// walking or mining after control is gone, even if the last
				// task never received its terminal result.
				CameraController.reset(client);
				GameActions.releaseInputs(client);
			}
		});
		ClientLifecycleEvents.CLIENT_STOPPING.register(client -> {
			if (frames != null) frames.close();
			bridge.close();
		});
		LOGGER.info("CraftMate body initialized; bridge={}", BridgeClient.defaultUri());
	}
}
