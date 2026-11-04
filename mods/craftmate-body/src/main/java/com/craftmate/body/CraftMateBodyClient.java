package com.craftmate.body;

import com.craftmate.body.bridge.BridgeClient;
import com.craftmate.body.stream.FrameServer;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.Button;
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
	private int acceptanceScreenTicks;
	private boolean acceptanceWorldRequested;

	@Override
	public void onInitializeClient() {
		bridge = BridgeClient.startDefault();
		frames = FrameServer.start(() -> Minecraft.getInstance().level != null);
		ClientTickEvents.END_CLIENT_TICK.register(client -> {
			bridge.tick(client);
			if (acceptanceEnabled() && client.level == null) tickAcceptance(client);
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
		if (screen != acceptanceScreen) {
			LOGGER.info("CraftMate acceptance: screen changed to {}", screen.getClass().getName());
			acceptanceScreen = screen;
			acceptanceScreenTicks = 0;
			return;
		}
		if (++acceptanceScreenTicks < 5) return;

		Button target =
			screen instanceof TitleScreen
				? button(screen, "单人游戏", "Singleplayer")
				: screen instanceof SelectWorldScreen && !acceptanceWorldRequested
					? button(screen, "创建新的世界", "Create New World")
					: screen instanceof CreateWorldScreen
						? button(screen, "创建新的世界", "Create New World")
						: null;
		if (target == null) return;

		acceptanceScreenTicks = 0;
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

	private static boolean acceptanceEnabled() {
		return Boolean.getBoolean("craftmate.autoclick.singleplayer")
			|| "1".equals(System.getenv("CRAFTMATE_ACCEPTANCE"));
	}
}
