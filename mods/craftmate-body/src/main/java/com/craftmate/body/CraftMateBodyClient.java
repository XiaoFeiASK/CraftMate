package com.craftmate.body;

import com.craftmate.body.bridge.BridgeClient;
import com.craftmate.body.bridge.CameraController;
import com.craftmate.body.bridge.GameActions;
import com.craftmate.body.stream.FrameServer;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.GameRules;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class CraftMateBodyClient implements ClientModInitializer {
	public static final String MOD_ID = "craftmate_body";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	private BridgeClient bridge;
	private FrameServer frames;
	private MinecraftServer keepInventoryServer;
	private boolean agentOwnedLastTick;

	@Override
	public void onInitializeClient() {
		bridge = BridgeClient.startDefault();
		frames = FrameServer.start(() -> Minecraft.getInstance().level != null);
		ClientTickEvents.END_CLIENT_TICK.register(client -> {
			// A background autonomous body must keep ticking when the operator
			// switches to the dashboard or another window. Vanilla pauses the
			// integrated server on focus loss, which looks exactly like the
			// agent freezing after one command and also expires every bridge
			// deadline. `options` is not constructed yet during entrypoint
			// init, so this must run from the tick loop.
			if (client.options != null && client.options.pauseOnLostFocus) {
				client.options.pauseOnLostFocus = false;
			}
			ensureViewerBrightness(client);
			ensureKeepInventory(client);
			bridge.tick(client);
			CameraController.worldChanged(client);
			boolean agentControlled = bridge.agentControlled();
			if (agentOwnedLastTick && !agentControlled) {
				// The body can outlive a dead orchestrator. Refuse to keep
				// walking or mining after control is gone, even if the last
				// task never received its terminal result. Hand the keys back
				// once, preserving anything the human is physically holding;
				// releasing them every tick made WASD stutter until the key
				// was pressed again.
				CameraController.reset(client);
				GameActions.stopLocally(client, true);
			}
			agentOwnedLastTick = agentControlled;
		});
		ClientLifecycleEvents.CLIENT_STOPPING.register(client -> {
			if (frames != null) frames.close();
			bridge.close();
		});
		LOGGER.info("CraftMate body initialized; bridge={}", BridgeClient.defaultUri());
	}

	/**
	 * The body sees the world with normal survival lighting, but the person
	 * watching should not stare at a black cave. Vanilla's brightest gamma
	 * setting is a display preference only and does not change light-level
	 * gameplay checks; the lightmap mixin handles the remaining darkness.
	 */
	private void ensureViewerBrightness(Minecraft client) {
		if (client.options == null) return;
		if (client.options.gamma().get() < 1.0) {
			client.options.gamma().set(1.0);
			LOGGER.info("CraftMate set viewer gamma to 1.0");
		}
	}

	/**
	 * The autonomous body is allowed to take risks during long survival runs.
	 * Keep its inventory across deaths in singleplayer so a failed ravine or
	 * creeper encounter does not erase hours of progression. The rule is set
	 * once per integrated server instance; dedicated servers are untouched.
	 */
	private void ensureKeepInventory(Minecraft client) {
		MinecraftServer server = client.getSingleplayerServer();
		if (server == null || server == keepInventoryServer) return;
		GameRules rules = server.getGameRules();
		if (!rules.getBoolean(GameRules.RULE_KEEPINVENTORY)) {
			rules.getRule(GameRules.RULE_KEEPINVENTORY).set(true, server);
			LOGGER.info("CraftMate enabled keepInventory for the integrated server");
		}
		keepInventoryServer = server;
	}
}
