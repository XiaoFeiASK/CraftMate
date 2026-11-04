package com.craftmate.body;

import com.craftmate.body.bridge.BridgeClient;
import com.craftmate.body.stream.FrameServer;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.DeathScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.worldselection.CreateWorldScreen;
import net.minecraft.client.gui.screens.worldselection.SelectWorldScreen;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class CraftMateBodyClient implements ClientModInitializer {
	public static final String MOD_ID = "craftmate_body";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	private BridgeClient bridge;
	private FrameServer frames;
	private Screen acceptanceScreen;
	private String acceptanceScreenKey;
	private int acceptanceScreenTicks;
	private boolean acceptanceWorldRequested;
	private boolean acceptancePressed;

	@Override
	public void onInitializeClient() {
		bridge = BridgeClient.startDefault();
		frames = FrameServer.start(() -> Minecraft.getInstance().level != null);
		ClientTickEvents.END_CLIENT_TICK.register(client -> {
			bridge.tick(client);
			if (!acceptanceEnabled()) return;
			recoverAcceptanceDeath(client);
			tickAcceptance(client);
		});
		ClientLifecycleEvents.CLIENT_STOPPING.register(client -> {
			if (frames != null) frames.close();
			bridge.close();
		});
		LOGGER.info("CraftMate body initialized; bridge={}", BridgeClient.defaultUri());
	}

	private void tickAcceptance(net.minecraft.client.Minecraft client) {
		Screen screen = client.screen;
		if (screen == null) return;
		String screenKey = screen.getClass().getName() + "|" + screen.getTitle().getString();
		if (!screenKey.equals(acceptanceScreenKey)) {
			LOGGER.info("CraftMate acceptance: screen changed to {}", screen.getClass().getName());
			acceptanceScreen = screen;
			acceptanceScreenKey = screenKey;
			acceptanceScreenTicks = 0;
			acceptancePressed = false;
			return;
		}
		// A screen can remain the same object while its tick counter runs.
		// Press only once per screen instance; pressing every tick reopens the
		// same death screen immediately after respawn.
		if (acceptancePressed) return;
		int waitTicks = screen instanceof DeathScreen ? 20 : 5;
		if (++acceptanceScreenTicks < waitTicks) return;

		Button target =
			screen instanceof DeathScreen
				? button(screen, "重生", "Respawn")
				: screen instanceof TitleScreen
				? button(screen, "单人游戏", "Singleplayer")
				: screen instanceof SelectWorldScreen && !acceptanceWorldRequested
					? button(screen, "创建新的世界", "Create New World")
					: screen instanceof CreateWorldScreen
						? button(screen, "创建新的世界", "Create New World")
						: null;
		if (target == null || !target.active) return;

		acceptancePressed = true;
		if (screen instanceof SelectWorldScreen) acceptanceWorldRequested = true;
		LOGGER.info(
			"CraftMate acceptance: pressing '{}' on {}",
			target.getMessage().getString(),
			screen.getClass().getSimpleName()
		);
		class AcceptanceClick {
			static void press(Button button) {
				button.onPress(new net.minecraft.client.input.MouseButtonInfo(0, 0));
			}
		}
		AcceptanceClick.press(target);
	}

	private static Button button(Screen screen, String... labels) {
		return screen.children().stream()
			.filter(Button.class::isInstance)
			.map(Button.class::cast)
			.filter(button -> {
				String message = button.getMessage().getString();
				for (String label : labels) {
					if (label.equals(message)) return true;
				}
				return false;
			})
			.findFirst()
			.orElse(null);
	}

	/**
	 * A previous run can be saved while the body is dead. The normal death
	 * screen then has no safe respawn point and can put the body back in the
	 * same lethal spot. This path is local-acceptance only: it clears the
	 * saved death state and puts the player on the configured test spawn.
	 */
	private static void recoverAcceptanceDeath(Minecraft client) {
		if (client.player == null || client.level == null || client.player.isAlive()) return;
		double x = Double.parseDouble(System.getProperty("craftmate.acceptance.spawn.x", "16.5"));
		double y = Double.parseDouble(System.getProperty("craftmate.acceptance.spawn.y", "80.0"));
		double z = Double.parseDouble(System.getProperty("craftmate.acceptance.spawn.z", "160.5"));
		client.player.setHealth(client.player.getMaxHealth());
		client.player.getFoodData().setFoodLevel(20);
		client.player.setPos(x, y, z);
		client.setScreen(null);
		LOGGER.info("CraftMate acceptance: recovered dead body to {}, {}, {}", x, y, z);
	}

	private static boolean acceptanceEnabled() {
		return Boolean.getBoolean("craftmate.autoclick.singleplayer")
			|| "1".equals(System.getenv("CRAFTMATE_ACCEPTANCE"));
	}
}
