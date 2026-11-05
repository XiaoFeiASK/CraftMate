package com.craftmate.body.bridge;

import com.craftmate.body.CraftMateBodyClient;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.regex.Pattern;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.DeathScreen;
import net.minecraft.client.gui.screens.InBedChatScreen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.client.gui.screens.recipebook.RecipeCollection;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.player.KeyboardInput;
import net.minecraft.network.protocol.game.ServerboundPlayerCommandPacket;
import net.minecraft.network.protocol.game.ServerboundClientCommandPacket;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.attribute.BedRule;
import net.minecraft.world.attribute.EnvironmentAttributes;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.StackedItemContents;
import net.minecraft.world.item.BedItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.AbstractCraftingMenu;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.crafting.CraftingRecipe;
import net.minecraft.world.item.crafting.PlacementInfo;
import net.minecraft.world.item.crafting.RecipeHolder;
import net.minecraft.world.item.crafting.RecipeManager;
import net.minecraft.world.item.crafting.ShapedRecipe;
import net.minecraft.world.item.crafting.display.RecipeDisplay;
import net.minecraft.world.item.crafting.display.RecipeDisplayEntry;
import net.minecraft.world.item.crafting.display.RecipeDisplayId;
import net.minecraft.world.item.crafting.display.ShapedCraftingRecipeDisplay;
import net.minecraft.world.item.crafting.display.ShapelessCraftingRecipeDisplay;
import net.minecraft.world.item.crafting.display.SlotDisplay;
import net.minecraft.world.item.crafting.display.SlotDisplayContext;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BaseContainerBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Commands are state machines advanced by the client thread. A task remains
 * accepted/running until the world shows observable progress or it fails.
 */
public final class GameActions {
	private static final List<String> SKILLS = List.of(
		"goto", "look_at", "mine_block", "chop_tree", "collect_items", "craft", "deposit", "say", "wait", "attack",
		"equip", "eat", "use_block", "place_block", "sleep"
	);
	private static final List<String> CAPABILITIES = List.of(
		"sensor", "move", "mine", "container", "attack", "use", "build", "camera", "hud"
	);
	/**
	 * Trunks and leaves can hide a nearby log from a single eye ray. Keep the
	 * visible search local, but let the approach loop walk to a log that is
	 * inside the normal gameplay area. The destroy loop still requires an
	 * unobstructed face before it starts breaking, so this cannot mine through
	 * terrain.
	 */
	private static final int TARGET_SEARCH_RADIUS = 48;
	/** Keep entity observation at least as wide as the hunt decision radius. */
	/**
	 * Matches the contract's maximum attack radius. A 40-block observation
	 * radius hid an animal 40.3 blocks away from a hunt whose own search
	 * window was still legal, so the planner could never offer a target.
	 */
	private static final int ENTITY_SEARCH_RADIUS = 48;
	private static final int COLLECT_SEARCH_RADIUS = 16;
	private static final int COLLECT_STALL_TICKS = 20 * 4;
	private static final int CONTAINER_SEARCH_RADIUS = 16;
	private static final int CONTAINER_TRANSFER_TIMEOUT = 20 * 5;
	private static final int CONTAINER_TOTAL_TIMEOUT = 20 * 60;
	/** Let one predicted menu update settle long enough to be rolled back. */
	private static final int CONTAINER_STABLE_TICKS = 10;
	private static final int CRAFT_SEARCH_RADIUS = 16;
	private static final int CRAFT_MENU_TIMEOUT = 20;
	private static final int CRAFT_GRID_TIMEOUT = 20 * 3;
	private static final int CRAFT_RESULT_TIMEOUT = 20 * 3;
	private static final int CRAFT_STABLE_TICKS = 5;
	private static final int CRAFT_TOTAL_TIMEOUT = 20 * 60;
	private static final int SLEEP_SEARCH_RADIUS = 16;
	private static final int SLEEP_CONFIRM_TICKS = 20 * 3;
	/** Observe the wake-up when the server can skip the night. */
	private static final int SLEEP_OBSERVE_TICKS = 20 * 30;
	/** Time updates can trail the wake-up packet by a tick or two. */
	private static final int SLEEP_WAKE_GRACE_TICKS = 20 * 3;
	private static final int ATTACK_SEARCH_RADIUS = 24;
	private static final int PATH_STEP_UP = 1;
	private static final int PATH_STEP_DOWN = 1;
	private static final Map<String, Task> TASKS = new ConcurrentHashMap<>();
	private static int clientTick;
	private static Reflexes reflexes;
	private static volatile boolean miningInputHeld;
	private static final RespawnRetry RESPAWN_RETRY = new RespawnRetry();
	/**
	 * Per-session evidence that this body actually slept through a night.
	 * A daytime snapshot alone is not proof: the world may have started in
	 * daylight, or the player may have skipped the night another way.
	 */
	private static volatile boolean sleptThroughNight;
	/**
	 * Session facts for the food stage. An eaten stack disappears, so the
	 * planner cannot infer "food was obtained and eaten" from the inventory
	 * alone. These are observations from this body, not planner assumptions.
	 */
	private static volatile boolean foodAcquired;
	private static volatile boolean foodConsumed;
	/** True once this session crafted a crafting table. */
	private static volatile boolean craftingTableCrafted;
	/** True once this session placed a crafting table in the world. */
	private static volatile boolean craftingTablePlaced;
	/**
	 * The last crafting table this body placed. A table is a durable world
	 * station, but the snapshot only observes a 17-block cube. Remembering the
	 * exact position lets a later craft walk back to it instead of declaring
	 * that the table no longer exists.
	 */
	private static volatile BlockPos placedCraftingTable;

	private GameActions() {
	}

	static List<String> skills() {
		return SKILLS;
	}

	static List<String> capabilities() {
		return CAPABILITIES;
	}

	static int tick(Minecraft client) {
		return client.level == null ? 0 : client.level.getGameTime() > Integer.MAX_VALUE
			? Integer.MAX_VALUE
			: (int) client.level.getGameTime();
	}

	/** Reports the state in which commands may safely enter the game loop. */
	static boolean ready(Minecraft client) {
		return client.level != null
			&& client.player != null
			&& client.gameMode != null
			&& client.getConnection() != null;
	}

	/** Builds a bounded semantic observation; no client GUI objects escape. */
	static JsonObject snapshot(Minecraft client) {
		JsonObject world = new JsonObject();
		LocalPlayer player = client.player;
		boolean inWorld = client.level != null && player != null && client.gameMode != null;
		world.addProperty("inWorld", inWorld);
		if (!inWorld) {
			// A new world is a new survival run. Leaving the world clears the
			// session facts so a fresh acceptance world cannot inherit a meal,
			// a night skip, or food acquired in a previous run.
			foodAcquired = false;
			foodConsumed = false;
			sleptThroughNight = false;
			placedCraftingTable = null;
			craftingTableCrafted = false;
			craftingTablePlaced = false;
			return world;
		}
		world.addProperty("world", client.level.dimension().identifier().toString());
		JsonObject position = new JsonObject();
		position.addProperty("x", round(player.getX()));
		position.addProperty("y", round(player.getY()));
		position.addProperty("z", round(player.getZ()));
		world.add("position", position);
		world.addProperty("yaw", round(player.getYRot()));
		world.addProperty("pitch", round(player.getXRot()));
		world.addProperty("cameraYaw", round(CameraController.displayYaw(player)));
		world.addProperty("cameraPitch", round(CameraController.displayPitch(player)));
		world.addProperty("health", round(player.getHealth()));
		world.addProperty("food", player.getFoodData().getFoodLevel());
		if (hasFood(player)) foodAcquired = true;
		world.addProperty("foodAcquired", foodAcquired);
		world.addProperty("foodConsumed", foodConsumed);
		world.addProperty("craftingTableCrafted", craftingTableCrafted);
		world.addProperty("craftingTablePlaced", craftingTablePlaced);
		world.addProperty(
			"craftingTableNearby",
			(placedCraftingTable != null && client.level.getBlockState(placedCraftingTable).is(Blocks.CRAFTING_TABLE))
				|| nearbyBlocksContain(client, player, Blocks.CRAFTING_TABLE)
		);
		if (placedCraftingTable != null) {
			JsonObject table = new JsonObject();
			table.addProperty("x", placedCraftingTable.getX());
			table.addProperty("y", placedCraftingTable.getY());
			table.addProperty("z", placedCraftingTable.getZ());
			world.add("craftingTable", table);
		}
		world.addProperty("onGround", player.onGround());
		world.addProperty("fallDistance", round(player.fallDistance));
		world.addProperty("verticalVelocity", round(player.getDeltaMovement().y));
		long dayTime = client.level.getDayTime();
		world.addProperty("timeOfDay", (int) Math.floorMod(dayTime, 24_000L));
		world.addProperty("day", (int) Math.floorDiv(dayTime, 24_000L));
		world.addProperty("sleeping", player.isSleeping());
		world.addProperty("sleptThroughNight", sleptThroughNight);
		world.addProperty("screenOpen", client.screen != null);
		BlockPos feet = player.blockPosition();
		BlockState floor = client.level.getBlockState(feet.below());
		world.addProperty(
			"floor",
			floor.isAir() ? null : BuiltInRegistries.BLOCK.getKey(floor.getBlock()).toString()
		);
		BlockPos spawn = client.level.getRespawnData().pos();
		JsonObject spawnPoint = new JsonObject();
		spawnPoint.addProperty("x", spawn.getX() + 0.5);
		spawnPoint.addProperty("y", spawn.getY());
		spawnPoint.addProperty("z", spawn.getZ() + 0.5);
		world.add("spawn", spawnPoint);
		ItemStack selected = player.getInventory().getSelectedItem();
		world.addProperty(
			"selectedItem",
			selected.isEmpty() ? null : BuiltInRegistries.ITEM.getKey(selected.getItem()).toString()
		);
		JsonArray hotbar = new JsonArray();
		for (int slot = 0; slot < 9; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (stack.isEmpty()) continue;
			JsonObject entry = new JsonObject();
			entry.addProperty("slot", slot);
			entry.addProperty("item", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
			entry.addProperty("count", stack.getCount());
			hotbar.add(entry);
		}
		world.add("hotbar", hotbar);
		world.add("inventory", inventory(client, player));
		JsonArray entities = new JsonArray();
		client.level.getEntitiesOfClass(Entity.class, player.getBoundingBox().inflate(ENTITY_SEARCH_RADIUS)).stream()
			.filter(entity -> entity != player && entity.isAlive())
			.sorted((left, right) -> Double.compare(left.distanceToSqr(player), right.distanceToSqr(player)))
			.limit(32)
			.forEach(entity -> {
				JsonObject entry = new JsonObject();
				entry.addProperty("name", entity.getName().getString());
				entry.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString());
				entry.addProperty("distance", round(Math.sqrt(entity.distanceToSqr(player))));
				entities.add(entry);
			});
		world.add("entities", entities);
		world.add("nearbyBlocks", nearbyBlocks(client, player));
		world.add("reachableBlock", reachableBlock(client, player));
		return world;
	}

	/**
	 * One block the body can currently aim at. The planner must not treat
	 * every block within eight cells as a mining target: a stone block below
	 * the floor is nearby but has no exposed face. A null here is an honest
	 * "nothing reachable", not a reason to invent a target.
	 */
	private static JsonObject reachableBlock(Minecraft client, LocalPlayer player) {
		HitResult raw = player.raycastHitResult(1.0f, player);
		BlockHitResult hit = raw.getType() == HitResult.Type.BLOCK && raw instanceof BlockHitResult blockHit
			? blockHit
			: null;
		if (hit == null) return null;
		BlockPos pos = hit.getBlockPos();
		BlockState state = client.level.getBlockState(pos);
		if (state.isAir()) return null;
		if (!player.isWithinBlockInteractionRange(pos, 0.0)) return null;
		JsonObject entry = new JsonObject();
		entry.addProperty("id", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
		entry.addProperty("x", pos.getX());
		entry.addProperty("y", pos.getY());
		entry.addProperty("z", pos.getZ());
		return entry;
	}

	/**
	 * Every non-empty inventory slot, including armor and offhand. The hotbar
	 * alone cannot answer "do I have a pickaxe and food?" once the backpack is
	 * full, so the planner gets the same stack view the player sees.
	 */
	private static JsonArray inventory(Minecraft client, LocalPlayer player) {
		JsonArray entries = new JsonArray();
		Inventory inventory = player.getInventory();
		for (int slot = 0; slot <= InventorySnapshot.LAST_SLOT; slot++) {
			ItemStack stack = inventory.getItem(slot);
			if (stack.isEmpty()) continue;
			String section = InventorySnapshot.section(slot);
			if (section == null) continue;
			JsonObject entry = new JsonObject();
			entry.addProperty("section", section);
			entry.addProperty("slot", slot);
			entry.addProperty("item", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
			entry.addProperty("count", stack.getCount());
			if (stack.isDamageableItem()) {
				entry.addProperty(
					"durability",
					InventorySnapshot.remainingDurability(stack.getDamageValue(), stack.getMaxDamage())
				);
				entry.addProperty("maxDurability", stack.getMaxDamage());
			}
			entries.add(entry);
		}
		return entries;
	}

	private static boolean hasFood(LocalPlayer player) {
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!stack.isEmpty() && stack.get(DataComponents.FOOD) != null) return true;
		}
		return false;
	}

	static void showStatus(Minecraft client, String text) {
		if (client.gui == null) return;
		client.gui.getChat().addMessage(Component.literal("[CraftMate] " + text));
	}

	/** Advances accepted task state machines once per client tick. */
	static void startFrame() {
		clientTick++;
		TASKS.values().forEach(task -> task.age++);
	}

	/** Bound once by the bridge so reflexes and results share one wire path. */
	static void bindSender(Consumer<JsonObject> send) {
		reflexes = new Reflexes(send);
	}

	/**
	 * Registers and validates a command without producing any wire result.
	 * The caller acknowledges accepted commands before task progress or an
	 * immediate result can be emitted.
	 */
	static StartDecision start(Minecraft client, String id, String op, JsonObject args, Consumer<JsonObject> send) {
		if (TASKS.containsKey(id)) {
			return StartDecision.rejected("E_BUSY", "duplicate task id");
		}
		if (blocksOnPlayerScreen(client)) {
			return StartDecision.rejected("E_BUSY", "the player has a screen open");
		}
		Task task;
		try {
			task = switch (op) {
				case "wait" -> new WaitTask(id, integer(args, "ticks", 1));
				case "say" -> new SayTask(id, required(args, "text"));
				case "look_at" -> new LookTask(id, args);
				case "goto" -> new GotoTask(id, args);
				case "mine_block" -> new MineTask(id, args);
				case "chop_tree" -> new MineTask(id, args, true);
				case "collect_items" -> new CollectTask(
					id,
					optional(args, "item"),
					integer(args, "count", 1)
				);
				case "craft" -> new CraftTask(
					id,
					required(args, "item"),
					integer(args, "count", 1)
				);
				case "deposit" -> new DepositTask(
					id,
					optional(args, "item"),
					optionalBlockPos(args, "container")
				);
				case "attack" -> new AttackTask(
					id,
					required(args, "target"),
					stringList(args, "targets"),
					integer(args, "count", 1),
					number(args, "radius", ATTACK_SEARCH_RADIUS),
					args.has("lethal") && args.get("lethal").getAsBoolean(),
					args.has("collect") && args.get("collect").getAsBoolean()
				);
				case "equip" -> new EquipTask(id, required(args, "item"));
				case "eat" -> new EatTask(id, optional(args, "item"));
				case "use_block" -> new UseBlockTask(id, optional(args, "block"));
				case "place_block" -> new PlaceTask(id, required(args, "block"), integer(args, "count", 1));
				case "sleep" -> new SleepTask(id);
				default -> null;
			};
		} catch (RuntimeException error) {
			return StartDecision.rejected("E_PRECONDITION", "invalid args for " + op + ": " + message(error));
		}
		if (task == null) {
			return StartDecision.rejected("E_UNKNOWN_OP", "unsupported skill " + op);
		}
		task.send = send;
		if (!task.validate(client)) {
			return StartDecision.rejected("E_PRECONDITION", task.validationError);
		}
		TASKS.put(id, task);
		showStatus(client, op + " · " + id.substring(0, Math.min(8, id.length())));
		return StartDecision.accept();
	}

	/**
	 * A human opening chat, inventory or the pause menu is not something the
	 * agent may dismiss: forcibly closing the screen made E and Escape appear
	 * broken. Tasks wait until the player finishes and the screen closes
	 * naturally.
	 */
	private static boolean blocksOnPlayerScreen(Minecraft client) {
		return client.screen != null && client.level != null;
	}

	/**
	 * Called after command validation and once per client tick. It also
	 * accepts immediate actions and reports their observable result.
	 */
	static void tickTasks(Minecraft client) {
		if (client.level == null || client.player == null || client.gameMode == null) {
			for (Task task : TASKS.values()) {
				if (task.started) finish(task.id, "failed", "E_PRECONDITION", "player is not in a world");
			}
			return;
		}
		for (Task task : new ArrayList<>(TASKS.values())) {
			if (task.started) continue;
			task.started = true;
			try {
				task.start(client);
			} catch (Throwable error) {
				finish(task.id, "failed", "E_INTERNAL", message(error));
			}
		}
	}

	static void cancel(Minecraft client, String taskId, String commandId) {
		Task task = taskId == null ? null : TASKS.remove(taskId);
		// The command id is only a last resort: a body task is never keyed by it,
		// so this branch exists for frames that carry nothing else.
		if (task == null && commandId != null) task = TASKS.remove(commandId);
		if (task != null) {
			task.stop(client);
			task.send.accept(result(task.id, "cancelled", "E_CANCELLED", "cancelled by orchestrator"));
			return;
		}
		if (taskId == null && commandId == null) stopLocally(client);
	}

	static void stopLocally(Minecraft client) {
		LocalPlayer player = client.player;
		if (player != null && player.input != null) player.input.tick();
		releaseInputs(client);
		MultiPlayerGameMode mode = client.gameMode;
		if (mode != null && mode.isDestroying()) {
			mode.stopDestroyBlock();
			mode.tick();
		}
		for (String id : new ArrayList<>(TASKS.keySet())) {
			Task task = TASKS.remove(id);
			if (task != null) task.stop(client);
		}
	}

	static void update(Minecraft client, boolean agentControlled) {
		respawnIfDead(client, agentControlled);
		tickTasks(client);
		// Reflexes run before skills so a danger detected this tick stops the
		// input a task would otherwise press again, and so a task that is
		// already underway cannot finish the tick by walking into lava.
		if (reflexes == null || !reflexes.tick(client)) {
			advanceTasks(client);
		}
	}

	/**
	 * A dead body can never plan its way out of the death screen. This runs
	 * only while the agent owns control, only on the actual DeathScreen, and
	 * sends the vanilla perform-respawn packet. A lost packet is retried after
	 * a bounded delay; it never clicks GUI buttons or closes an operator's
	 * screen.
	 */
	private static void respawnIfDead(Minecraft client, boolean agentControlled) {
		LocalPlayer player = client.player;
		boolean deathScreen = client.screen instanceof DeathScreen;
		boolean canRespawn =
			player != null && player.getHealth() <= 0f && client.getConnection() != null;
		if (!RESPAWN_RETRY.shouldRequest(
			agentControlled,
			deathScreen,
			canRespawn,
			System.currentTimeMillis()
		)) return;
		client.getConnection().send(
			new ServerboundClientCommandPacket(
				ServerboundClientCommandPacket.Action.PERFORM_RESPAWN
			)
		);
		showStatus(client, "正在重生");
	}

	private static void advanceTasks(Minecraft client) {
		// A screen the player opened pauses the agent instead of being closed.
		// Tasks that need a menu mark it with `keepScreen` and keep working.
		boolean keepScreen = TASKS.values().stream()
			.anyMatch(task -> task.started && task.keepScreen(client));
		if (blocksOnPlayerScreen(client) && !keepScreen) {
			releaseWalkInput(client);
			releaseMiningInput(client);
			return;
		}
		for (Task task : new ArrayList<>(TASKS.values())) {
			if (!task.started || !TASKS.containsKey(task.id)) continue;
			try {
				task.tick(client);
			} catch (Throwable error) {
				finish(task.id, "failed", "E_INTERNAL", message(error));
			}
		}
		if (TASKS.isEmpty() && !CameraController.retained()) CameraController.release();
	}

	private static void finish(String id, String status, String code, String detail) {
		Task task = TASKS.remove(id);
		if (task == null) return;
		task.stop(Minecraft.getInstance());
		if (task.send != null) task.send.accept(result(id, status, code, detail));
	}

	private static void finish(
		String id, String status, String code, String detail, JsonObject data
	) {
		Task task = TASKS.remove(id);
		if (task == null) return;
		task.stop(Minecraft.getInstance());
		if (task.send != null) task.send.accept(result(id, status, code, detail, data));
	}

	private static JsonObject result(String id, String status, String code, String detail) {
		return BridgeMessages.result(id, status, code, detail);
	}

	private static JsonObject result(
		String id, String status, String code, String detail, JsonObject data
	) {
		return BridgeMessages.result(id, status, code, detail, data);
	}

	private static JsonObject progress(String id, String phase, int done, int total) {
		return BridgeMessages.progress(id, phase, done, total);
	}

	/**
	 * Mirrors the orchestrator's outcome shape: a short summary, one confirmed
	 * change per block, and the problem that stopped us. The console can show
	 * this without understanding which skill produced it.
	 */
	private static JsonObject outcome(String summary, JsonArray mined, String problem) {
		JsonObject outcome = new JsonObject();
		outcome.addProperty("summary", summary);
		JsonArray changes = new JsonArray();
		for (var item : mined) {
			JsonObject block = item.getAsJsonObject();
			JsonObject change = new JsonObject();
			change.addProperty("kind", "block_broken");
			change.addProperty("detail", block.get("block").getAsString());
			change.add("position", block.get("position"));
			changes.add(change);
		}
		outcome.add("changes", changes);
		if (problem != null) outcome.addProperty("problem", problem);
		return outcome;
	}

	private static String required(JsonObject args, String name) {
		String value = optional(args, name);
		if (value == null || value.isBlank()) throw new IllegalArgumentException("missing " + name);
		return value;
	}

	private static String optional(JsonObject args, String name) {
		return args.has(name) && args.get(name).isJsonPrimitive() ? args.get(name).getAsString() : null;
	}

	private static int integer(JsonObject args, String name, int fallback) {
		return args.has(name) ? args.get(name).getAsInt() : fallback;
	}

	private static double number(JsonObject value, String name) {
		var found = value.get(name);
		if (found == null || !found.isJsonPrimitive() || !found.getAsJsonPrimitive().isNumber()) {
			throw new IllegalArgumentException("missing number " + name);
		}
		return found.getAsDouble();
	}

	private static double number(JsonObject value, String name, double fallback) {
		return value.has(name) ? number(value, name) : fallback;
	}

	private static List<String> stringList(JsonObject args, String name) {
		if (!args.has(name) || !args.get(name).isJsonArray()) return List.of();
		List<String> values = new ArrayList<>();
		for (var entry : args.getAsJsonArray(name)) {
			if (!entry.isJsonPrimitive()) throw new IllegalArgumentException("invalid entry in " + name);
			values.add(entry.getAsString());
		}
		return values;
	}

	private static BlockPos optionalBlockPos(JsonObject args, String name) {
		if (!args.has(name) || args.get(name).isJsonNull()) return null;
		JsonObject point = args.getAsJsonObject(name);
		if (point == null) throw new IllegalArgumentException("invalid point " + name);
		return BlockPos.containing(number(point, "x"), number(point, "y"), number(point, "z"));
	}

	private static String message(Throwable error) {
		String message = error.getMessage();
		return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
	}

	record StartDecision(boolean accepted, String code, String detail) {
		static StartDecision accept() {
			return new StartDecision(true, null, null);
		}

		static StartDecision rejected(String code, String detail) {
			return new StartDecision(false, code, detail);
		}
	}

	private abstract static class Task {
		final String id;
		Consumer<JsonObject> send;
		boolean started;
		int age;
		String validationError = "";

		Task(String id) {
			this.id = id;
		}

		boolean validate(Minecraft client) {
			if (client.level == null || client.player == null || client.gameMode == null) {
				validationError = "player is not in a world";
				return false;
			}
			return true;
		}

		abstract void start(Minecraft client);
		abstract void tick(Minecraft client);

		void stop(Minecraft client) {
		}

		/**
		 * A task that needs a screen (for example the container it just
		 * opened) must keep it across the normal "close blocking GUI" pass.
		 */
		boolean keepScreen(Minecraft client) {
			return false;
		}
	}

	private static final class WaitTask extends Task {
		private final int total;
		private int remaining;

		WaitTask(String id, int total) {
			super(id);
			this.total = total;
			this.remaining = total;
		}

		@Override
		void start(Minecraft client) {
			send.accept(progress(id, "waiting", 0, total));
		}

		@Override
		void tick(Minecraft client) {
			remaining--;
			if (remaining <= 0) finish(id, "completed", null, null);
		}
	}

	private static final class SayTask extends Task {
		private final String text;

		SayTask(String id, String text) {
			super(id);
			this.text = text;
		}

		@Override
		void start(Minecraft client) {
			// The public chat is the observable game action. Do not fall back
			// to a local-only message: that would falsely claim speech on the
			// server.
			client.player.connection.sendChat(text);
			finish(id, "completed", null, null);
		}

		@Override
		void tick(Minecraft client) {
		}
	}

	private static final class LookTask extends Task {
		private final Vec3 target;
		private final String targetName;
		private int settledTicks;

		LookTask(String id, JsonObject args) {
			super(id);
			this.targetName = optional(args, "player");
			this.target = targetName == null ? vec(args) : null;
		}

		@Override
		boolean validate(Minecraft client) {
			if (!super.validate(client)) return false;
			if (targetName != null && namedPlayer(client, targetName) == null) {
				validationError = "no visible player named " + targetName;
				return false;
			}
			return true;
		}

		@Override
		void start(Minecraft client) {
			LocalPlayer player = client.player;
			Vec3 look = resolveLookTarget(client);
			if (look == null) {
				finish(id, "failed", "E_PRECONDITION", "look target is no longer available");
				return;
			}
			CameraController.steerTo(player, look);
			send.accept(progress(id, "turning", 0, 1));
		}

		@Override
		void tick(Minecraft client) {
			Vec3 look = resolveLookTarget(client);
			if (look == null) {
				finish(id, "failed", "E_WORLD_CHANGED", "look target left the visible area");
				return;
			}
			CameraController.steerTo(client.player, look);
			settledTicks = CameraController.settled(2.0f) ? settledTicks + 1 : 0;
			if (settledTicks >= 3) {
				CameraController.retain();
				finish(id, "completed", null, null);
			} else if (age > 20 * 4) {
				finish(id, "failed", "E_TIMEOUT", "camera did not settle on the target");
			}
		}

		private Vec3 resolveLookTarget(Minecraft client) {
			if (targetName == null) return target;
			AbstractClientPlayer player = namedPlayer(client, targetName);
			return player == null ? null : player.getEyePosition();
		}

		private static AbstractClientPlayer namedPlayer(Minecraft client, String name) {
			return client.level.players().stream()
				.filter(candidate -> candidate.getName().getString().equalsIgnoreCase(name))
				.findFirst()
				.orElse(null);
		}
	}

	private static final class GotoTask extends Task {
		private static final int STUCK_TICKS = 20 * 3;
		private static final int MAX_REPLANS = 3;
		private static final int REPLAN_COOLDOWN_TICKS = 10;
		private static final double ARRIVE_DISTANCE = 0.75;
		private static final double ARRIVE_HEIGHT = 1.25;
		private static final int MAX_PATH_NODES = 4_000;
		private static final double MAX_PATH_RADIUS = 64.0;
		private final Vec3 target;
		private List<Vec3> waypoints = List.of();
		private int waypointIndex;
		private Vec3 destination;
		private boolean routeComplete;
		private int lastProgressTick;
		private int lastWaypointIndex;
		private double lastWaypointDistance;
		private int stuckTicks;
		private int replans;
		private int nextReplanAt;
		private BlockPos escapeWall;

		/**
		 * A body can end up in a one-block shaft it dug itself. A* cannot
		 * climb a vertical wall, so open the nearest horizontal wall cell
		 * instead of replanning the same impossible route. The next tick's
		 * route then has a real neighbour to walk through.
		 */
		private boolean digOut(Minecraft client) {
			LocalPlayer player = client.player;
			if (!player.onGround()) return false;
			BlockPos feet = player.blockPosition();
			int walls = 0;
			for (Direction direction : Direction.Plane.HORIZONTAL) {
				if (client.level.getBlockState(feet.relative(direction)).blocksMotion()) walls++;
			}
			int pickaxeSlot = -1;
			BlockState stone = Blocks.STONE.defaultBlockState();
			for (int slot = 0; slot < 9; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (stack.isEmpty() || !stack.isCorrectToolForDrops(stone)) continue;
				pickaxeSlot = slot;
			}
			if (!ShaftEscape.shouldDigOut(walls, pickaxeSlot >= 0)) return false;
			for (Direction direction : Direction.Plane.HORIZONTAL) {
				BlockPos wall = feet.relative(direction);
				BlockState state = client.level.getBlockState(wall);
				if (!state.blocksMotion()) continue;
				Vec3 centre = Vec3.atCenterOf(wall);
				MineTask.aimAt(player, centre);
				BlockHitResult hit = MineTask.clip(client, player, centre);
				if (!ShaftEscape.canBreakWall(
					state.blocksMotion(),
					hit.getBlockPos().equals(wall)
				)) continue;
				escapeWall = wall;
				player.getInventory().setSelectedSlot(pickaxeSlot);
				client.gameMode.startDestroyBlock(wall, hit.getDirection());
				if (player.onGround()) player.jumpFromGround();
				return true;
			}
			return false;
		}

		GotoTask(String id, JsonObject args) {
			super(id);
			this.target = vec(args);
		}

		@Override
		void start(Minecraft client) {
			destination = target;
			// A recovered respawn may carry a stale fallDistance from the
			// death tick. Reset it only when the body is actually on ground;
			// an airborne body must keep the real fall for the safety reflex.
			if (client.player.onGround()) client.player.resetFallDistance();
			Route route = safeRouteEnd(client, client.player);
			if (route == null) {
				if (digOut(client)) {
					send.accept(progress(id, "unstick", 0, 1));
					return;
				}
				finish(id, "failed", "E_PRECONDITION", "no safe route from the current position");
				return;
			}
			destination = route.destination();
			routeComplete = route.complete();
			waypoints = route.waypoints();
			waypointIndex = waypoints.size() > 1 ? 1 : 0;
			lastWaypointIndex = waypointIndex;
			lastWaypointDistance = playerDistance(client.player);
			nextReplanAt = 0;
			CraftMateBodyClient.LOGGER.info(
				"CraftMate goto start target={} destination={} position={}",
				target,
				destination,
				client.player.position()
			);
			send.accept(progress(id, "walking", 0, 1));
		}

		@Override
		void tick(Minecraft client) {
			LocalPlayer player = client.player;
			if (escapeWall != null) {
				BlockState wall = client.level.getBlockState(escapeWall);
				if (wall.isAir()) {
					escapeWall = null;
					Route route = safeRouteEnd(client, player);
					if (route != null) {
						destination = route.destination();
						routeComplete = route.complete();
						waypoints = route.waypoints();
						waypointIndex = waypoints.size() > 1 ? 1 : 0;
					}
					return;
				}
				Vec3 centre = Vec3.atCenterOf(escapeWall);
				MineTask.aimAt(player, centre);
				BlockHitResult hit = MineTask.clip(client, player, centre);
				if (!hit.getBlockPos().equals(escapeWall)) {
					finish(id, "failed", "E_PRECONDITION", "escape wall is no longer visible");
					return;
				}
				client.gameMode.continueDestroyBlock(escapeWall, hit.getDirection());
				holdMiningInput(client);
				if (player.onGround()) player.jumpFromGround();
				send.accept(progress(id, "unstick", 1, 2));
				return;
			}
			if (waypointIndex >= waypoints.size()) {
				stop(client);
				finish(id, "failed", "E_INTERNAL", "route has no current waypoint");
				return;
			}
			Vec3 waypoint = waypoints.get(waypointIndex);
			Vec3 offset = waypoint.subtract(player.position());
			double horizontal = horizontalDistance(player);
			if (
				waypointIndex < waypoints.size() - 1
					&& Math.hypot(waypoint.x - player.getX(), waypoint.z - player.getZ()) < ARRIVE_DISTANCE
					&& Math.abs(waypoint.y - player.getY()) <= ARRIVE_HEIGHT
			) {
				waypointIndex++;
				return;
			}
			boolean arrived = horizontal < ARRIVE_DISTANCE
				&& Math.abs(player.getY() - destination.y) <= ARRIVE_HEIGHT;
			boolean finalWaypoint = waypointIndex >= waypoints.size() - 1;
			if (arrived && finalWaypoint) {
				stop(client);
				if (arrived && routeComplete && atTarget()) {
					finish(id, "completed", null, null);
				} else {
					JsonObject evidence = partialRoute(horizontal);
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						routeComplete
							? "reached the target column at the wrong height"
							: "safe route stopped short of the requested target",
						evidence
					);
				}
				return;
			}
			if (age > 20 * 60) {
				stop(client);
				if (!routeComplete) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"safe route stopped short of the requested target",
						partialRoute(horizontal)
					);
				} else {
					finish(id, "timeout", "E_TIMEOUT", "bounded walk did not reach target");
				}
				return;
			}
			if (player.onGround() && unsafeNextStep(client, player, offset)) {
				stop(client);
				finish(id, "failed", "E_PRECONDITION", "dangerous drop or water ahead");
				return;
			}
			if (player.horizontalCollision && player.onGround()) {
				player.jumpFromGround();
			}
			double waypointDistance = playerDistance(player);
			if (
				waypointIndex > lastWaypointIndex
					|| waypointDistance + 0.05 < lastWaypointDistance
			) {
				lastWaypointIndex = waypointIndex;
				lastWaypointDistance = waypointDistance;
				stuckTicks = 0;
			} else {
				stuckTicks++;
			}
			if (stuckTicks > STUCK_TICKS) {
				stuckTicks = 0;
				// A body can end up in a one-block shaft it dug itself. A
				// four/eight-way A* cannot climb a vertical wall, and
				// replanning the same route only burns the task budget.
				// Pillar up with a block already in the backpack; the next
				// route is planned from the new height.
				if (digOut(client)) {
					send.accept(progress(id, "unstick", replans, MAX_REPLANS));
					replans = 0;
					nextReplanAt = age + 20;
					Route replanned = safeRouteEnd(client, player);
					if (replanned != null) {
						destination = replanned.destination();
						routeComplete = replanned.complete();
						waypoints = replanned.waypoints();
						waypointIndex = waypoints.size() > 1 ? 1 : 0;
					}
					return;
				}
				if (age < nextReplanAt || replans >= MAX_REPLANS) {
					stop(client);
					if (!routeComplete) {
						finish(
							id,
							"failed",
							"E_PRECONDITION",
							"safe route stopped short of the requested target",
							partialRoute(horizontal)
						);
						return;
					}
					finish(id, "failed", "E_PRECONDITION", "walk made no progress after bounded replanning");
					return;
				}
				Route replanned = safeRouteEnd(client, player);
				if (replanned == null) {
					stop(client);
					finish(id, "failed", "E_PRECONDITION", "no safe route after replanning");
					return;
				}
				replans++;
				nextReplanAt = age + REPLAN_COOLDOWN_TICKS;
				destination = replanned.destination();
				routeComplete = replanned.complete();
				waypoints = replanned.waypoints();
				waypointIndex = waypoints.size() > 1 ? 1 : 0;
				lastWaypointIndex = waypointIndex;
				lastWaypointDistance = playerDistance(player);
				send.accept(progress(id, "replanning", replans, MAX_REPLANS));
				return;
			}
			player.setYRot((float) Math.toDegrees(Math.atan2(-offset.x, offset.z)));
			CameraController.steerHeading(
				player,
				player.getYRot(),
				CameraController.displayPitch(player)
			);
			if (player.input != null) {
				setWalkInput(client, true);
			}
			if (age - lastProgressTick >= 20) {
				lastProgressTick = age;
				CraftMateBodyClient.LOGGER.info(
					"CraftMate goto tick position={} destination={} horizontal={} ground={} collision={} delta={}",
					player.position(),
					destination,
					round(horizontal),
					player.onGround(),
					player.horizontalCollision,
					player.getDeltaMovement()
				);
				send.accept(progress(id, "walking", (int) Math.round(horizontal), (int) Math.round(age)));
			}
		}

		private double horizontalDistance(LocalPlayer player) {
			return Math.hypot(destination.x - player.getX(), destination.z - player.getZ());
		}

		/**
		 * Progress is measured against the current waypoint, not the final
		 * target: a valid U-shaped detour initially walks away from the
		 * target and must not look like a stall.
		 */
		private double playerDistance(LocalPlayer player) {
			Vec3 waypoint = waypoints.get(waypointIndex);
			return player.position().distanceTo(waypoint);
		}

		private boolean atTarget() {
			return Math.hypot(target.x - destination.x, target.z - destination.z) < 0.01
				&& Math.abs(target.y - destination.y) <= ARRIVE_HEIGHT;
		}

		private JsonObject partialRoute(double remaining) {
			JsonObject evidence = new JsonObject();
			JsonObject outcome = new JsonObject();
			outcome.addProperty(
				"summary",
				"只走到安全路线的可用终点，未到达请求的位置"
			);
			outcome.addProperty("problem", "剩下的路线上有断崖、水面或无法站立的区域");
			JsonObject stopped = new JsonObject();
			stopped.addProperty("x", round(destination.x));
			stopped.addProperty("y", round(destination.y));
			stopped.addProperty("z", round(destination.z));
			JsonObject requested = new JsonObject();
			requested.addProperty("x", round(target.x));
			requested.addProperty("y", round(target.y));
			requested.addProperty("z", round(target.z));
			evidence.add("stoppedAt", stopped);
			evidence.add("requested", requested);
			evidence.addProperty("remainingHorizontal", round(remaining));
			evidence.add("outcome", outcome);
			return evidence;
		}

		/**
		 * The direct route is intentionally conservative: a two-block drop or
		 * an unplanned water entry would either hurt the body or hand control
		 * to the safety reflex. Let the autonomy loop choose another heading
		 * instead of walking to the edge every time.
		 */
		private boolean unsafeNextStep(Minecraft client, LocalPlayer player, Vec3 offset) {
			double length = Math.hypot(offset.x, offset.z);
			if (length < 0.01) return false;
			BlockPos next = BlockPos.containing(
				player.getX() + offset.x / length * 0.65,
				player.getY(),
				player.getZ() + offset.z / length * 0.65
			);
			return standingY(
				client,
				new BlockPos(next.getX(), player.blockPosition().getY(), next.getZ())
			) == Integer.MIN_VALUE;
		}

		/**
		 * A direct route is only safe if every sampled step has a solid floor,
		 * no fluid at foot height, and no drop deeper than one block. Walking
		 * first and relying on the fall reflex is too late: the body is already
		 * over the edge when the reflex fires.
		 */
		private Route safeRouteEnd(Minecraft client, LocalPlayer player) {
			if (!player.onGround()) return null;
			BoundedPathfinder.Cell start = new BoundedPathfinder.Cell(
				player.blockPosition().getX(),
				player.blockPosition().getY(),
				player.blockPosition().getZ()
			);
			BoundedPathfinder.Cell goal = new BoundedPathfinder.Cell(
				(int) Math.floor(target.x),
				(int) Math.floor(target.y),
				(int) Math.floor(target.z)
			);
			BoundedPathfinder.Result found = BoundedPathfinder.find(
				start,
				goal,
					(x, y, z) -> standingY(client, new BlockPos(x, y, z)) == y,
				(x, y, z) -> isNearGoal(x, z, goal),
				MAX_PATH_NODES,
				MAX_PATH_RADIUS
			);
			if (found == null) return null;
			List<Vec3> points = new ArrayList<>();
			for (BoundedPathfinder.Cell cell : found.path()) {
				points.add(new Vec3(cell.x() + 0.5, cell.y(), cell.z() + 0.5));
			}
			if (found.complete()) points.add(target);
			Vec3 end = points.get(points.size() - 1);
			return new Route(found.complete() ? target : end, found.complete(), points);
		}

		private record Route(Vec3 destination, boolean complete, List<Vec3> waypoints) {
		}

		/**
		 * The exact target column can be a wall, a ledge or slightly outside
		 * this step's four-block reach. A nearby standable cell still makes the
		 * exploration step useful instead of failing and re-sending the same
		 * unreachable goto every cooldown.
		 */
		private static boolean isNearGoal(int x, int z, BoundedPathfinder.Cell goal) {
			return Math.abs(x - goal.x()) <= 1 && Math.abs(z - goal.z()) <= 1;
		}

		@Override
		void stop(Minecraft client) {
			releaseMiningInput(client);
			releaseWalkInput(client);
			CameraController.release();
			escapeWall = null;
		}
	}

	private static final class MineTask extends Task {
		private static final int WALK_BASE_TICKS = 20 * 10;
		private static final int BREAK_TICKS = 20 * 25;
		/**
		 * A forest walk can pause on a step-up, a leaf block or a narrow gap
		 * for longer than three seconds. Fail only after a genuinely long
		 * stall; the walk budget still bounds the whole approach.
		 */
		private static final int APPROACH_STALL_TICKS = 20 * 8;
		/** Retarget on a shorter stall, but only fail after the full window. */
		private static final int APPROACH_RETARGET_TICKS = 20 * 3;
		private static final int MAX_REPLANS = 3;
		private static final int PICKUP_TIMEOUT_TICKS = 20 * 20;
		/** A bounded search is enough for a nearby tree; never scan the render space. */
		private static final int APPROACH_PATH_NODES = 4_000;
		private static final double APPROACH_PATH_RADIUS = 56.0;
		/** Diagnostics must stay bounded; never pathfind every log under a canopy. */
		private static final int DIAGNOSTIC_ROUTE_PROBES = 4;
		private final String blockId;
		private final boolean anyLog;
		private final int count;
		private int mined;
		private BlockPos target;
		private BlockPos desiredTarget;
		private Direction side;
		private int miningAge;
		private boolean walking;
		private int walkingAge;
		private int lastWalkProgressAge;
		private int approachTicks;
		private double lastApproachDistance = Double.POSITIVE_INFINITY;
		private List<Vec3> approachWaypoints = List.of();
		private int approachWaypoint;
		private BlockPos approachTarget;
		private int nextApproachPlanAt;
		private boolean destroying;
		private int lastReportedPercent = -1;
		private BlockState blockBeforeDestroy;
		private boolean breaking = false;
		private boolean breakingLeaves = false;
		private int replans;
		private final JsonArray minedBlocks = new JsonArray();
		private Map<String, Integer> inventoryBeforeBreak = Map.of();
		private Map<String, Integer> inventoryAfterPickup = Map.of();
		private int pickupStartedAt = -1;
		private BlockPos pickupBlock;
		private boolean collectingPickup;
		private ItemEntity pickupTarget;
		private int pickupLastProgressAt;
		private Vec3 pickupLastPosition;

		MineTask(String id, JsonObject args) {
			this(id, args, false);
		}

		MineTask(String id, JsonObject args, boolean anyLog) {
			super(id);
			this.anyLog = anyLog;
			this.blockId = anyLog ? null : required(args, "block");
			this.count = integer(args, "count", 1);
		}

		@Override
		boolean validate(Minecraft client) {
			if (!super.validate(client)) return false;
			if (anyLog) return true;
			Identifier id = Identifier.tryParse(blockId);
			if (id == null || !BuiltInRegistries.BLOCK.containsKey(id)) {
				validationError = "unknown block " + blockId;
				return false;
			}
			return true;
		}

		@Override
		void start(Minecraft client) {
			send.accept(progress(id, "finding", 0, count));
			if (!selectTool(client)) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"no hotbar tool can harvest " + targetName()
				);
				return;
			}
			target = selectTarget(client);
			if (target == null) {
				JsonObject evidence = diagnostics(client);
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"no " + targetName() + " within " + TARGET_SEARCH_RADIUS + " blocks",
					evidence
				);
				return;
			}
			walking = !canReach(client.player, target) || !canSee(client, client.player, target);
			lastApproachDistance = Double.POSITIVE_INFINITY;
			send.accept(progress(id, "target", 0, count));
		}

		/**
		 * A destroyed block can still leave no drop when the held item is not
		 * the correct tool. Choose by vanilla's own harvest rule rather than
		 * by item name, so stone tools, enchantments and modded tools all work.
		 */
		private boolean selectTool(Minecraft client) {
			LocalPlayer player = client.player;
			Block requested = anyLog
				? null
				: BuiltInRegistries.BLOCK.getValue(Identifier.parse(blockId));
			BlockState sample = requested == null
				? null
				: requested.defaultBlockState();
			boolean needsTool = sample != null
				&& sample.requiresCorrectToolForDrops()
				&& !anyLog;
			Inventory inventory = player.getInventory();
			String[] slots = new String[9];
			boolean[] usable = new boolean[9];
			for (int slot = 0; slot < 9; slot++) {
				ItemStack stack = inventory.getItem(slot);
				if (stack.isEmpty()) continue;
				slots[slot] = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				usable[slot] = !needsTool || stack.isCorrectToolForDrops(sample);
			}
			int chosen = ToolSelection.choose(
				slots,
				usable,
				needsTool,
				inventory.getSelectedSlot(),
				inventory.getSelectedSlot()
			);
			if (chosen < 0) return false;
			inventory.setSelectedSlot(chosen);
			return true;
		}

		@Override
		void tick(Minecraft client) {
			if (target == null) {
				finish(id, "failed", "E_PRECONDITION", "mining target is not selected");
				return;
			}
			BlockState state = client.level.getBlockState(target);
			if (destroying && state.isAir()) {
				boolean wasClearingCanopy = breakingLeaves;
				stopMining(client);
				if (wasClearingCanopy) {
					target = selectTarget(client);
					if (target == null) {
						finish(id, "failed", "E_PRECONDITION", "no " + targetName() + " left after clearing the canopy");
						return;
					}
					walking = !canReach(client.player, target) || !canSee(client, client.player, target);
					lastApproachDistance = Double.POSITIVE_INFINITY;
					lastReportedPercent = -1;
					return;
				}
				if (desiredTarget != null && !target.equals(desiredTarget)) {
					// This was a natural cover block. It made the requested
					// block visible; it is not part of the requested count.
					target = nextCoverOrTarget(client, desiredTarget);
					if (target == null) {
						finish(id, "failed", "E_PRECONDITION", "could not uncover " + targetName());
						return;
					}
					side = Direction.UP;
					miningAge = 0;
					walking = !canReach(client.player, target) || !canSee(client, client.player, target);
					lastApproachDistance = Double.POSITIVE_INFINITY;
					lastReportedPercent = -1;
					return;
				}
				mined++;
				send.accept(progress(id, "mining", mined, count));
				if (blockBeforeDestroy != null) {
					minedBlocks.add(miningResult(client.player, target, blockBeforeDestroy));
				}
				// A broken block is not a collected item. The task stays in
				// the pickup state until the inventory proves the drop.
				collectingPickup = true;
				pickupBlock = target;
				pickupStartedAt = age;
				pickupLastProgressAt = age;
				pickupLastPosition = null;
				pickupTarget = nearestDrop(client, pickupBlock);
				blockBeforeDestroy = null;
				return;
			}
			if (collectingPickup) {
				continuePickup(client);
				return;
			}
			LocalPlayer player = client.player;
			if (!canReach(player, target) || !canSee(client, player, target)) {
				// The player can drift out of reach while the destroy loop is
				// holding attack (knockback, a step, falling). Continuing to
				// hold the key then reports "breaking" forever while vanilla
				// never starts the block. Return to the approach state so the
				// progress signal stays truthful.
				if (breaking) stopMining(client);
				walking = true;
				lastApproachDistance = Double.POSITIVE_INFINITY;
				lastWalkProgressAge = walkingAge;
				approachTarget = null;
				return;
			}
			Vec3 center = Vec3.atCenterOf(target);
			CameraController.hold(player);
			aimAt(player, center);
			// A visible lookup can change with one tick of camera smoothing.
			// Do not start or continue a destroy cycle unless this tick's
			// crosshair is actually on the requested block; otherwise the
			// body would hold attack forever and report "breaking" at 0%.
			BlockHitResult aimed = clip(client, player, center);
			if (!aimed.getBlockPos().equals(target)) {
				if (breaking) stopMining(client);
				BlockPos alternative = findBlock(client, candidateState ->
					matchesTarget(candidateState) && !candidateState.equals(target)
				);
				if (alternative == null) {
					alternative = findBlockUnclipped(client, candidateState ->
						matchesTarget(candidateState) && !candidateState.equals(target)
					);
				}
				if (alternative != null) {
					target = alternative;
					lastApproachDistance = Double.POSITIVE_INFINITY;
					lastWalkProgressAge = walkingAge;
					lastReportedPercent = -1;
					walking = !canReach(player, alternative) || !canSee(client, player, alternative);
					return;
				}
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"target is obstructed from the player's line of sight"
				);
				return;
			}
			if (walking) {
				if (canReach(player, target) && canSee(client, player, target)) {
					walking = false;
					walkingAge = 0;
					return;
				}
				approachTicks++;
				double distance = player.position().distanceTo(center);
				if (approachTicks % 20 == 0) {
					BlockPos visible = findBlock(client, this::matchesTarget);
					if (visible != null && canReach(player, visible)) {
						target = visible;
						center = Vec3.atCenterOf(target);
						distance = player.position().distanceTo(center);
						lastApproachDistance = Double.POSITIVE_INFINITY;
						walkingAge = 0;
					}
				}
				if (!target.equals(approachTarget) || approachTicks >= nextApproachPlanAt) {
					ApproachRoute.Route route = ApproachRoute.to(client, target);
					if (route != null && route.waypoints().size() > 1) {
						approachWaypoints = route.waypoints();
						approachWaypoint = approachWaypoints.size() > 1 ? 1 : 0;
					} else {
						approachWaypoints = List.of();
						approachWaypoint = 0;
					}
					approachTarget = target;
					nextApproachPlanAt = approachTicks + 20;
					if (route == null) {
						BlockPos canopy = canopyNear(client, target);
						if (MiningApproach.next(false, canopy != null) == MiningApproach.Mode.CLEAR_CANOPY) {
							// No standable interaction cell exists yet. Clearing
							// the trunk's own canopy is the only truthful way
							// forward; walking at the trunk from here never
							// changes the world.
							startCanopyCleanup(client, canopy);
							return;
						}
					}
				}
				Vec3 step = approachWaypoints.size() > approachWaypoint
					? approachWaypoints.get(approachWaypoint)
					: center;
				while (
					approachWaypoint < approachWaypoints.size() - 1
						&& Math.hypot(step.x - player.getX(), step.z - player.getZ()) < 0.75
						&& Math.abs(step.y - player.getY()) < 1.25
				) {
					approachWaypoint++;
					step = approachWaypoints.get(approachWaypoint);
				}
				double progressDistance = approachWaypoints.isEmpty()
					? distance
					: player.position().distanceTo(step);
				if (progressDistance + 0.1 < lastApproachDistance) {
					lastApproachDistance = progressDistance;
					lastWalkProgressAge = walkingAge;
				}
				double heading = Math.atan2(-(step.x - player.getX()), step.z - player.getZ());
				player.setYRot((float) Math.toDegrees(heading));
				Vec3 ahead = player.position().add(
					-Math.sin(heading) * 0.6,
					0,
					Math.cos(heading) * 0.6
				);
				BlockPos foot = BlockPos.containing(ahead.x, player.getY() - 0.5, ahead.z);
				boolean ledge = client.level.getBlockState(foot).isAir()
					&& client.level.getBlockState(foot.below()).isAir();
				boolean leafFloor = client.level.getBlockState(foot.below()).is(BlockTags.LEAVES);
				if (leafFloor && player.onGround()) {
					// A leaf top is not a floor for walking. Stepping onto it
					// falls through as soon as the block updates, and the fall
					// reflex then cancels a valid chop. Clear the leaf below the
					// next step instead of treating the canopy as terrain.
					BlockPos leaf = foot.below();
					if (canReach(player, leaf)) {
						startCanopyCleanup(client, leaf);
						return;
					}
				}
				if (ledge && player.onGround()) {
					if (client.level.getBlockState(foot.below(2)).blocksMotion()) {
						player.jumpFromGround();
					} else {
						// The nearest log can be across a ravine. Do not walk
						// off the edge and do not fail while another tree is
						// still reachable; turn toward a different candidate.
						BlockPos alternative = findApproachTarget(client, target);
						if (alternative != null) {
							target = alternative;
							center = Vec3.atCenterOf(target);
							lastApproachDistance = Double.POSITIVE_INFINITY;
							lastWalkProgressAge = walkingAge;
							return;
						}
						stop(client);
						finish(id, "failed", "E_PRECONDITION", "no safe reachable " + targetName());
						return;
					}
				} else if (player.horizontalCollision && player.onGround()) {
					player.jumpFromGround();
				}
				if (player.input != null) {
					setWalkInput(client, true);
				}
				walkingAge++;
				if (walkingAge > walkBudgetTicks(player, target)) {
					stop(client);
					finish(
						id,
						"timeout",
						"E_TIMEOUT",
						"could not reach " + targetName() + " in time",
						approachDiagnostics(client, target)
					);
				} else if (walkingAge - lastWalkProgressAge > APPROACH_RETARGET_TICKS) {
					boolean exhausted = replans >= MAX_REPLANS
						&& walkingAge - lastWalkProgressAge > APPROACH_STALL_TICKS;
					if (exhausted) {
						stop(client);
						finish(
							id,
							"failed",
							"E_PRECONDITION",
							"no reachable " + targetName() + " after replanning",
							approachDiagnostics(client, target)
						);
						return;
					}
					replans++;
					// The nearest log may be behind leaves or across a gap.
					// Give the agent another visible candidate instead of
					// reporting the same unreachable target every four seconds.
					BlockPos alternative = findApproachTarget(client, target);
					if (alternative != null) {
						target = alternative;
						center = Vec3.atCenterOf(target);
						lastApproachDistance = Double.POSITIVE_INFINITY;
						lastWalkProgressAge = walkingAge;
						return;
					}
					BlockPos canopy = canopyNear(client, target);
					if (canopy != null) {
						// A canopy can completely surround the trunk. The
						// normal destroy state machine can clear the leaf that
						// blocks the next step; it is not a chop count.
						startCanopyCleanup(client, canopy);
						return;
					}
					stop(client);
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						targetName() + " approach made no progress for 3 seconds"
					);
				}
				return;
			}
			releaseWalkInput(client);
			aimAt(player, center);
			BlockHitResult hit = clip(client, player, center);
			if (!hit.getBlockPos().equals(target)) {
				// The trunk can be behind leaves after an earlier chop. Pick
				// another visible log before giving up; only a task with no
				// alternative should emit an obstruction failure.
				BlockPos alternative = findBlock(client, candidateState ->
					matchesTarget(candidateState) && !candidateState.equals(target)
				);
				if (alternative == null) {
					alternative = findBlockUnclipped(client, candidateState ->
						matchesTarget(candidateState) && !candidateState.equals(target)
					);
				}
				if (alternative != null && !alternative.equals(target)) {
					stopMining(client);
					target = alternative;
					walking = true;
					lastApproachDistance = Double.POSITIVE_INFINITY;
					lastWalkProgressAge = 0;
					lastReportedPercent = -1;
					return;
				}
				stopMining(client);
				target = null;
				finish(id, "failed", "E_PRECONDITION", "target is obstructed from the player's line of sight");
				return;
			}
			if (!breaking) {
				inventoryBeforeBreak = inventoryCounts(client.player);
				blockBeforeDestroy = client.level.getBlockState(target);
				side = hit.getDirection();
				holdMiningInput(client);
				miningAge = 0;
				lastReportedPercent = -1;
				// The vanilla key handler owns start/continue/stop. Holding
				// keyAttack makes it use the same hit result and target every
				// tick, so destroyProgress is not reset by an intervening
				// stopDestroyBlock call from the input path.
				client.hitResult = hit;
				destroying = true;
				breaking = true;
				send.accept(progress(id, "breaking", 0, 100));
			} else {
				holdMiningInput(client);
				// Keep the client's pick result aligned with the face the task
				// aimed at. Vanilla's key handler then advances the same
				// destroy target instead of starting a new one.
				client.hitResult = client.level.clip(
					new ClipContext(
						player.getEyePosition(),
						Vec3.atCenterOf(target),
						ClipContext.Block.OUTLINE,
						ClipContext.Fluid.NONE,
						player
					)
				);
			}
			client.missTime = 0;
			// The vanilla destroy loop owns accumulated progress. The block
			// state turning to air is the only trustworthy completion signal;
			// getDestroyStage exposes the real vanilla stage without summing
			// per-block coefficients ourselves.
			miningAge++;
			BlockState current = client.level.getBlockState(target);
			if (!current.isAir() && miningAge % 20 == 0) {
				int stage = client.gameMode.getDestroyStage();
				CraftMateBodyClient.LOGGER.info(
					"mine breaking target={} eye={} yaw={} pitch={} hit={} destroying={} stage={} distance={}",
					target,
					player.getEyePosition(),
					player.getYRot(),
					player.getXRot(),
					client.hitResult == null || client.hitResult.getType() != HitResult.Type.BLOCK
						? "none"
						: ((BlockHitResult) client.hitResult).getBlockPos().toString(),
					client.gameMode.isDestroying(),
					stage,
					Math.sqrt(player.distanceToSqr(Vec3.atCenterOf(target)))
				);
				int percent = stage < 0 ? 0 : Math.min(99, stage * 10);
				if (percent >= lastReportedPercent + 5) {
					lastReportedPercent = percent;
					send.accept(progress(id, "breaking", percent, 100));
				}
			}
			if (miningAge > BREAK_TICKS) {
				stopMining(client);
				finish(id, "failed", "E_TIMEOUT", "block did not break");
			}
		}

		/**
		 * The server owns the drop. Wait for the item entity, walk to it, and
		 * only then compare the inventory. If the block produced something
		 * unexpected, the item is still accepted because the drop is the
		 * observable consequence of the requested block.
		 */
		private void continuePickup(Minecraft client) {
			Map<String, Integer> inventory = inventoryCounts(client.player);
			Map<String, Integer> gained = MiningPickupEvidence.gains(inventoryBeforeBreak, inventory);
			if (!gained.isEmpty()) {
				inventoryAfterPickup = inventory;
				mined = Math.max(mined, minedBlocks.size());
				if (mined >= count) {
					completeMining(client);
					return;
				}
				collectingPickup = false;
				pickupTarget = null;
				releaseWalkInput(client);
				target = selectTarget(client);
				if (target == null) {
					failPartialMining(client, "附近找不到更多");
					return;
				}
				side = Direction.UP;
				miningAge = 0;
				walking = !canReach(client.player, target) || !canSee(client, client.player, target);
				lastApproachDistance = Double.POSITIVE_INFINITY;
				lastReportedPercent = -1;
				return;
			}
			if (age - pickupStartedAt > PICKUP_TIMEOUT_TICKS) {
				stopMining(client);
				releaseWalkInput(client);
				JsonObject evidence = new JsonObject();
				evidence.add("mined", minedBlocks);
				JsonObject diagnostic = new JsonObject();
				diagnostic.addProperty("pickupConfirmed", false);
				diagnostic.addProperty("waitedTicks", age - pickupStartedAt);
				diagnostic.addProperty("nearbyDrops", nearestDrop(client, pickupBlock) != null);
				evidence.add("pickup", diagnostic);
				evidence.add(
					"outcome",
					outcome(
						(anyLog ? "砍下 " : "挖掉 ") + mined + " 个" + targetName() + "，但掉落物未入包",
						minedBlocks,
						"block was broken but no drop entered the inventory"
					)
				);
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"block was broken but pickup was not confirmed",
					evidence
				);
				return;
			}
			if (pickupTarget == null || !pickupTarget.isAlive() || pickupTarget.isRemoved()) {
				pickupTarget = nearestDrop(client, pickupBlock);
				pickupLastPosition = null;
				if (pickupTarget == null) return;
			}
			Vec3 position = pickupTarget.position();
			if (pickupLastPosition == null || position.distanceTo(pickupLastPosition) > 0.05) {
				pickupLastPosition = position;
				pickupLastProgressAt = age;
			}
			if (client.player.position().distanceTo(position) < 1.3) {
				releaseWalkInput(client);
				return;
			}
			if (age - pickupLastProgressAt > COLLECT_STALL_TICKS) {
				stopMining(client);
				releaseWalkInput(client);
				JsonObject evidence = new JsonObject();
				evidence.add("mined", minedBlocks);
				evidence.add(
					"outcome",
					outcome(
						(anyLog ? "砍下 " : "挖掉 ") + mined + " 个" + targetName() + "，但无法接近掉落物",
						minedBlocks,
						"drop is not reachable from a safe standing position"
					)
				);
				finish(id, "failed", "E_PRECONDITION", "drop is not reachable", evidence);
				return;
			}
			Vec3 direction = position.subtract(client.player.position());
			double horizontal = Math.hypot(direction.x, direction.z);
			if (horizontal > 0.01) {
				client.player.setYRot((float) Math.toDegrees(Math.atan2(-direction.x, direction.z)));
			}
			if (client.player.horizontalCollision && client.player.onGround()) {
				client.player.jumpFromGround();
			}
			if (client.player.input != null) setWalkInput(client, true);
			if (age % 20 == 0) send.accept(progress(id, "collecting", mined, count));
		}

		private void completeMining(Minecraft client) {
			stopMining(client);
			releaseWalkInput(client);
			JsonObject evidence = new JsonObject();
			evidence.add("mined", minedBlocks);
			JsonObject pickup = new JsonObject();
			pickup.addProperty("confirmed", true);
			JsonArray gained = new JsonArray();
			for (var entry : MiningPickupEvidence.gains(inventoryBeforeBreak, inventoryAfterPickup).entrySet()) {
				JsonObject change = new JsonObject();
				change.addProperty("item", entry.getKey());
				change.addProperty("count", entry.getValue());
				gained.add(change);
			}
			pickup.add("gained", gained);
			evidence.add("pickup", pickup);
			evidence.add(
				"outcome",
				outcome(
					(anyLog ? "砍下并拾取 " : "挖掉并拾取 ") + mined + " 个" + targetName(),
					minedBlocks,
					null
				)
			);
			finish(id, "completed", null, null, evidence);
		}

		private void failPartialMining(Minecraft client, String reason) {
			JsonObject evidence = new JsonObject();
			evidence.add("mined", minedBlocks);
			evidence.add(
				"outcome",
				outcome(
					(anyLog ? "只砍到 " : "只挖到 ") + mined + " 个" + targetName(),
					minedBlocks,
					reason
				)
			);
			finish(
				id,
				"failed",
				"E_PRECONDITION",
				"only " + mined + " of " + count + " " + targetName() + " found",
				evidence
			);
		}

		private Map<String, Integer> inventoryCounts(LocalPlayer player) {
			Map<String, Integer> counts = new java.util.TreeMap<>();
			for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (stack.isEmpty()) continue;
				String item = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				counts.merge(item, stack.getCount(), Integer::sum);
			}
			return counts;
		}

		private ItemEntity nearestDrop(Minecraft client, BlockPos around) {
			BlockPos origin = around == null ? client.player.blockPosition() : around;
			return client.level
				.getEntitiesOfClass(
					ItemEntity.class,
					client.player.getBoundingBox().inflate(COLLECT_SEARCH_RADIUS)
				)
				.stream()
				.filter(ItemEntity::isAlive)
				.filter(entity -> entity.blockPosition().distSqr(origin) <= COLLECT_SEARCH_RADIUS * COLLECT_SEARCH_RADIUS)
				.min((left, right) -> Double.compare(left.distanceToSqr(client.player), right.distanceToSqr(client.player)))
				.orElse(null);
		}

		private JsonObject miningResult(LocalPlayer player, BlockPos position, BlockState state) {
			JsonObject evidence = new JsonObject();
			evidence.addProperty("block", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
			ItemStack tool = player.getInventory().getSelectedItem();
			if (!tool.isEmpty()) {
				evidence.addProperty(
					"tool",
					BuiltInRegistries.ITEM.getKey(tool.getItem()).toString()
				);
				if (tool.isDamageableItem()) {
					evidence.addProperty("toolDamage", tool.getDamageValue());
				}
			}
			JsonObject minedPosition = new JsonObject();
			minedPosition.addProperty("x", position.getX());
			minedPosition.addProperty("y", position.getY());
			minedPosition.addProperty("z", position.getZ());
			evidence.add("position", minedPosition);
			return evidence;
		}

		private BlockPos findTarget(Minecraft client) {
			if (anyLog) return findReachableLogFace(client);
			Block block = BuiltInRegistries.BLOCK.getValue(Identifier.parse(blockId));
			return findBlock(client, state -> state.is(block));
		}

		/**
		 * A trunk's centre can be behind its own leaf canopy while a side face
		 * is plainly visible. Centre-only clipping then reports "no log" even
		 * though the body can walk to it and chop it. Accept any log whose
		 * nearest exposed face is reachable from a standable cell.
		 */
		private BlockPos findReachableLogFace(Minecraft client) {
			BlockPos origin = client.player.blockPosition();
			BlockPos best = null;
			double bestDistance = Double.POSITIVE_INFINITY;
			int radius = TARGET_SEARCH_RADIUS;
			for (BlockPos pos : BlockPos.betweenClosed(
				origin.offset(-radius, -16, -radius),
				origin.offset(radius, 16, radius)
			)) {
				BlockState state = client.level.getBlockState(pos);
				if (!state.is(BlockTags.LOGS)) continue;
				BlockPos candidate = pos.immutable();
				if (removesCurrentSupport(client.player, candidate)) continue;
				double distance = candidate.distSqr(origin);
				if (distance > (double) radius * radius) continue;
				if (!hasVisibleFace(client, candidate)) continue;
				if (distance < bestDistance) {
					bestDistance = distance;
					best = candidate;
				}
			}
			return best;
		}

		/**
		 * A different visible target can be reached without crossing the gap
		 * that blocked the previous one. Prefer one whose shortest safe route
		 * reaches it rather than merely selecting the next visible log.
		 */
		private BlockPos findApproachTarget(Minecraft client, BlockPos excluded) {
			BlockPos origin = client.player.blockPosition();
			List<BlockPos> candidates = new ArrayList<>();
			int radius = TARGET_SEARCH_RADIUS;
			for (BlockPos pos : BlockPos.betweenClosed(
				origin.offset(-radius, -16, -radius),
				origin.offset(radius, 16, radius)
			)) {
				BlockPos candidate = pos.immutable();
				if (candidate.equals(excluded)) continue;
				if (!matchesTarget(client.level.getBlockState(candidate))) continue;
				double distance = candidate.distSqr(origin);
				if (distance > (double) radius * radius) continue;
				candidates.add(candidate);
			}
			// A target can be far from the current position and still reachable.
			// Checking only an adjacent standing cell near the player made every
			// log outside interaction range look unreachable, so a second tree
			// was never approached after the first log was chopped.
			candidates.sort(
				(left, right) -> Double.compare(left.distSqr(origin), right.distSqr(origin))
			);
			for (BlockPos candidate : candidates) {
				ApproachRoute.Route route = ApproachRoute.nearestReachable(
					client,
					candidate,
					APPROACH_PATH_NODES,
					APPROACH_PATH_RADIUS
				);
				if (route != null && route.complete()) return candidate;
			}
			// A* can reject every interaction cell when a trunk is enclosed by
			// its own canopy or the standable cell is one block below an
			// overhang. Do not report "no reachable log" while a real log is
			// still nearby: return the nearest candidate and let the bounded
			// walk + canopy-clearing loop make an honest attempt.
			return candidates.isEmpty() ? null : candidates.get(0);
		}

		/**
		 * Pick a leaf that belongs to this trunk and is actually hittable from
		 * the current position. Clearing a random leaf elsewhere in the
		 * forest would spend the task budget without opening a walk cell.
		 */
		private BlockPos canopyNear(Minecraft client, BlockPos trunk) {
			BlockPos direct = null;
			double bestDistance = Double.POSITIVE_INFINITY;
			BlockPos origin = client.player.blockPosition();
			int radius = 8;
			for (BlockPos pos : BlockPos.betweenClosed(
				origin.offset(-radius, -4, -radius),
				origin.offset(radius, 4, radius)
			)) {
				BlockPos candidate = pos.immutable();
				if (!client.level.getBlockState(candidate).is(BlockTags.LEAVES)) continue;
				if (!CanopyCleanup.relevant(
					candidate.getX(),
					candidate.getY(),
					candidate.getZ(),
					trunk.getX(),
					trunk.getY(),
					trunk.getZ(),
					trunk.distSqr(candidate),
					client.player.blockInteractionRange()
				)) continue;
				if (!canSee(client, client.player, candidate)) continue;
				double distance = origin.distSqr(candidate);
				if (distance < bestDistance) {
					bestDistance = distance;
					direct = candidate;
				}
			}
			if (direct != null) return direct;
			for (BlockPos pos : BlockPos.betweenClosed(
				origin.offset(-radius, -4, -radius),
				origin.offset(radius, 4, radius)
			)) {
				BlockPos candidate = pos.immutable();
				if (!client.level.getBlockState(candidate).is(BlockTags.LEAVES)) continue;
				if (!CanopyCleanup.relevant(
					candidate.getX(),
					candidate.getY(),
					candidate.getZ(),
					trunk.getX(),
					trunk.getY(),
					trunk.getZ(),
					trunk.distSqr(candidate),
					client.player.blockInteractionRange()
				)) continue;
				double distance = origin.distSqr(candidate);
				if (distance < bestDistance) {
					bestDistance = distance;
					direct = candidate;
				}
			}
			return direct;
		}

		private void startCanopyCleanup(Minecraft client, BlockPos canopy) {
			target = canopy;
			desiredTarget = null;
			side = Direction.UP;
			miningAge = 0;
			walking = !canReach(client.player, canopy) || !canSee(client, client.player, canopy);
			breaking = false;
			breakingLeaves = true;
			approachWaypoints = List.of();
			approachWaypoint = 0;
			approachTarget = null;
			lastReportedPercent = -1;
		}

		/**
		 * A timeout without the observed player cell and candidate routes
		 * cannot be distinguished from a planner bug or a genuinely isolated
		 * tree. Keep this bounded: the full scan already ran for target
		 * selection, and diagnostics only re-check a few nearest candidates.
		 */
		private JsonObject approachDiagnostics(Minecraft client, BlockPos attempted) {
			JsonObject evidence = diagnostics(client);
			evidence.addProperty("attemptedTarget", attempted.toString());
			evidence.addProperty("walkingTicks", walkingAge);
			evidence.addProperty("ticksWithoutProgress", walkingAge - lastWalkProgressAge);
			evidence.addProperty("approachReplans", replans);
			evidence.addProperty("approachWaypoints", approachWaypoints.size());
			evidence.addProperty("approachWaypoint", approachWaypoint);
			evidence.addProperty("canReach", canReach(client.player, attempted));
			evidence.addProperty("canSee", canSee(client, client.player, attempted));
			return evidence;
		}

		private BlockPos selectTarget(Minecraft client) {
			// A tall trunk can hide its lower logs behind leaves or adjacent
			// blocks. Prefer a directly visible log, then accept any log within
			// the same bounded search instead of failing while nearbyBlocks
			// clearly reports wood.
			// For logs, prioritize a safe reachable target to avoid selecting
			// a visible but unreachable log (e.g., across a gap or cliff).
			if (anyLog) {
				BlockPos reachable = findApproachTarget(client, null);
				if (reachable != null) {
					desiredTarget = null;
					return reachable;
				}
				// A trunk can be completely enclosed by its canopy. The
				// interaction cell beside the nearest log is not standable
				// until a leaf is removed, but that does not make the tree
				// unreachable: the walk loop will clear the blocking leaves
				// after it observes no progress. Returning null here made the
				// fallback below unreachable and rejected every enclosed tree.
				BlockPos visible = findTarget(client);
				if (visible != null) {
					desiredTarget = null;
					return visible;
				}
				BlockPos nearby = findBlockUnclipped(client, state -> state.is(BlockTags.LOGS));
				desiredTarget = null;
				return nearby;
			}
			BlockPos direct = findTarget(client);
			if (direct != null) {
				desiredTarget = null;
				return direct;
			}
			// Stone can be surrounded by identical stone. The target may be
			// unclipped from any other block in the search volume, yet still
			// have an exposed face reachable through a short tunnel. Prefer
			// one whose centre is visible after the body turns toward it.
			BlockPos exposed = findExposedTarget(client);
			if (exposed != null) {
				desiredTarget = null;
				return exposed;
			}
			BlockPos covered = findCoveredTarget(client);
			if (covered != null) return covered;
			// A stone layer under grass or dirt is normal terrain, not an
			// unreachable block. The walk loop will dig the natural cover and
			// then require an unobstructed face before breaking the target.
			return findBuriedTarget(client);
		}

		private BlockPos findExposedTarget(Minecraft client) {
			BlockPos origin = client.player.blockPosition();
			BlockPos best = null;
			double bestDistance = Double.POSITIVE_INFINITY;
			int probes = 0;
			for (BlockPos pos : BlockPos.betweenClosed(
				origin.offset(-16, -16, -16),
				origin.offset(16, 16, 16)
			)) {
				BlockPos candidate = pos.immutable();
				if (!matchesTarget(client.level.getBlockState(candidate))) continue;
				double distance = candidate.distSqr(origin);
				if (distance > 16 * 16) continue;
				if (distance >= bestDistance) continue;
				if (probes++ > 24) break;
				Vec3 center = Vec3.atCenterOf(candidate);
				BlockHitResult hit = clip(client, client.player, center);
				if (!hit.getBlockPos().equals(candidate)) continue;
				bestDistance = distance;
				best = candidate;
			}
			return best;
		}

		/**
		 * Dirt and sand are normally covered by grass or a layer of soil. A
		 * request for one of those blocks must be able to dig down through a
		 * few natural layers instead of reporting "not visible".
		 */
		private BlockPos findCoveredTarget(Minecraft client) {
			BlockPos origin = client.player.blockPosition();
			BlockPos best = null;
			double bestDistance = Double.POSITIVE_INFINITY;
			for (BlockPos pos : BlockPos.betweenClosed(origin.offset(-8, -5, -8), origin.offset(8, 2, 8))) {
				BlockPos candidate = pos.immutable();
				if (!matchesTarget(client.level.getBlockState(candidate))) continue;
				if (removesCurrentSupport(client.player, candidate)) continue;
				// Do not expose the body to water or a long drop just to reach
				// a covered block. A nearby natural target is never worth a
				// fall the safety reflex then has to cancel.
				if (!safeFooting(client, candidate)) continue;
				BlockPos next = nextCoverOrTarget(client, candidate);
				if (next == null || next.equals(candidate)) continue;
				double distance = candidate.distSqr(origin);
				if (distance < bestDistance) {
					bestDistance = distance;
					desiredTarget = candidate;
					best = next;
				}
			}
			return best;
		}

		/**
		 * A surface cliff can be entirely grass-topped while its visible face
		 * is stone one or two blocks below. Treat a shallow natural cover as
		 * something to remove, but never dig through player-built walls or a
		 * deep underground layer just to expose a target from the surface.
		 */
		private BlockPos findBuriedTarget(Minecraft client) {
			BlockPos origin = client.player.blockPosition();
			BlockPos best = null;
			double bestDistance = Double.POSITIVE_INFINITY;
			for (BlockPos pos : BlockPos.betweenClosed(
				origin.offset(-12, -4, -12),
				origin.offset(12, 3, 12)
			)) {
				BlockPos candidate = pos.immutable();
				if (!matchesTarget(client.level.getBlockState(candidate))) continue;
				if (removesCurrentSupport(client.player, candidate)) continue;
				double distance = candidate.distSqr(origin);
				if (distance >= bestDistance) continue;
				BlockPos top = naturalCoverTop(client, candidate);
				if (top == null) continue;
				if (!canMineCoverFor(client, top)) continue;
				desiredTarget = candidate;
				// The stone itself is buried, so no interaction cell around it
				// is standable yet. Walk to and break the top cover first; once
				// it is gone the normal cover loop advances one layer at a time
				// and only then targets the stone.
				best = top;
				bestDistance = distance;
			}
			return best;
		}

		/** The highest soil-like cover within four blocks, or null if none. */
		private BlockPos naturalCoverTop(Minecraft client, BlockPos desired) {
			BlockPos cover = desired;
			for (int depth = 1; depth <= 4; depth++) {
				BlockState state = client.level.getBlockState(desired.above(depth));
				if (state.isAir()) return cover.equals(desired) ? null : cover;
				if (!isNaturalCover(state)) return null;
				cover = desired.above(depth);
			}
			return null;
		}

		/**
		 * Removing the cover is only useful if the body can break it with the
		 * tool it already holds. Stone under dirt is fine; a target under a
		 * block the agent cannot mine would just burn the task budget.
		 */
		private boolean canMineCoverFor(Minecraft client, BlockPos cover) {
			BlockState state = client.level.getBlockState(cover);
			ItemStack tool = client.player.getInventory().getSelectedItem();
			return state.is(BlockTags.DIRT)
				|| state.is(BlockTags.SAND)
				|| state.is(BlockTags.SNOW)
				|| (state.is(BlockTags.MINEABLE_WITH_SHOVEL) && !tool.isEmpty())
				|| state.getDestroySpeed(client.level, cover) >= 0.0f;
		}

		private static boolean safeFooting(Minecraft client, BlockPos candidate) {
			BlockPos stand = candidate.above();
			BlockState feet = client.level.getBlockState(stand);
			BlockState head = client.level.getBlockState(stand.above());
			BlockState floor = client.level.getBlockState(stand.below());
			return feet.getFluidState().isEmpty()
				&& head.getFluidState().isEmpty()
				&& !floor.isAir()
				&& (feet.isAir() || head.isAir());
		}

		private boolean matchesTarget(BlockState state) {
			if (anyLog) return state.is(BlockTags.LOGS);
			return state.is(BuiltInRegistries.BLOCK.getValue(Identifier.parse(blockId)));
		}

		/**
		 * Returns the topmost natural cover above the desired block, or the
		 * desired block when nothing covers it. Only soil-like blocks are
		 * removed, so this never digs through a player-made wall or a tree.
		 */
		private BlockPos nextCoverOrTarget(Minecraft client, BlockPos desired) {
			BlockPos cover = desired;
			for (int depth = 1; depth <= 4; depth++) {
				BlockPos above = desired.above(depth);
				BlockState state = client.level.getBlockState(above);
				if (state.isAir()) return cover;
				if (!isNaturalCover(state)) return null;
				cover = above;
			}
			return cover;
		}

		private static boolean isNaturalCover(BlockState state) {
			return state.is(BlockTags.DIRT) || state.is(BlockTags.SAND) || state.is(BlockTags.SNOW);
		}

		private String targetName() {
			return anyLog ? "log" : blockId;
		}

		/**
		 * A bare "no log within N blocks" while nearbyBlocks still reports a
		 * tree cannot be debugged from the console. Include the observed player
		 * cell and how the candidates were rejected, without inventing a target.
		 */
		private JsonObject diagnostics(Minecraft client) {
			JsonObject evidence = new JsonObject();
			if (client.player == null) return evidence;
			BlockPos origin = client.player.blockPosition();
			JsonObject player = new JsonObject();
			player.addProperty("x", origin.getX());
			player.addProperty("y", origin.getY());
			player.addProperty("z", origin.getZ());
			evidence.add("playerBlock", player);
			evidence.addProperty("searchRadius", TARGET_SEARCH_RADIUS);
			evidence.addProperty(
				"playerCellStandable",
				standingY(client, origin) == origin.getY()
			);
			evidence.addProperty("blockInteractionRange", client.player.blockInteractionRange());
			// Visibility is a property of the player, not of each candidate.
			// This used to run a full 48-block scan for every log, which could
			// freeze the render thread for minutes inside a canopy.
			boolean visible = findBlock(client, this::matchesTarget) != null;
			int unclipped = 0;
			int routeComplete = 0;
			int routePartial = 0;
			int routeProbes = 0;
			double nearest = Double.POSITIVE_INFINITY;
			BlockPos nearestTarget = null;
			for (BlockPos pos : BlockPos.betweenClosed(
				origin.offset(-TARGET_SEARCH_RADIUS, -16, -TARGET_SEARCH_RADIUS),
				origin.offset(TARGET_SEARCH_RADIUS, 16, TARGET_SEARCH_RADIUS)
			)) {
				if (!matchesTarget(client.level.getBlockState(pos))) continue;
				BlockPos candidate = pos.immutable();
				if (candidate.distSqr(origin) > (double) TARGET_SEARCH_RADIUS * TARGET_SEARCH_RADIUS) {
					continue;
				}
				unclipped++;
				double distance = candidate.distSqr(origin);
				if (distance < nearest) {
					nearest = distance;
					nearestTarget = candidate;
				}
				if (routeProbes >= DIAGNOSTIC_ROUTE_PROBES) continue;
				routeProbes++;
				ApproachRoute.Route route = ApproachRoute.to(client, candidate);
				if (route != null && route.complete()) {
					routeComplete++;
				} else if (route != null) {
					routePartial++;
				}
			}
			evidence.addProperty("matchingBlocks", unclipped);
			evidence.addProperty("visibleTarget", visible);
			evidence.addProperty("routeComplete", routeComplete);
			evidence.addProperty("routePartial", routePartial);
			if (nearestTarget != null) {
				JsonObject nearestPoint = new JsonObject();
				nearestPoint.addProperty("x", nearestTarget.getX());
				nearestPoint.addProperty("y", nearestTarget.getY());
				nearestPoint.addProperty("z", nearestTarget.getZ());
				evidence.add("nearestTarget", nearestPoint);
				JsonArray spots = new JsonArray();
				for (int dy = -1; dy <= 1; dy++) {
					BlockPos level = nearestTarget.above(dy);
					for (Direction direction : Direction.Plane.HORIZONTAL) {
						BlockPos spot = level.relative(direction);
						JsonObject entry = new JsonObject();
						entry.addProperty("x", spot.getX());
						entry.addProperty("y", spot.getY());
						entry.addProperty("z", spot.getZ());
						entry.addProperty("feet", blockId(client, spot));
						entry.addProperty("head", blockId(client, spot.above()));
						entry.addProperty("floor", blockId(client, spot.below()));
						entry.addProperty("standingY", standingY(client, spot));
						spots.add(entry);
					}
				}
				evidence.add("nearestSpots", spots);
			}
			return evidence;
		}

		@Override
		void stop(Minecraft client) {
			stopMining(client);
			releaseWalkInput(client);
			CameraController.release();
			collectingPickup = false;
			pickupTarget = null;
		}

		private static boolean canReach(LocalPlayer player, BlockPos target) {
			// Use the client's own block interaction range. Eye-to-center
			// rejects a log at the player's feet and leaves the walk loop
			// pushing forever instead of starting to destroy it.
			return player.isWithinBlockInteractionRange(target, 0.0);
		}

		private static boolean canSee(Minecraft client, LocalPlayer player, BlockPos target) {
			return player.isWithinBlockInteractionRange(target, 0.0);
		}

		static BlockHitResult clip(Minecraft client, LocalPlayer player, Vec3 center) {
			return client.level.clip(
				new ClipContext(
					player.getEyePosition(),
					center,
					ClipContext.Block.OUTLINE,
					ClipContext.Fluid.NONE,
					player
				)
			);
		}

		/**
		 * Rotation is overwritten by movement and by the vanilla mouse path
		 * every tick. Recompute it immediately before both the walk and the
		 * hit test so the body cannot keep walking or swinging while looking
		 * somewhere else.
		 */
		static void aimAt(LocalPlayer player, Vec3 center) {
			Vec3 direction = center.subtract(player.getEyePosition()).normalize();
			player.setYRot((float) Math.toDegrees(Math.atan2(-direction.x, direction.z)));
			player.setXRot((float) Math.toDegrees(-Math.asin(direction.y)));
		}

		private static int walkBudgetTicks(LocalPlayer player, BlockPos target) {
			double blocks = Math.sqrt(player.blockPosition().distSqr(target));
			return WALK_BASE_TICKS + (int) Math.ceil(blocks) * 20;
		}

		private void stopMining(Minecraft client) {
			releaseMiningInput(client);
			destroying = false;
			breaking = false;
			breakingLeaves = false;
			lastReportedPercent = -1;
		}
	}

	private static final class CollectTask extends Task {
		private final String itemId;
		private final int requested;
		private int before;
		private int collected;
		private ItemEntity target;
		private Vec3 lastPosition;
		private int lastProgressAge;
		private boolean reachedItem;

		CollectTask(String id, String itemId, int requested) {
			super(id);
			this.itemId = itemId;
			this.requested = requested;
		}

		@Override
		boolean validate(Minecraft client) {
			if (!super.validate(client)) return false;
			if (itemId != null && Identifier.tryParse(itemId) == null) {
				validationError = "invalid item " + itemId;
				return false;
			}
			return true;
		}

		@Override
		void start(Minecraft client) {
			before = countInInventory(client.player);
			target = nearestItem(client);
			if (target == null) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"no matching dropped item within " + COLLECT_SEARCH_RADIUS + " blocks"
				);
				return;
			}
			send.accept(progress(id, "walking", 0, requested));
		}

		@Override
		void tick(Minecraft client) {
			collected = CollectionEvidence.gain(before, countInInventory(client.player));
			if (collected >= requested) {
				finish(id, "completed", null, null, evidence(collected, null));
				return;
			}
			if (age > 20 * 60) {
				stop(client);
				finish(
					id,
					"timeout",
					"E_TIMEOUT",
					collected > 0
						? "only collected " + collected + " of " + requested + " before the time limit"
						: "could not collect the dropped item in time",
					evidence(collected, "collection timed out")
				);
				return;
			}
			if (target == null || target.isRemoved()) {
				target = nearestItem(client);
				if (target == null) {
					if (collected > 0) {
						finish(
							id,
							"failed",
							"E_PRECONDITION",
							"only collected " + collected + " of " + requested,
							evidence(collected, "no matching dropped item remains")
						);
					} else {
						finish(
							id,
							"failed",
							"E_PRECONDITION",
							"dropped item disappeared without appearing in the inventory",
							evidence(0, "pickup was not confirmed by the inventory")
						);
					}
					return;
				}
				lastPosition = null;
				lastProgressAge = age;
				// The next item is somewhere else, so "already reached" has to be
				// re-earned; otherwise the stall check below fires while walking.
				reachedItem = false;
			}
			if (client.player.position().distanceTo(target.position()) < 1.1) reachedItem = true;
			if (target == null || !target.isAlive()) {
				return;
			}
			String blocked = CollectionEvidence.blockedReason(
				reachedItem,
				age - lastProgressAge,
				COLLECT_STALL_TICKS
			);
			if (blocked != null) {
				stop(client);
				finish(
					id,
					collected > 0 ? "failed" : "failed",
					"E_PRECONDITION",
					collected > 0
						? "only collected " + collected + " of " + requested + ": " + blocked
						: blocked,
					evidence(collected, blocked)
				);
				return;
			}
			if (lastPosition == null || target.position().distanceTo(lastPosition) > 0.05) {
				lastPosition = target.position();
				lastProgressAge = age;
			}
			Vec3 direction = target.position().subtract(client.player.position());
			double horizontal = Math.hypot(direction.x, direction.z);
			client.player.setYRot((float) Math.toDegrees(Math.atan2(-direction.x, direction.z)));
			if (
				horizontal > 0.01
					&& standingY(
						client,
						BlockPos.containing(
							client.player.getX() - Math.sin(Math.toRadians(client.player.getYRot())) * 0.65,
							client.player.getY(),
							client.player.getZ() + Math.cos(Math.toRadians(client.player.getYRot())) * 0.65
						)
					) == Integer.MIN_VALUE
			) {
				stop(client);
				finish(id, "failed", "E_PRECONDITION", "no safe standing approach to the dropped item", evidence(collected, "dangerous step"));
				return;
			}
			if (client.player.horizontalCollision && client.player.onGround()) {
				client.player.jumpFromGround();
			}
			if (client.player.input != null) setWalkInput(client, true);
			if (age % 20 == 0) send.accept(progress(id, "collecting", collected, requested));
		}

		private ItemEntity nearestItem(Minecraft client) {
			BlockPos origin = client.player.blockPosition();
			return client.level
				.getEntitiesOfClass(
					ItemEntity.class,
					client.player.getBoundingBox().inflate(COLLECT_SEARCH_RADIUS)
				)
				.stream()
				.filter(ItemEntity::isAlive)
				.filter(entity -> entity.blockPosition().distSqr(origin) <= COLLECT_SEARCH_RADIUS * COLLECT_SEARCH_RADIUS)
				.filter(this::matches)
				.min((left, right) -> Double.compare(left.distanceToSqr(client.player), right.distanceToSqr(client.player)))
				.orElse(null);
		}

		private boolean matches(ItemEntity entity) {
			ItemStack stack = entity.getItem();
			if (stack.isEmpty()) return false;
			return itemId == null || BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(itemId);
		}

		private int countInInventory(LocalPlayer player) {
			Item item = itemId == null ? null : BuiltInRegistries.ITEM.getValue(Identifier.parse(itemId));
			int total = 0;
			for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (stack.isEmpty()) continue;
				if (item == null || stack.getItem() == item) total += stack.getCount();
			}
			return total;
		}

		private JsonObject evidence(int gained, String problem) {
			JsonObject outcome = new JsonObject();
			outcome.addProperty(
				"summary",
				gained > 0
					? "collected " + gained + " x " + (itemId == null ? "item" : itemId)
					: "no item was confirmed in the inventory"
			);
			JsonArray changes = new JsonArray();
			if (gained > 0) {
				JsonObject change = new JsonObject();
				change.addProperty("kind", "item_collected");
				change.addProperty("detail", gained + " x " + (itemId == null ? "item" : itemId));
				changes.add(change);
			}
			outcome.add("changes", changes);
			if (problem != null) {
				outcome.addProperty("problem", problem);
				JsonArray unconfirmed = new JsonArray();
				if (gained == 0) unconfirmed.add("dropped item was not confirmed in the inventory");
				else unconfirmed.add("requested count was not reached");
				outcome.add("unconfirmed", unconfirmed);
			}
			return outcome;
		}

		@Override
		void stop(Minecraft client) {
			releaseWalkInput(client);
		}
	}

	/**
	 * Crafts through the vanilla recipe book so the server, not this client,
	 * decides which ingredients fit the grid. The task opens the nearest
	 * crafting table (or falls back to the 2x2 inventory grid), asks the server
	 * to place one batch, then takes the result and confirms the inventory
	 * gained that exact batch. The recipe is submitted again for later batches
	 * so the caller's count cannot stall after the first result.
	 */
	private static final class CraftTask extends Task {
		/**
		 * A remembered table can be dozens of blocks away after a mining trip.
		 * Fifteen seconds was tuned for a nearby table and made the body give
		 * up in the middle of a legitimate walk back.
		 */
		private static final int WALK_BUDGET_TICKS = 20 * 45;
		private static final int APPROACH_STALL_TICKS = 20 * 3;
		private static final double PROGRESS_EPSILON = 0.1;
		private final String itemId;
		private final int requested;
		private Item item;
		private boolean table;
		private BlockPos tablePos;
		private AbstractCraftingMenu menu;
		private boolean openedByTask;
		private boolean walking;
		private int walkingAge;
		private int lastWalkProgressAge;
		private double lastApproachDistance;
		private List<Vec3> approachWaypoints = List.of();
		private int approachWaypoint;
		private BlockPos approachTarget;
		private int nextApproachPlanAt;
		private int menuSubmittedAt = -1;
		private int inventorySubmittedAt = -1;
		private int gridReadyAt = -1;
		private int gridSubmitAt = -1;
		private Map<String, Integer> inputsBefore;
		private int resultSubmittedAt = -1;
		private int stableTicks;
		private Map<String, Integer> lastInputs;
		private Map<String, Integer> lastInventory;
		private int made;
		private Map<String, Integer> inventoryAtTake;
		private int resultAtTake;
		private PlacementInfo manualPlacement;
		private int manualSlot;
		private int manualPhase;
		private int manualSourceIndex = -1;
		private int manualTargetIndex = -1;
		private List<Integer> manualTargets = List.of();

		CraftTask(String id, String itemId, int requested) {
			super(id);
			this.itemId = itemId;
			this.requested = requested;
		}

		@Override
		boolean validate(Minecraft client) {
			if (!super.validate(client)) return false;
			if (requested <= 0) {
				validationError = "count must be positive";
				return false;
			}
			Identifier id = Identifier.tryParse(itemId);
			if (id == null || !BuiltInRegistries.ITEM.containsKey(id)) {
				validationError = "unknown item " + itemId;
				return false;
			}
			item = BuiltInRegistries.ITEM.getValue(id);
			return true;
		}

		@Override
		void start(Minecraft client) {
			tablePos = nearestCraftingTable(client);
			// A nearby table is a station candidate, not proof that the body is
			// at it. If the recipe also fits the 2x2 grid, walking across a
			// ravine to a distant table is unnecessary work and can stall the
			// whole goal. Only prefer the table when it is already interactable
			// or the item truly needs 3x3.
			table = tablePos != null
				&& (hasInventoryRecipe(client)
					? canInteract(client, client.player, tablePos)
					: true);
			walking = table && !canInteract(client, client.player, tablePos);
			if (tablePos != null) {
				lastApproachDistance = playerToTable(client.player);
				lastWalkProgressAge = 0;
			}
			send.accept(progress(id, walking ? "walking" : "opening", 0, requested));
		}

		@Override
		void tick(Minecraft client) {
			if (age > CRAFT_TOTAL_TIMEOUT) {
				stop(client);
				finish(
					id,
					"timeout",
					"E_TIMEOUT",
					made > 0
						? "only crafted " + made + " of " + requested + " before the time limit"
						: "crafting did not complete in time",
					evidence("crafting timed out")
				);
				return;
			}
			if (menu == null) {
				if (walking) {
					approach(client);
					return;
				}
				open(client);
				return;
			}
			craft(client);
		}

		@Override
		boolean keepScreen(Minecraft client) {
			return openedByTask || menuSubmittedAt >= 0 || inventorySubmittedAt >= 0;
		}

		private void approach(Minecraft client) {
			LocalPlayer player = client.player;
			MineTask.aimAt(player, Vec3.atCenterOf(tablePos));
			if (canInteract(client, player, tablePos)) {
				walking = false;
				releaseWalkInput(client);
				send.accept(progress(id, "opening", 0, requested));
				return;
			}
			walkingAge++;
			if (walkingAge > WALK_BUDGET_TICKS) {
				stop(client);
				finish(
					id,
					"timeout",
					"E_TIMEOUT",
					"could not reach the crafting table in time",
					evidence("crafting table approach timed out")
				);
				return;
			}
			Vec3 center = Vec3.atCenterOf(tablePos);
			if (!tablePos.equals(approachTarget) || walkingAge >= nextApproachPlanAt) {
				ApproachRoute.Route route = ApproachRoute.to(client, tablePos);
				if (route != null && route.waypoints().size() > 1) {
					approachWaypoints = route.waypoints();
					approachWaypoint = 1;
				} else {
					approachWaypoints = List.of();
					approachWaypoint = 0;
				}
				approachTarget = tablePos;
				nextApproachPlanAt = walkingAge + 20;
			}
			Vec3 step = approachWaypoints.size() > approachWaypoint
				? approachWaypoints.get(approachWaypoint)
				: center;
			while (
				approachWaypoint < approachWaypoints.size() - 1
					&& Math.hypot(step.x - player.getX(), step.z - player.getZ()) < 0.75
					&& Math.abs(step.y - player.getY()) < 1.25
			) {
				approachWaypoint++;
				step = approachWaypoints.get(approachWaypoint);
			}
			// Distance to the table, not to a replanned waypoint, is the
			// monotonic progress signal. The route is re-planned every
			// second; comparing against a changing waypoint could make a
			// player standing still look like it was moving backwards.
			double progressDistance = playerToTable(player);
			if (progressDistance + PROGRESS_EPSILON < lastApproachDistance) {
				lastApproachDistance = progressDistance;
				lastWalkProgressAge = walkingAge;
			} else if (walkingAge - lastWalkProgressAge > APPROACH_STALL_TICKS) {
				stop(client);
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"crafting table approach made no progress for 3 seconds",
					approachEvidence(client, "could not reach a safe interaction spot beside the table")
				);
				return;
			}
			double heading = Math.atan2(-(step.x - player.getX()), step.z - player.getZ());
			player.setYRot((float) Math.toDegrees(heading));
			Vec3 ahead = player.position().add(
				-Math.sin(heading) * 0.6,
				0,
				Math.cos(heading) * 0.6
			);
			BlockPos foot = BlockPos.containing(ahead.x, player.getY() - 0.5, ahead.z);
			boolean ledge = client.level.getBlockState(foot).isAir()
				&& client.level.getBlockState(foot.below()).isAir();
			if (ledge && player.onGround()) {
				stop(client);
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"dangerous drop on the route to the crafting table",
					approachEvidence(client, "refused an unsafe crafting table approach")
				);
				return;
			}
			if (player.horizontalCollision && player.onGround()) player.jumpFromGround();
			if (player.input != null) setWalkInput(client, true);
			if (walkingAge % 20 == 0) {
				send.accept(progress(id, "walking", (int) Math.round(player.position().distanceTo(center)), 0));
			}
		}

		private JsonObject approachEvidence(Minecraft client, String problem) {
			JsonObject data = evidence(problem);
			if (tablePos != null) {
				JsonObject target = new JsonObject();
				target.addProperty("x", tablePos.getX());
				target.addProperty("y", tablePos.getY());
				target.addProperty("z", tablePos.getZ());
				data.add("table", target);
			}
			BlockPos player = client.player.blockPosition();
			data.addProperty("playerX", player.getX());
			data.addProperty("playerY", player.getY());
			data.addProperty("playerZ", player.getZ());
			data.addProperty("walkingAge", walkingAge);
			data.addProperty("ticksWithoutProgress", walkingAge - lastWalkProgressAge);
			data.addProperty("waypoints", approachWaypoints.size());
			data.addProperty("waypoint", approachWaypoint);
			return data;
		}

		private double playerToTable(LocalPlayer player) {
			return tablePos == null
				? Double.POSITIVE_INFINITY
				: player.position().distanceTo(Vec3.atCenterOf(tablePos));
		}

		private void open(Minecraft client) {
			if (table) {
				if (tablePos == null || !client.level.getBlockState(tablePos).is(Blocks.CRAFTING_TABLE)) {
					finish(id, "failed", "E_WORLD_CHANGED", "crafting table disappeared", evidence("the crafting table was removed"));
					return;
				}
				if (!canInteract(client, client.player, tablePos)) {
					walking = true;
					lastApproachDistance = playerToTable(client.player);
					lastWalkProgressAge = walkingAge;
					return;
				}
			}
			if (menuSubmittedAt >= 0 || inventorySubmittedAt >= 0) {
				AbstractCraftingMenu opened = client.screen instanceof AbstractContainerScreen<?> screen
					&& screen.getMenu() instanceof AbstractCraftingMenu craftMenu
					? craftMenu
					: null;
				if (opened == null) {
					if (
						(menuSubmittedAt >= 0 && age - menuSubmittedAt > CRAFT_MENU_TIMEOUT)
							|| (inventorySubmittedAt >= 0 && age - inventorySubmittedAt > CRAFT_MENU_TIMEOUT)
					) {
						finish(id, "failed", "E_PRECONDITION", "crafting screen did not open", evidence("no crafting menu opened"));
					}
					return;
				}
				if (table && !(opened instanceof net.minecraft.world.inventory.CraftingMenu)) {
					finish(id, "failed", "E_WORLD_CHANGED", "a different menu replaced the crafting table", evidence("menu identity changed"));
					closeOwnMenu(client);
					return;
				}
				if (!table && !(opened instanceof net.minecraft.world.inventory.InventoryMenu)) {
					finish(id, "failed", "E_WORLD_CHANGED", "a different menu replaced the inventory", evidence("menu identity changed"));
					closeOwnMenu(client);
					return;
				}
				menu = opened;
				openedByTask = true;
				menuSubmittedAt = -1;
				inventorySubmittedAt = -1;
				send.accept(progress(id, "finding_recipe", 0, requested));
				return;
			}
			if (table) {
				Vec3 center = Vec3.atCenterOf(tablePos);
				MineTask.aimAt(client.player, center);
				BlockHitResult hit = MineTask.clip(client, client.player, center);
				if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(tablePos)) {
					// A blocked face does not make the 2x2 inventory grid
					// unusable. Prefer it over reporting a false "no recipe"
					// failure when the requested recipe fits.
					if (hasInventoryRecipe(client)) {
						table = false;
						walking = false;
						approachTarget = null;
						open(client);
						return;
					}
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"crafting table is outside reach or not visible",
						evidence("could not aim at the table")
					);
					return;
				}
				releaseWalkInput(client);
				menuSubmittedAt = age;
				client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, hit);
				return;
			}

			// Opening the inventory is a client prediction backed by the
			// server's OPEN_INVENTORY command; the task only proceeds once a
			// real inventory menu exists.
			releaseWalkInput(client);
			client.player.sendOpenInventory();
			client.setScreen(new InventoryScreen(client.player));
			inventorySubmittedAt = age;
		}

		private void craft(Minecraft client) {
			if (!openedByTask) {
				finish(id, "failed", "E_PRECONDITION", "crafting menu was not opened by this task", evidence("unowned menu"));
				return;
			}
			AbstractCraftingMenu current = client.screen instanceof AbstractContainerScreen<?> screen
				&& screen.getMenu() instanceof AbstractCraftingMenu value
				? value
				: null;
			if (current == null) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					made > 0
						? "only crafted " + made + " of " + requested + " before the menu closed"
						: "crafting screen closed before any craft was confirmed",
					evidence("the crafting screen closed")
				);
				closeOwnMenu(client);
				return;
			}
			if (current != menu) {
				finish(id, "failed", "E_WORLD_CHANGED", "a different crafting menu replaced the crafting screen", evidence("menu identity changed"));
				closeOwnMenu(client);
				return;
			}
			if (!current.stillValid(client.player)) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					made > 0 ? "only crafted " + made + " of " + requested + " before the table became unreachable" : "crafting table is no longer reachable",
					evidence("menu became invalid")
				);
				closeOwnMenu(client);
				return;
			}
			if (resultSubmittedAt < 0 && gridSubmitAt < 0 && gridReadyAt < 0) {
				// Taking one result can leave enough ingredients for the
				// recipe book to refill the output slot immediately. Take
				// that natural next batch before asking the server to place
				// the recipe again.
				Slot existing = current.getResultSlot();
				if (
					existing != null
						&& !existing.getItem().isEmpty()
						&& existing.getItem().getItem() == item
				) {
					gridReadyAt = age;
				}
			}
			if (resultSubmittedAt >= 0) {
				Map<String, Integer> inputs = gridCounts(current);
				Map<String, Integer> inventory = inventoryCounts(client.player);
				if (!inputs.equals(lastInputs) || !inventory.equals(lastInventory)) {
					lastInputs = inputs;
					lastInventory = inventory;
					stableTicks = 0;
					return;
				}
				stableTicks++;
				if (stableTicks < CRAFT_STABLE_TICKS) return;
				if (!CraftEvidence.transferConfirmed(resultAtTake, inventoryAtTake, inventory, itemId, resultAtTake)) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						made > 0
							? "only crafted " + made + " of " + requested + " before the result was not confirmed"
							: "the crafting result was not confirmed by the inventory gain",
						evidence("the result was not confirmed by the inventory gain")
					);
					closeOwnMenu(client);
					return;
				}
				made += resultAtTake;
				if ("minecraft:crafting_table".equals(itemId)) {
					// Crafting a table is the durable evidence even if the
					// body places it later; it is not the same as an unverified
					// "maybe a table exists somewhere".
					craftingTableCrafted = true;
				}
				if (made >= requested) {
					finish(id, "completed", null, null, evidence(null));
					return;
				}
				inventoryAtTake = inventory;
				resultAtTake = 0;
				resultSubmittedAt = -1;
				stableTicks = 0;
				lastInputs = null;
				lastInventory = null;
				// `useMaxItems=false` requests one batch. The next tick finds
				// the recipe again so a count above one batch gets submitted
				// repeatedly without assuming leftover ingredients in the grid.
				send.accept(progress(id, "submitting_recipe", made, requested));
				return;
			}
			if (gridSubmitAt >= 0) {
				Map<String, Integer> inputs = gridCounts(current);
				Slot result = current.getResultSlot();
				boolean resultReady = result != null
					&& !result.getItem().isEmpty()
					&& result.getItem().getItem() == item;
				if (!inputs.equals(inputsBefore) || resultReady) {
					gridReadyAt = age;
					gridSubmitAt = -1;
					send.accept(progress(id, "crafting", made, requested));
				} else if (age - gridSubmitAt > CRAFT_GRID_TIMEOUT) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"the server did not place ingredients in the grid",
						evidence("the server did not place ingredients in the grid")
					);
					closeOwnMenu(client);
					return;
				}
				if (gridSubmitAt >= 0) return;
			}
			if (gridReadyAt >= 0) {
				Slot result = current.getResultSlot();
				if (result == null || result.getItem().isEmpty() || result.getItem().getItem() != item) {
					if (age - gridReadyAt > CRAFT_RESULT_TIMEOUT) {
						finish(
							id,
							"failed",
							"E_PRECONDITION",
							table
								? "the crafting table did not produce " + itemId
								: "the 2x2 inventory grid did not produce " + itemId,
							evidence(
								table
									? "the crafting table did not produce the requested item"
									: "the 2x2 inventory grid did not produce the requested item"
							)
						);
						closeOwnMenu(client);
						return;
					}
					return;
				}
				if (!hasRoomFor(client, result.getItem())) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"the inventory has no room for the crafting result",
						evidence("the inventory has no room for the crafting result")
					);
					closeOwnMenu(client);
					return;
				}
				gridReadyAt = -1;
				resultSubmittedAt = age;
				inventoryAtTake = inventoryCounts(client.player);
				resultAtTake = result.getItem().getCount();
				int resultIndex = resultSlotIndex(current, result);
				if (resultIndex < 0) {
					finish(id, "failed", "E_PRECONDITION", "crafting result slot is not addressable", evidence("result slot not found"));
					closeOwnMenu(client);
					return;
				}
				client.gameMode.handleInventoryMouseClick(current.containerId, resultIndex, 0, ClickType.QUICK_MOVE, client.player);
				send.accept(progress(id, "taking_result", made, requested));
				return;
			}
			if (manualPlacement != null) {
				manualPlace(client, current);
				return;
			}

			RecipeChoice choice = findRecipe(client);
			if (choice == null) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					table
						? "no synced crafting table recipe produces " + itemId
						: "no synced 2x2 inventory recipe produces " + itemId,
					evidence(
						table
							? "no synced crafting table recipe produces " + itemId
							: "no synced 2x2 inventory recipe produces " + itemId
					)
				);
				closeOwnMenu(client);
				return;
			}
			if (choice.placement() != null && !recipeBookContains(client, choice.id())) {
				// The vanilla server still rejects a placement packet for a
				// recipe that is not in the player's recipe book, even if the
				// ingredients are present. A fresh world has not unlocked the
				// plank recipe yet, so place the ingredients ourselves. The
				// server still validates each click and computes the result.
				if (!choice.craftable()) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"the inventory is missing ingredients for " + itemId,
						evidence("the inventory is missing ingredients for the requested item")
					);
					closeOwnMenu(client);
					return;
				}
				if (!hasRoomFor(client, new ItemStack(item, choice.output()))) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"the inventory has no room for the crafting result",
						evidence("the inventory has no room for the crafting result")
					);
					closeOwnMenu(client);
					return;
				}
				if (!startManualPlacement(current, choice)) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"the recipe can be laid out but its ingredients are missing",
						evidence("the recipe can be laid out but its ingredients are missing")
					);
					closeOwnMenu(client);
					return;
				}
				return;
			}
			inputsBefore = gridCounts(current);
			gridSubmitAt = age;
			// The server can accept the packet and still decline to place
			// anything when ingredients are missing. Distinguish that from
			// a recipe/grid failure, and use the 2x2 grid when the table
			// path cannot satisfy the recipe.
			if (!choice.craftable()) {
				if (table && hasInventoryRecipe(client)) {
					table = false;
					tablePos = null;
					closeOwnMenu(client);
					open(client);
					return;
				}
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"the inventory is missing ingredients for " + itemId,
					evidence("the inventory is missing ingredients for the requested item")
				);
				closeOwnMenu(client);
				return;
			}
			ItemStack expected = new ItemStack(item, choice.output());
			if (!hasRoomFor(client, expected)) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"the inventory has no room for the crafting result",
					evidence("the inventory has no room for the crafting result")
				);
				closeOwnMenu(client);
				return;
			}
			client.gameMode.handlePlaceRecipe(current.containerId, choice.id(), false);
			send.accept(progress(id, "placing_ingredients", made, requested));
		}

		private boolean startManualPlacement(AbstractCraftingMenu current, RecipeChoice choice) {
			PlacementInfo placement = choice.placement();
			if (placement == null || placement.isImpossibleToPlace()) return false;
			List<Slot> grid = current.getInputGridSlots();
			if (grid.size() < placement.slotsToIngredientIndex().size()) return false;
			manualTargets = CraftGridLayout.centeredTargets(
				placement.slotsToIngredientIndex().size(),
				choice.width(),
				choice.height(),
				current.getGridWidth(),
				current.getGridHeight()
			);
			if (manualTargets.size() != placement.slotsToIngredientIndex().size()) return false;
			// Refuse to start unless every demanded cell has a matching stack
			// somewhere in the player's inventory. This keeps a half-placed
			// grid from looking like a server rejection.
			for (int index = 0; index < placement.slotsToIngredientIndex().size(); index++) {
				int ingredientIndex = placement.slotsToIngredientIndex().getInt(index);
				if (ingredientIndex < 0) continue;
				if (ingredientIndex >= placement.ingredients().size()) return false;
				var ingredient = placement.ingredients().get(ingredientIndex);
				int gridIndex = manualTargets.get(index);
				if (gridIndex < 0 || gridIndex >= grid.size()) return false;
				final Slot gridSlot = grid.get(gridIndex);
				boolean available = current.slots.stream().anyMatch(slot ->
					!slot.getItem().isEmpty()
						&& slot != gridSlot
						&& ingredient.test(slot.getItem())
				);
				if (!available) return false;
			}
			manualPlacement = placement;
			manualSlot = 0;
			manualPhase = 0;
			manualSourceIndex = -1;
			manualTargetIndex = -1;
			// The manual state machine, not the packet wait loop, owns the
			// grid until every cell is filled.
			gridSubmitAt = -1;
			send.accept(progress(id, "placing_ingredients", made, requested));
			return true;
		}

		private void manualPlace(Minecraft client, AbstractCraftingMenu current) {
			List<Slot> grid = current.getInputGridSlots();
			while (
				manualSlot < manualPlacement.slotsToIngredientIndex().size()
					&& manualPlacement.slotsToIngredientIndex().getInt(manualSlot) < 0
			) {
				manualSlot++;
			}
			if (manualSlot >= manualPlacement.slotsToIngredientIndex().size()) {
				manualPlacement = null;
				gridReadyAt = age;
				send.accept(progress(id, "crafting", made, requested));
				return;
			}
			int ingredientIndex = manualPlacement.slotsToIngredientIndex().getInt(manualSlot);
			if (ingredientIndex < 0 || ingredientIndex >= manualPlacement.ingredients().size()) {
				failManualPlacement(client, "the recipe layout references an unknown ingredient");
				return;
			}
			var ingredient = manualPlacement.ingredients().get(ingredientIndex);
			int targetIndex = manualTargetIndex;
			if (targetIndex < 0) {
				int gridIndex = manualTargets.get(manualSlot);
				if (gridIndex < 0 || gridIndex >= grid.size()) {
					failManualPlacement(client, "the recipe layout points outside the crafting grid");
					return;
				}
				targetIndex = slotIndex(current, grid.get(gridIndex));
			}
			if (targetIndex < 0) {
				failManualPlacement(client, "the crafting grid is already full");
				return;
			}
			Slot target = current.getSlot(targetIndex);
			if (manualPhase == 0) {
				if (!target.getItem().isEmpty()) {
					manualTargetIndex = -1;
					manualSlot++;
					manualSourceIndex = -1;
					return;
				}
				int source = findIngredientSlot(current, ingredient, target);
				if (source < 0) {
					failManualPlacement(client, "no inventory slot contains the next ingredient");
					return;
				}
				manualSourceIndex = source;
				manualTargetIndex = targetIndex;
				client.gameMode.handleInventoryMouseClick(
					current.containerId,
					source,
					0,
					ClickType.PICKUP,
					client.player
				);
				manualPhase = 1;
				return;
			}
			if (manualPhase == 1) {
				if (current.getCarried().isEmpty() || !ingredient.test(current.getCarried())) {
					failManualPlacement(client, "the ingredient was not picked up");
					return;
				}
				client.gameMode.handleInventoryMouseClick(
					current.containerId,
					targetIndex,
					1,
					ClickType.PICKUP,
					client.player
				);
				manualPhase = 2;
				return;
			}
			CraftMateBodyClient.LOGGER.info(
				"craft manual slot={} grid={} carried={} result={}",
				manualSlot,
				gridCounts(current),
				current.getCarried(),
				current.getResultSlot().getItem()
			);
			if (!current.getCarried().isEmpty() && manualSourceIndex >= 0) {
				client.gameMode.handleInventoryMouseClick(
					current.containerId,
					manualSourceIndex,
					0,
					ClickType.PICKUP,
					client.player
				);
			}
			manualTargetIndex = -1;
			manualSlot++;
			manualPhase = 0;
			manualSourceIndex = -1;
		}

		private void failManualPlacement(Minecraft client, String problem) {
			finish(id, "failed", "E_PRECONDITION", problem, evidence(problem));
			closeOwnMenu(client);
		}

		private int findIngredientSlot(AbstractCraftingMenu current, net.minecraft.world.item.crafting.Ingredient ingredient, Slot target) {
			for (int index = 0; index < current.slots.size(); index++) {
				Slot slot = current.getSlot(index);
				if (slot == target || slot == current.getResultSlot()) continue;
				if (current.getInputGridSlots().contains(slot)) continue;
				if (!slot.getItem().isEmpty() && ingredient.test(slot.getItem())) return index;
			}
			return -1;
		}

		private int slotIndex(AbstractCraftingMenu current, Slot slot) {
			for (int index = 0; index < current.slots.size(); index++) {
				if (current.getSlot(index) == slot) return index;
			}
			return -1;
		}

		private boolean recipeBookContains(Minecraft client, RecipeDisplayId id) {
			for (RecipeCollection collection : client.player.getRecipeBook().getCollections()) {
				for (RecipeDisplayEntry entry : collection.getRecipes()) {
					if (entry.id().equals(id)) return true;
				}
			}
			return false;
		}

		private boolean hasRoomFor(Minecraft client, ItemStack result) {
			Inventory inventory = client.player.getInventory();
			int emptySlots = 0;
			int matchingFree = 0;
			for (int index = 0; index < Inventory.INVENTORY_SIZE; index++) {
				ItemStack stack = inventory.getItem(index);
				if (stack.isEmpty()) {
					emptySlots++;
					continue;
				}
				if (ItemStack.isSameItemSameComponents(stack, result)) {
					matchingFree += Math.min(stack.getMaxStackSize(), result.getMaxStackSize()) - stack.getCount();
				}
			}
			return CraftEvidence.inventoryHasRoom(
				emptySlots,
				matchingFree,
				result.getCount(),
				result.getMaxStackSize()
			);
		}

		private RecipeChoice findRecipe(Minecraft client) {
			int width = menu.getGridWidth();
			int height = menu.getGridHeight();
			StackedItemContents contents = new StackedItemContents();
			client.player.getInventory().fillStackedContents(contents);
			RecipeChoice fallback = null;
			int collections = 0;
			int entries = 0;
			int matching = 0;
			int craftableMatching = 0;
			for (RecipeCollection collection : client.player.getRecipeBook().getCollections()) {
				collections++;
				for (RecipeDisplayEntry entry : collection.getRecipes()) {
					entries++;
					RecipeDisplay display = entry.display();
					CraftMateBodyClient.LOGGER.info(
						"craft book entry id={} grid={}x{} results={}",
						entry.id(),
						display instanceof ShapedCraftingRecipeDisplay shaped0 ? shaped0.width() : -1,
						display instanceof ShapedCraftingRecipeDisplay shaped1 ? shaped1.height() : -1,
						display.result().resolveForStacks(SlotDisplayContext.fromLevel(client.level))
							.stream()
							.filter(stack -> !stack.isEmpty())
							.map(stack -> BuiltInRegistries.ITEM.getKey(stack.getItem()) + "x" + stack.getCount())
							.toList()
					);
					if (!produces(display, client)) continue;
					matching++;
					if (!fits(display, width, height)) continue;
					int output = outputCount(display, client);
					if (output <= 0) continue;
					boolean craftable = entry.canCraft(contents);
					if (craftable) craftableMatching++;
					RecipeChoice choice = new RecipeChoice(entry.id(), output, craftable, null, 0, 0);
					if (craftable && made + output >= requested) {
						CraftMateBodyClient.LOGGER.info(
							"craft recipe item={} collections={} entries={} matching={} craftable={} chosen={}",
							itemId, collections, entries, matching, craftableMatching, entry.id()
						);
						return choice;
					}
					if (fallback == null || (craftable && !fallback.craftable())) fallback = choice;
				}
			}
			CraftMateBodyClient.LOGGER.info(
				"craft recipe item={} collections={} entries={} matching={} craftable={} fallback={}",
				itemId, collections, entries, matching, craftableMatching, fallback != null
			);
			if (fallback != null) return fallback;
			// The recipe book only carries recipes this player has unlocked.
			// A fresh world has no plank recipe until the player has crafted
			// something from wood, which makes a legitimate craft impossible
			// even though the server accepts it. In singleplayer the client
			// can read the integrated server's authoritative recipe manager,
			// so use its displays as a fallback. The server still validates
			// the ingredients when the placement packet arrives.
			return findServerRecipe(client, contents, width, height);
		}

		private RecipeChoice findServerRecipe(
			Minecraft client,
			StackedItemContents contents,
			int width,
			int height
		) {
			MinecraftServer server = client.getSingleplayerServer();
			if (server == null) return null;
			RecipeManager manager = server.getRecipeManager();
			int recipes = 0;
			int displays = 0;
			int matching = 0;
			RecipeChoice fallback = null;
			for (RecipeHolder<?> holder : manager.getRecipes()) {
				if (!(holder.value() instanceof CraftingRecipe)) continue;
				recipes++;
				List<RecipeChoice> found = new ArrayList<>();
				manager.listDisplaysForRecipe(holder.id(), entry -> {
					RecipeDisplay display = entry.display();
					if (!produces(display, client)) return;
					if (!fits(display, width, height)) return;
					int output = outputCount(display, client);
					if (output <= 0) return;
					found.add(new RecipeChoice(
						entry.id(),
						output,
						entry.canCraft(contents),
						holder.value().placementInfo(),
						holder.value() instanceof ShapedRecipe shaped
							? shaped.getWidth()
							: menu.getGridWidth(),
						holder.value() instanceof ShapedRecipe shaped
							? shaped.getHeight()
							: menu.getGridHeight()
					));
				});
				displays += found.size();
				for (RecipeChoice choice : found) {
					matching++;
					if (choice.craftable() && made + choice.output() >= requested) {
						CraftMateBodyClient.LOGGER.info(
							"craft server recipe item={} recipes={} displays={} matching={} chosen={}",
							itemId, recipes, displays, matching, choice.id()
						);
						return choice;
					}
					if (fallback == null || (choice.craftable() && !fallback.craftable())) {
						fallback = choice;
					}
				}
			}
			CraftMateBodyClient.LOGGER.info(
				"craft server recipe item={} recipes={} displays={} matching={} fallback={}",
				itemId, recipes, displays, matching, fallback != null
			);
			return fallback;
		}

		private boolean hasInventoryRecipe(Minecraft client) {
			for (RecipeCollection collection : client.player.getRecipeBook().getCollections()) {
				for (RecipeDisplayEntry entry : collection.getRecipes()) {
					RecipeDisplay display = entry.display();
					if (fits(display, 2, 2) && produces(display, client)) return true;
				}
			}
			return false;
		}

		private boolean fits(RecipeDisplay display, int width, int height) {
			if (display instanceof ShapedCraftingRecipeDisplay shaped) {
				return shaped.width() <= width && shaped.height() <= height;
			}
			if (display instanceof ShapelessCraftingRecipeDisplay shapeless) {
				return shapeless.ingredients().size() <= width * height;
			}
			return false;
		}

		private boolean produces(RecipeDisplay display, Minecraft client) {
			SlotDisplay result = display.result();
			var context = SlotDisplayContext.fromLevel(client.level);
			return result.resolveForStacks(context).stream().anyMatch(stack -> !stack.isEmpty() && stack.getItem() == item);
		}

		private int outputCount(RecipeDisplay display, Minecraft client) {
			SlotDisplay result = display.result();
			var context = SlotDisplayContext.fromLevel(client.level);
			return result.resolveForStacks(context).stream()
				.filter(stack -> !stack.isEmpty() && stack.getItem() == item)
				.mapToInt(ItemStack::getCount)
				.max()
				.orElse(0);
		}

		private Map<String, Integer> gridCounts(AbstractCraftingMenu current) {
			Map<String, Integer> counts = new LinkedHashMap<>();
			for (Slot slot : current.getInputGridSlots()) {
				ItemStack stack = slot.getItem();
				if (stack.isEmpty()) continue;
				String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				counts.merge(id, stack.getCount(), Integer::sum);
			}
			return counts;
		}

		private int resultSlotIndex(AbstractCraftingMenu current, Slot result) {
			for (int index = 0; index < current.slots.size(); index++) {
				if (current.getSlot(index) == result) return index;
			}
			return -1;
		}

		private Map<String, Integer> inventoryCounts(LocalPlayer player) {
			Map<String, Integer> counts = new LinkedHashMap<>();
			Inventory inventory = player.getInventory();
			for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = inventory.getItem(slot);
				if (stack.isEmpty()) continue;
				String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				counts.merge(id, stack.getCount(), Integer::sum);
			}
			return counts;
		}

		private BlockPos nearestCraftingTable(Minecraft client) {
			BlockPos origin = client.player.blockPosition();
			BlockPos best = null;
			double bestDistance = Double.POSITIVE_INFINITY;
			for (BlockPos pos : BlockPos.betweenClosed(
				origin.offset(-CRAFT_SEARCH_RADIUS, -8, -CRAFT_SEARCH_RADIUS),
				origin.offset(CRAFT_SEARCH_RADIUS, 8, CRAFT_SEARCH_RADIUS)
			)) {
				BlockPos candidate = pos.immutable();
				if (candidate.distSqr(origin) > (double) CRAFT_SEARCH_RADIUS * CRAFT_SEARCH_RADIUS) continue;
				if (!client.level.getBlockState(candidate).is(Blocks.CRAFTING_TABLE)) continue;
				double distance = client.player.distanceToSqr(
					candidate.getX() + 0.5,
					candidate.getY() + 0.5,
					candidate.getZ() + 0.5
				);
				if (distance < bestDistance) {
					bestDistance = distance;
					best = candidate;
				}
			}
			// The observation cube is small compared to a survival walk. If
			// this body placed a table earlier, that remembered position is a
			// real station even when it is outside the cube; walk back to it
			// rather than reporting that no table exists.
			BlockPos remembered = placedCraftingTable;
			if (
				remembered != null
				&& client.level.getBlockState(remembered).is(Blocks.CRAFTING_TABLE)
			) {
				double distance = client.player.distanceToSqr(
					remembered.getX() + 0.5,
					remembered.getY() + 0.5,
					remembered.getZ() + 0.5
				);
				if (distance < bestDistance) best = remembered;
			}
			return best;
		}

		private boolean canInteract(Minecraft client, LocalPlayer player, BlockPos target) {
			return player.isWithinBlockInteractionRange(target, 0.0)
				&& MineTask.clip(client, player, Vec3.atCenterOf(target)).getBlockPos().equals(target);
		}

		private JsonObject evidence(String problem) {
			JsonObject outcome = new JsonObject();
			outcome.addProperty(
				"summary",
				made > 0
					? "crafted " + made + " x " + itemId
					: "no craft was confirmed"
			);
			JsonArray changes = new JsonArray();
			if (made > 0) {
				JsonObject change = new JsonObject();
				change.addProperty("kind", "item_crafted");
				change.addProperty("detail", made + " x " + itemId);
				if (tablePos != null) change.add("position", position(tablePos));
				changes.add(change);
			}
			outcome.add("changes", changes);
			if (problem != null) {
				outcome.addProperty("problem", problem);
				JsonArray unconfirmed = new JsonArray();
				unconfirmed.add("craft result was not confirmed by ingredient consumption and inventory gain");
				outcome.add("unconfirmed", unconfirmed);
			}
			return outcome;
		}

		private void closeOwnMenu(Minecraft client) {
			if (!openedByTask && menuSubmittedAt < 0 && inventorySubmittedAt < 0) return;
			openedByTask = false;
			menuSubmittedAt = -1;
			inventorySubmittedAt = -1;
			menu = null;
			if (client.player != null && client.screen instanceof AbstractContainerScreen<?>) {
				client.player.closeContainer();
			} else if (client.screen instanceof AbstractContainerScreen<?>) {
				client.setScreen(null);
			}
		}

		@Override
		void stop(Minecraft client) {
			releaseWalkInput(client);
			closeOwnMenu(client);
		}

		private record RecipeChoice(
			RecipeDisplayId id,
			int output,
			boolean craftable,
			PlacementInfo placement,
			int width,
			int height
		) {
		}
	}

	private static final class DepositTask extends Task {
		private static final int WALK_BUDGET_TICKS = 20 * 15;
		private static final int APPROACH_STALL_TICKS = 20 * 3;
		private static final int MENU_TIMEOUT_TICKS = 20;
		private final String itemId;
		private final BlockPos requestedContainer;
		private BlockPos containerPos;
		private BaseContainerBlockEntity container;
		private AbstractContainerMenu menu;
		private boolean openedByTask;
		private boolean walking;
		private int walkingAge;
		private int lastWalkProgressAge;
		private double lastApproachDistance = Double.POSITIVE_INFINITY;
		private List<Vec3> approachWaypoints = List.of();
		private int approachWaypoint;
		private BlockPos approachTarget;
		private int nextApproachPlanAt;
		private int menuSubmittedAt = -1;
		private int stableTicks;
		private Map<String, Integer> settledInventory;
		private Map<String, Integer> settledContainer;
		private Map<String, Integer> lastInventory;
		private Map<String, Integer> lastContainer;
		private boolean transferSubmitted;
		private int transferStartedAt = -1;
		private int lastConfirmedAt = -1;
		private int moved;
		private final Map<String, Integer> deposited = new java.util.LinkedHashMap<>();

		DepositTask(String id, String itemId, BlockPos requestedContainer) {
			super(id);
			this.itemId = itemId;
			this.requestedContainer = requestedContainer;
		}

		@Override
		boolean validate(Minecraft client) {
			if (!super.validate(client)) return false;
			if (itemId != null) {
				Identifier id = Identifier.tryParse(itemId);
				if (id == null || !BuiltInRegistries.ITEM.containsKey(id)) {
					validationError = "unknown item " + itemId;
					return false;
				}
			}
			return true;
		}

		@Override
		void start(Minecraft client) {
			if (!hasEligibleItems(client)) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					itemId == null
						? "inventory has no items that can be deposited"
						: "no " + itemId + " in the inventory",
					evidence(null)
				);
				return;
			}
			containerPos = requestedContainer == null
				? nearestContainer(client)
				: requestedContainer.immutable();
			if (containerPos == null) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"no container with storage within " + CONTAINER_SEARCH_RADIUS + " blocks",
					evidence(null)
				);
				return;
			}
			container = containerAt(client, containerPos);
			if (container == null) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					requestedContainer == null
						? "nearest block entity is not a usable storage container"
						: "requested position has no usable storage container",
					evidence(null)
				);
				return;
			}
			if (!client.level.getBlockState(containerPos).getFluidState().isEmpty()) {
				finish(id, "failed", "E_PRECONDITION", "container is in a fluid", evidence(null));
				return;
			}
			walking = !canInteract(client, client.player, containerPos);
			lastApproachDistance = Double.POSITIVE_INFINITY;
			send.accept(progress(id, walking ? "walking" : "opening", 0, 1));
		}

		@Override
		void tick(Minecraft client) {
			if (containerPos == null) {
				finish(id, "failed", "E_PRECONDITION", "container position is missing", evidence(null));
				return;
			}
			if (menu == null) {
				if (walking) {
					approach(client);
					return;
				}
				open(client);
				return;
			}
			transfer(client);
		}

		@Override
		boolean keepScreen(Minecraft client) {
			return openedByTask || menuSubmittedAt >= 0;
		}

		private void approach(Minecraft client) {
			LocalPlayer player = client.player;
			MineTask.aimAt(player, Vec3.atCenterOf(containerPos));
			if (canInteract(client, player, containerPos)) {
				walking = false;
				releaseWalkInput(client);
				send.accept(progress(id, "opening", 0, 1));
				return;
			}
			walkingAge++;
			if (walkingAge > WALK_BUDGET_TICKS) {
				stop(client);
				finish(
					id,
					"timeout",
					"E_TIMEOUT",
					"could not reach the container in time",
					evidence("container approach timed out")
				);
				return;
			}
			Vec3 center = Vec3.atCenterOf(containerPos);
			if (!containerPos.equals(approachTarget) || walkingAge >= nextApproachPlanAt) {
				ApproachRoute.Route route = ApproachRoute.to(client, containerPos);
				if (route != null && route.waypoints().size() > 1) {
					approachWaypoints = route.waypoints();
					approachWaypoint = 1;
				} else {
					approachWaypoints = List.of();
					approachWaypoint = 0;
				}
				approachTarget = containerPos;
				nextApproachPlanAt = walkingAge + 20;
			}
			Vec3 step = approachWaypoints.size() > approachWaypoint
				? approachWaypoints.get(approachWaypoint)
				: center;
			while (
				approachWaypoint < approachWaypoints.size() - 1
					&& Math.hypot(step.x - player.getX(), step.z - player.getZ()) < 0.75
					&& Math.abs(step.y - player.getY()) < 1.25
			) {
				approachWaypoint++;
				step = approachWaypoints.get(approachWaypoint);
			}
			double progressDistance = player.position().distanceTo(step);
			if (progressDistance + 0.1 < lastApproachDistance) {
				lastApproachDistance = progressDistance;
				lastWalkProgressAge = walkingAge;
			} else if (walkingAge - lastWalkProgressAge > APPROACH_STALL_TICKS) {
				stop(client);
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"container approach made no progress for 3 seconds",
					evidence("could not reach a safe interaction spot beside the container")
				);
				return;
			}
			double heading = Math.atan2(-(step.x - player.getX()), step.z - player.getZ());
			player.setYRot((float) Math.toDegrees(heading));
			Vec3 ahead = player.position().add(
				-Math.sin(heading) * 0.6,
				0,
				Math.cos(heading) * 0.6
			);
			BlockPos foot = BlockPos.containing(ahead.x, player.getY() - 0.5, ahead.z);
			boolean ledge = client.level.getBlockState(foot).isAir()
				&& client.level.getBlockState(foot.below()).isAir();
			if (ledge && player.onGround()) {
				stop(client);
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"dangerous drop on the route to the container",
					evidence("refused an unsafe container approach")
				);
				return;
			}
			if (player.horizontalCollision && player.onGround()) player.jumpFromGround();
			if (player.input != null) setWalkInput(client, true);
			if (walkingAge % 20 == 0) {
				send.accept(progress(id, "walking", (int) Math.round(player.position().distanceTo(center)), 0));
			}
		}

		private void open(Minecraft client) {
			BlockPos current = containerPos;
			if (current == null || containerAt(client, current) == null) {
				finish(id, "failed", "E_WORLD_CHANGED", "container disappeared", evidence("container was removed"));
				return;
			}
			if (!canInteract(client, client.player, current)) {
				walking = true;
				lastApproachDistance = Double.POSITIVE_INFINITY;
				lastWalkProgressAge = walkingAge;
				return;
			}
			if (menuSubmittedAt >= 0) {
				AbstractContainerScreen<?> screen = client.screen instanceof AbstractContainerScreen<?> value
					? value
					: null;
				if (screen != null) {
					openedByTask = true;
					menu = screen.getMenu();
					if (!menu.stillValid(client.player)) {
						closeOwnMenu(client);
						finish(
							id,
							"failed",
							"E_PRECONDITION",
							"container is no longer reachable after opening",
							evidence("menu became invalid")
						);
						return;
					}
					lastInventory = inventoryCounts(client.player);
					lastContainer = containerCounts(menu, containerSlotCount(menu));
					settledInventory = lastInventory;
					settledContainer = lastContainer;
					stableTicks = 0;
					menuSubmittedAt = -1;
					transferStartedAt = age;
					lastConfirmedAt = age;
					walking = false;
					send.accept(progress(id, "transferring", 0, 1));
					return;
				}
				if (age - menuSubmittedAt > MENU_TIMEOUT_TICKS) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"right-click did not open a container screen",
						evidence("no menu opened")
					);
				}
				return;
			}
			Vec3 center = Vec3.atCenterOf(current);
			MineTask.aimAt(client.player, center);
			BlockHitResult hit = MineTask.clip(client, client.player, center);
			if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(current)) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"container is outside reach or not visible",
					evidence("could not aim at the container")
				);
				return;
			}
			releaseWalkInput(client);
			menuSubmittedAt = age;
			client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, hit);
		}

		private void transfer(Minecraft client) {
			if (!openedByTask) {
				finish(id, "failed", "E_PRECONDITION", "container menu was not opened by this task", evidence("unowned menu"));
				return;
			}
			if (client.screen == null || !(client.screen instanceof AbstractContainerScreen<?> screen)) {
				closeOwnMenu(client);
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					moved > 0
						? "only " + moved + " items were deposited before the menu closed"
						: "container screen closed before any transfer was confirmed",
					evidence("the container screen closed")
				);
				return;
			}
			AbstractContainerMenu currentMenu = screen.getMenu();
			if (currentMenu != menu) {
				finish(id, "failed", "E_WORLD_CHANGED", "a different container menu replaced the deposit menu", evidence("menu identity changed"));
				closeOwnMenu(client);
				return;
			}
			if (!currentMenu.stillValid(client.player)) {
				closeOwnMenu(client);
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"container is no longer reachable",
					evidence("menu became invalid")
				);
				return;
			}
			Map<String, Integer> inventory = inventoryCounts(client.player);
			Map<String, Integer> stored = containerCounts(currentMenu, containerSlotCount(currentMenu));
			if (
				age - transferStartedAt > CONTAINER_TOTAL_TIMEOUT
					|| age - lastConfirmedAt > CONTAINER_TRANSFER_TIMEOUT
			) {
				complete(client, "container transfer timed out before all matching items were stored");
				return;
			}
			if (transferSubmitted) {
				if (!inventory.equals(lastInventory) || !stored.equals(lastContainer)) {
					stableTicks = 0;
					lastInventory = inventory;
					lastContainer = stored;
					return;
				}
				stableTicks++;
				if (stableTicks < CONTAINER_STABLE_TICKS) return;
				Map<String, Integer> confirmed = ContainerEvidence.moves(
					settledInventory,
					inventory,
					settledContainer,
					stored
				);
				if (!confirmed.isEmpty()) {
					for (var entry : confirmed.entrySet()) {
						deposited.merge(entry.getKey(), entry.getValue(), Integer::sum);
					}
					moved += confirmed.values().stream().mapToInt(Integer::intValue).sum();
					settledInventory = inventory;
					settledContainer = stored;
					lastConfirmedAt = age;
					send.accept(progress(id, "transferring", moved, 0));
				}
				transferSubmitted = false;
				lastInventory = inventory;
				lastContainer = stored;
				stableTicks = 0;
				if (!hasEligibleItems(client)) {
					complete(client, null);
					return;
				}
				return;
			}
			if (!inventory.equals(lastInventory) || !stored.equals(lastContainer) || stableTicks < CONTAINER_STABLE_TICKS) {
				if (!inventory.equals(lastInventory) || !stored.equals(lastContainer)) stableTicks = 0;
				else stableTicks++;
				lastInventory = inventory;
				lastContainer = stored;
				if (stableTicks < CONTAINER_STABLE_TICKS) return;
			}
			int slot = findDepositSlot(client.player, currentMenu);
			if (slot < 0) {
				String reason = hasEligibleItems(client)
					? ContainerEvidence.incompleteReason(true, true, false)
					: ContainerEvidence.incompleteReason(true, false, false);
				complete(client, reason);
				return;
			}
			Slot menuSlot = currentMenu.getSlot(slot);
			if (menuSlot.getItem().isEmpty()) return;
			client.gameMode.handleInventoryMouseClick(
				currentMenu.containerId,
				slot,
				0,
				ClickType.QUICK_MOVE,
				client.player
			);
			transferSubmitted = true;
			lastInventory = inventory;
			lastContainer = stored;
			stableTicks = 0;
		}

		private boolean hasEligibleItems(Minecraft client) {
			Inventory inventory = client.player.getInventory();
			for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
				if (eligible(inventory.getItem(slot))) return true;
			}
			return false;
		}

		private boolean eligible(ItemStack stack) {
			if (stack.isEmpty()) return false;
			if (itemId != null) {
				return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(itemId);
			}
			return !stack.isDamageableItem();
		}

		private BlockPos nearestContainer(Minecraft client) {
			BlockPos origin = client.player.blockPosition();
			BlockPos best = null;
			double bestDistance = Double.POSITIVE_INFINITY;
			for (BlockPos pos : BlockPos.betweenClosed(
				origin.offset(-CONTAINER_SEARCH_RADIUS, -8, -CONTAINER_SEARCH_RADIUS),
				origin.offset(CONTAINER_SEARCH_RADIUS, 8, CONTAINER_SEARCH_RADIUS)
			)) {
				BlockPos candidate = pos.immutable();
				if (candidate.distSqr(origin) > (double) CONTAINER_SEARCH_RADIUS * CONTAINER_SEARCH_RADIUS) continue;
				if (containerAt(client, candidate) == null) continue;
				double distance = client.player.distanceToSqr(
					candidate.getX() + 0.5,
					candidate.getY() + 0.5,
					candidate.getZ() + 0.5
				);
				if (distance < bestDistance) {
					bestDistance = distance;
					best = candidate;
				}
			}
			return best;
		}

		private BaseContainerBlockEntity containerAt(Minecraft client, BlockPos pos) {
			return client.level.getBlockEntity(pos) instanceof BaseContainerBlockEntity entity
				? entity
				: null;
		}

		private int findDepositSlot(LocalPlayer player, AbstractContainerMenu current) {
			int containerSlots = containerSlotCount(current);
			for (int index = containerSlots; index < current.slots.size(); index++) {
				Slot slot = current.getSlot(index);
				if (!(slot.container instanceof Inventory)) continue;
				// Armour and off-hand slots also use Inventory, while the
				// evidence maps cover the main inventory only. Transferring
				// from those slots could never be confirmed.
				if (slot.getContainerSlot() >= Inventory.INVENTORY_SIZE) continue;
				ItemStack stack = slot.getItem();
				if (!eligible(stack)) continue;
				if (slot.isFake() || !slot.mayPickup(player)) continue;
				if (!hasRoom(current, slot.getItem())) continue;
				return index;
			}
			return -1;
		}

		private boolean hasRoom(AbstractContainerMenu current, ItemStack stack) {
			int containerSlots = containerSlotCount(current);
			for (int index = 0; index < containerSlots; index++) {
				Slot slot = current.getSlot(index);
				if (!slot.mayPlace(stack)) continue;
				ItemStack existing = slot.getItem();
				if (existing.isEmpty()) return true;
				if (
					ItemStack.isSameItemSameComponents(existing, stack)
						&& existing.getCount() < Math.min(existing.getMaxStackSize(), slot.getMaxStackSize(stack))
				) {
					return true;
				}
			}
			return false;
		}

		private Map<String, Integer> inventoryCounts(LocalPlayer player) {
			Map<String, Integer> counts = new java.util.TreeMap<>();
			Inventory inventory = player.getInventory();
			for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = inventory.getItem(slot);
				if (stack.isEmpty()) continue;
				String item = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				counts.merge(item, stack.getCount(), Integer::sum);
			}
			return counts;
		}

		private int containerSlotCount(AbstractContainerMenu current) {
			for (int index = 0; index < current.slots.size(); index++) {
				if (current.getSlot(index).container instanceof Inventory) return index;
			}
			return 0;
		}

		private Map<String, Integer> containerCounts(AbstractContainerMenu current, int containerSlots) {
			Map<String, Integer> counts = new java.util.TreeMap<>();
			for (int index = 0; index < Math.min(containerSlots, current.slots.size()); index++) {
				Slot slot = current.getSlot(index);
				if (slot.container instanceof Inventory) continue;
				ItemStack stack = slot.getItem();
				if (stack.isEmpty()) continue;
				String item = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				counts.merge(item, stack.getCount(), Integer::sum);
			}
			return counts;
		}

		private void complete(Minecraft client, String problem) {
			closeOwnMenu(client);
			JsonObject data = evidence(problem);
			if (problem == null && moved > 0) {
				finish(id, "completed", null, null, data);
			} else {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					moved > 0
						? "only " + moved + " items were confirmed in the container"
						: problem == null ? "no transfer was confirmed" : problem,
					data
				);
			}
		}

		private JsonObject evidence(String problem) {
			JsonObject outcome = new JsonObject();
			outcome.addProperty(
				"summary",
				moved > 0
					? "deposited " + moved + " items into the container"
					: "no deposit was confirmed"
			);
			JsonArray changes = new JsonArray();
			for (var entry : deposited.entrySet()) {
				JsonObject change = new JsonObject();
				change.addProperty("kind", "item_deposited");
				change.addProperty("detail", entry.getValue() + " x " + entry.getKey());
				if (containerPos != null) change.add("position", position(containerPos));
				changes.add(change);
			}
			outcome.add("changes", changes);
			if (problem != null) {
				outcome.addProperty("problem", problem);
				JsonArray unconfirmed = new JsonArray();
				unconfirmed.add("container transfer was not confirmed by matching inventory and container counts");
				outcome.add("unconfirmed", unconfirmed);
			}
			return outcome;
		}

		private void closeOwnMenu(Minecraft client) {
			if (!openedByTask && menuSubmittedAt < 0) return;
			openedByTask = false;
			menuSubmittedAt = -1;
			menu = null;
			if (client.player != null && client.screen instanceof AbstractContainerScreen<?>) {
				client.player.closeContainer();
			} else if (client.screen instanceof AbstractContainerScreen<?>) {
				client.setScreen(null);
			}
		}

		private boolean reachesContainer(LocalPlayer player, BlockPos target) {
			return player.isWithinBlockInteractionRange(target, 0.0);
		}

		private boolean canInteract(Minecraft client, LocalPlayer player, BlockPos target) {
			return reachesContainer(player, target)
				&& MineTask.clip(client, player, Vec3.atCenterOf(target)).getBlockPos().equals(target);
		}

		@Override
		void stop(Minecraft client) {
			releaseWalkInput(client);
			closeOwnMenu(client);
		}
	}

	private static final class AttackTask extends Task {
		private static final int MAX_HITS = 16;
		private static final Pattern HUNT_DROP = Pattern.compile("(^|:)(beef|chicken|mutton|porkchop|rabbit|wool)$");
		private static final int WALK_BUDGET_TICKS = 20 * 15;
		private static final int STALL_TICKS = 20 * 3;
		private static final int MAX_REPLANS = 2;
		/** Only a target this close may use the no-route fallback. */
		private static final double DIRECT_APPROACH_LIMIT = 6.0;
		private static final int DROP_SETTLE_TICKS = 20 * 4;
		private static final int DROP_COLLECT_TIMEOUT = 20 * 10;
		private final String targetName;
		private final List<String> targetNames;
		private final double radius;
		private final boolean lethal;
		private final boolean collect;
		private final int requested;
		private Entity target;
		private InteractionEvidence.TargetSnapshot before;
		private boolean submitted;
		private int submittedAt = -1;
		private int hits;
		private int misses;
		private int walkingAge;
		private int lastProgressAge;
		private int replans;
		private double lastDistance = Double.POSITIVE_INFINITY;
		private List<Vec3> waypoints = List.of();
		private int waypointIndex;
		private Entity waypointTarget;
		private int nextRouteAt;
		private int killedAt = -1;
		private ItemEntity drop;
		private int dropSearchAt;
		private boolean collectedAny;
		private final Map<String, Integer> inventoryBefore = new java.util.TreeMap<>();

		AttackTask(String id, String targetName, int requested) {
			this(id, targetName, List.of(), requested, ATTACK_SEARCH_RADIUS, false, false);
		}

		AttackTask(
			String id,
			String targetName,
			List<String> targetNames,
			int requested,
			double radius,
			boolean lethal,
			boolean collect
		) {
			super(id);
			this.targetName = targetName;
			this.targetNames = List.copyOf(targetNames);
			this.radius = Math.max(4.0, Math.min(48.0, radius));
			this.lethal = lethal;
			this.collect = collect;
			this.requested = Math.max(1, Math.min(MAX_HITS, requested));
		}

		@Override
		void start(Minecraft client) {
			inventoryBefore.putAll(inventoryCounts(client.player));
			target = nearestTarget(client);
			if (target == null) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"no " + targetName + " within " + (int) radius + " blocks",
					attackEvidence("no matching entity was visible within the bounded search radius", 0)
				);
				return;
			}
			before = snapshot(client, target);
			send.accept(progress(id, "chasing", 0, requested));
		}

		@Override
		void tick(Minecraft client) {
			if (collect && killedAt >= 0) {
				collectDrop(client);
				return;
			}
			if (!submitted) {
				if (target == null || !target.isAlive() || target.isRemoved()) {
					target = nearestTarget(client);
					if (target != null) {
						before = snapshot(client, target);
						lastDistance = Double.POSITIVE_INFINITY;
						lastProgressAge = age;
					}
				}
				if (target != null && distanceToTarget(client) > 3.0) {
					approach(client);
					return;
				}
				if (target == null) {
					if (collect && killedAt < 0 && hits > 0) {
						killedAt = age;
						return;
					}
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"target disappeared before the hit could be confirmed",
						attackEvidence("hit was submitted but the target could not be verified", hits)
					);
					return;
				}
				releaseWalkInput(client);
				if (target != null && target.isAlive() && !target.isRemoved()) {
					before = snapshot(client, target);
				} else if (hits < requested) {
					Entity next = nearestTarget(client);
					if (next != null) {
						target = next;
						before = snapshot(client, target);
					}
				}
				String blocked = InteractionEvidence.attackBlocked(before);
				if (blocked != null) {
					if ("target is no longer visible".equals(blocked)) {
						// Losing sight at close range still requires movement.
						// Returning without approaching left the task spinning
						// forever because `walkingAge` never advanced.
						approach(client);
						return;
					}
					if (hits > 0) {
						finish(
							id,
							"failed",
							"E_PRECONDITION",
							"only landed " + hits + " of " + requested + " hits: " + blocked,
							attackEvidence(blocked, hits)
						);
					} else {
						finish(id, "failed", "E_PRECONDITION", blocked, attackEvidence(blocked, 0));
					}
					return;
				}
				if (!InteractionEvidence.attackReady(client.player.getAttackStrengthScale(0.5f))) {
					send.accept(progress(id, "charging", hits, requested));
					return;
				}
				Vec3 center = target.getBoundingBox().getCenter();
				Vec3 direction = center.subtract(client.player.getEyePosition()).normalize();
				client.player.setYRot((float) Math.toDegrees(Math.atan2(-direction.x, direction.z)));
				client.player.setXRot((float) Math.toDegrees(-Math.asin(direction.y)));
				before = snapshot(client, target);
				submittedAt = age;
				submitted = true;
				client.gameMode.attack(client.player, target);
				client.player.swing(InteractionHand.MAIN_HAND);
				return;
			}
			if (target == null || target.isRemoved()) {
				if (lethal && hits > 0) {
					killedAt = age;
					if (collect) {
						releaseWalkInput(client);
						send.accept(progress(id, "collecting", 0, 1));
						return;
					}
					finish(id, "completed", null, null, attackEvidence(null, hits));
				} else if (!lethal && hits >= requested) {
					finish(id, "completed", null, null, attackEvidence(null, hits));
				} else {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"target disappeared before the hit could be confirmed",
						attackEvidence("hit was submitted but the target could not be verified", hits)
					);
				}
				return;
			}
			InteractionEvidence.TargetSnapshot now = snapshot(client, target);
			if (InteractionEvidence.attackConfirmed(before, now)) {
				hits++;
				submitted = false;
				misses = 0;
				send.accept(progress(id, "attacking", hits, requested));
				if (lethal && !now.alive()) {
					killedAt = age;
					if (collect) {
						releaseWalkInput(client);
						send.accept(progress(id, "collecting", 0, 1));
						return;
					}
					finish(id, "completed", null, null, attackEvidence(null, hits));
					return;
				}
				if (!lethal && hits >= requested) {
					finish(id, "completed", null, null, attackEvidence(null, hits));
				}
				return;
			}
			if (age - submittedAt <= InteractionEvidence.CONFIRM_TICKS) return;
			String blocked = InteractionEvidence.attackBlocked(now);
			if (blocked == null && ++misses < 2) {
				submitted = false;
				return;
			}
			finish(
				id,
				"failed",
				"E_PRECONDITION",
				blocked == null ? "attack did not change the target's health" : blocked,
				attackEvidence("the swing produced no confirmed health change", hits)
			);
		}

		private void approach(Minecraft client) {
			walkingAge++;
			if (walkingAge > WALK_BUDGET_TICKS) {
				stop(client);
				finish(
					id,
					"timeout",
					"E_TIMEOUT",
					"could not reach " + targetName + " in time",
					attackEvidence("target stayed out of attack reach", hits)
				);
				return;
			}
			double distance = distanceToTarget(client);
			if (distance + 0.15 < lastDistance) {
				lastDistance = distance;
				lastProgressAge = walkingAge;
			}
			Vec3 targetPosition = target.position();
			if (
				waypointTarget != target
					|| waypoints.isEmpty()
					|| walkingAge >= nextRouteAt
			) {
				// Attack range is a radius, not a block-adjacency rule. Aiming
				// A* at the animal's own cell made a distant target exhaust
				// the node budget, and the old fallback then walked straight
				// toward it through terrain.
				ApproachRoute.Route route = ApproachRoute.toEntity(
					client,
					target.position(),
					4_000,
					48.0
				);
				if (ApproachRoute.usableForApproach(route)) {
					waypoints = route.waypoints();
					waypointIndex = waypoints.size() > 1 ? 1 : 0;
				} else {
					if (distance > DIRECT_APPROACH_LIMIT) {
						stop(client);
						finish(
							id,
							"failed",
							"E_PRECONDITION",
							"no reachable route to " + targetName,
							attackEvidence("no safe standing route reached the target", hits)
						);
						return;
					}
					waypoints = List.of();
					waypointIndex = 0;
				}
				waypointTarget = target;
				nextRouteAt = walkingAge + 20;
			}
			Vec3 step = waypoints.size() > waypointIndex
				? waypoints.get(waypointIndex)
				: targetPosition;
			while (
				waypointIndex < waypoints.size() - 1
					&& Math.hypot(step.x - client.player.getX(), step.z - client.player.getZ()) < 0.75
			) {
				waypointIndex++;
				step = waypoints.get(waypointIndex);
			}
			double heading = Math.atan2(-(step.x - client.player.getX()), step.z - client.player.getZ());
			client.player.setYRot((float) Math.toDegrees(heading));
			// Walk along the route; only aim at the animal once it is inside
			// reach. Aiming at the target here overwrote the route heading,
			// and vanilla movement derives its forward vector from yaw. The
			// body therefore circled or walked away and never shortened the
			// distance, despite a valid route.
			if (distance <= 3.0) {
				MineTask.aimAt(client.player, target.getBoundingBox().getCenter());
			}
			// The route already proved this waypoint is standable. Checking
			// only the half-block directly ahead made a normal one-block rise
			// look like a cliff and aborted every hunt in hilly terrain.
			BlockPos foot = BlockPos.containing(
				step.x,
				step.y,
				step.z
			);
			if (standingY(client, foot) == Integer.MIN_VALUE) {
				stop(client);
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"no safe standing approach to " + targetName,
					attackEvidence("dangerous step on the route to the target", hits)
				);
				return;
			}
			if (client.player.horizontalCollision && client.player.onGround()) {
				client.player.jumpFromGround();
			}
			if (client.player.input != null) setWalkInput(client, true);
			if (walkingAge - lastProgressAge > STALL_TICKS) {
				if (replans >= MAX_REPLANS) {
					stop(client);
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"could not close the distance to " + targetName,
						attackEvidence("approach made no progress after bounded replanning", hits)
					);
					return;
				}
				replans++;
				lastProgressAge = walkingAge;
				nextRouteAt = walkingAge;
			}
			if (walkingAge % 20 == 0) {
				send.accept(progress(id, "chasing", (int) Math.round(distance), (int) Math.round(radius)));
			}
		}

		/**
		 * Kill drops are a separate observable event. Requiring a collected
		 * food/wool item prevents a kill from being confused with food in the
		 * backpack or with a drop that fell into a ravine.
		 */
		private void collectDrop(Minecraft client) {
			if (age - killedAt > DROP_COLLECT_TIMEOUT) {
				stop(client);
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"killed " + targetName + " but the drop was not collected",
					attackEvidence("no dropped item entered the inventory", hits)
				);
				return;
			}
			if (age - killedAt < DROP_SETTLE_TICKS) {
				releaseWalkInput(client);
				return;
			}
			Map<String, Integer> current = inventoryCounts(client.player);
			if (!current.equals(inventoryBefore) && gainedFoodOrWool(current)) {
				collectedAny = true;
				finish(id, "completed", null, null, attackEvidence(null, hits, current));
				return;
			}
			if (drop == null || drop.isRemoved()) {
				if (age >= dropSearchAt) {
					drop = nearestDropNear(client, target == null ? null : target.blockPosition());
					dropSearchAt = age + 10;
				}
				if (drop == null) {
					releaseWalkInput(client);
					return;
				}
			}
			Vec3 position = drop.position();
			if (client.player.position().distanceTo(position) < 1.3) {
				releaseWalkInput(client);
				return;
			}
			Vec3 direction = position.subtract(client.player.position());
			double horizontal = Math.hypot(direction.x, direction.z);
			if (horizontal > 0.01) {
				client.player.setYRot((float) Math.toDegrees(Math.atan2(-direction.x, direction.z)));
			}
			if (client.player.horizontalCollision && client.player.onGround()) {
				client.player.jumpFromGround();
			}
			if (client.player.input != null) setWalkInput(client, true);
			if (age % 20 == 0) send.accept(progress(id, "collecting", 0, 1));
		}

		private boolean gainedFoodOrWool(Map<String, Integer> current) {
			for (var entry : current.entrySet()) {
				int before = inventoryBefore.getOrDefault(entry.getKey(), 0);
				if (entry.getValue() <= before) continue;
				if (HUNT_DROP.matcher(entry.getKey()).find()) return true;
			}
			return false;
		}

		private ItemEntity nearestDropNear(Minecraft client, BlockPos around) {
			BlockPos origin = around == null ? client.player.blockPosition() : around;
			return client.level
				.getEntitiesOfClass(ItemEntity.class, client.player.getBoundingBox().inflate(16.0))
				.stream()
				.filter(ItemEntity::isAlive)
				.filter(entity -> entity.blockPosition().distSqr(origin) <= 16.0 * 16.0)
				.min((left, right) -> Double.compare(left.distanceToSqr(client.player), right.distanceToSqr(client.player)))
				.orElse(null);
		}

		private double distanceToTarget(Minecraft client) {
			return target == null ? Double.POSITIVE_INFINITY : Math.sqrt(target.distanceToSqr(client.player));
		}

		private Map<String, Integer> inventoryCounts(LocalPlayer player) {
			Map<String, Integer> counts = new java.util.TreeMap<>();
			for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (stack.isEmpty()) continue;
				String item = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				counts.merge(item, stack.getCount(), Integer::sum);
			}
			return counts;
		}

		private boolean matchesTarget(Entity entity, LocalPlayer player) {
			if (entity == player || !entity.isAlive()) return false;
			String name = entity.getName().getString();
			String key = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
			if (
				name.equalsIgnoreCase(targetName)
					|| key.equalsIgnoreCase(targetName)
					|| key.equalsIgnoreCase("minecraft:" + targetName)
			) return true;
			for (String alternative : targetNames) {
				if (
					name.equalsIgnoreCase(alternative)
						|| key.equalsIgnoreCase(alternative)
						|| key.equalsIgnoreCase("minecraft:" + alternative)
				) return true;
			}
			return false;
		}

		/**
		 * Search and approach are one bounded operation. Line of sight is not a
		 * selection filter: at 30+ blocks a tree or a hill routinely hides an
		 * animal the body can still walk to. A full route search for every
		 * candidate is also too strict: it rejects a valid distant target when
		 * the A* budget is exhausted, even though the approach loop can replan
		 * from closer. The distance bound and the approach's own safety/route
		 * checks decide whether a target is actually reachable.
		 */
		private Entity nearestTarget(Minecraft client) {
			return client.level
				.getEntitiesOfClass(Entity.class, client.player.getBoundingBox().inflate(radius))
				.stream()
				.filter(entity -> matchesTarget(entity, client.player))
				.filter(entity -> entity.distanceToSqr(client.player) <= radius * radius)
				.min((left, right) -> Double.compare(left.distanceToSqr(client.player), right.distanceToSqr(client.player)))
				.orElse(null);
		}

		private static InteractionEvidence.TargetSnapshot snapshot(Minecraft client, Entity entity) {
			if (entity == null) return null;
			float health = entity instanceof LivingEntity living ? living.getHealth() : 0.0f;
			return new InteractionEvidence.TargetSnapshot(
				entity.getId(),
				health,
				entity.isAlive(),
				client.player.hasLineOfSight(entity),
				Math.sqrt(entity.distanceToSqr(client.player))
			);
		}

		private JsonObject attackEvidence(String problem, int confirmedHits) {
			return attackEvidence(problem, confirmedHits, null);
		}

		private JsonObject attackEvidence(
			String problem,
			int confirmedHits,
			Map<String, Integer> collected
		) {
			JsonObject outcome = new JsonObject();
			JsonObject change = new JsonObject();
			change.addProperty("kind", "entity_damaged");
			change.addProperty("detail", targetName + " ×" + confirmedHits);
			// `target` is null exactly when the entity could not be found, which is
			// a reportable outcome. Dereferencing it here turned that into an
			// E_INTERNAL that hid the real reason.
			if (target != null) {
				JsonObject position = new JsonObject();
				position.addProperty("x", round(target.getX()));
				position.addProperty("y", round(target.getY()));
				position.addProperty("z", round(target.getZ()));
				change.add("position", position);
			}
			JsonArray changes = new JsonArray();
			if (confirmedHits > 0) changes.add(change);
			if (collected != null) {
				for (var entry : collected.entrySet()) {
					int before = inventoryBefore.getOrDefault(entry.getKey(), 0);
					if (entry.getValue() <= before) continue;
					JsonObject picked = new JsonObject();
					picked.addProperty("kind", "item_collected");
					picked.addProperty(
						"detail",
						(entry.getValue() - before) + " x " + entry.getKey()
					);
					changes.add(picked);
				}
			}
			outcome.add("changes", changes);
			outcome.addProperty(
				"summary",
				problem == null
					? "confirmed " + confirmedHits + " hit(s) on " + targetName
					: "confirmed " + confirmedHits + " hit(s) before the attack stopped"
			);
			if (problem != null) {
				outcome.addProperty("problem", problem);
				JsonArray unconfirmed = new JsonArray();
				unconfirmed.add("attack submission had no observable health change");
				outcome.add("unconfirmed", unconfirmed);
			}
			return outcome;
		}
	}

	private static final class EquipTask extends Task {
		private final String itemId;

		EquipTask(String id, String itemId) {
			super(id);
			this.itemId = itemId;
		}

		@Override
		void start(Minecraft client) {
			int slot = findHotbar(client.player, itemId);
			if (slot < 0) {
				finish(id, "failed", "E_PRECONDITION", "item is not in hotbar");
				return;
			}
			client.player.getInventory().setSelectedSlot(slot);
			ItemStack selected = client.player.getInventory().getSelectedItem();
			if (!matches(selected, itemId)) {
				finish(id, "failed", "E_PRECONDITION", "selected slot does not hold " + itemId);
				return;
			}
			JsonObject outcome = new JsonObject();
			outcome.addProperty("summary", "equipped " + itemId);
			JsonObject change = new JsonObject();
			change.addProperty("kind", "item_selected");
			change.addProperty("detail", itemId);
			JsonArray changes = new JsonArray();
			changes.add(change);
			outcome.add("changes", changes);
			finish(id, "completed", null, null, outcome);
		}

		@Override
		void tick(Minecraft client) {
		}
	}

	/**
	 * Sleeping only exists if the player is actually in bed and the world
	 * moved to the next day. Right-clicking a bed is a submission; a server
	 * can reject it because it is daytime, the bed is occupied, a monster is
	 * nearby, or the bed is outside the player's respawn area.
	 */
	private static final class SleepTask extends Task {
		private static final int WALK_BUDGET_TICKS = 20 * 15;
		private static final int APPROACH_STALL_TICKS = 20 * 3;
		private BlockPos bedHead;
		private boolean walking;
		private int walkingAge;
		private int lastWalkProgressAge;
		private double lastApproachDistance = Double.POSITIVE_INFINITY;
		private List<Vec3> approachWaypoints = List.of();
		private int approachWaypoint;
		private BlockPos approachTarget;
		private int nextApproachPlanAt;
		private int submittedAt = -1;
		private int dayBefore;
		private int timeBefore;
		private int sleepingSince = -1;
		private int wokeAt = -1;
		private boolean wasSleeping;
		/** A successful finish must not wake the body it just put to bed. */
		private boolean finishedNormally;

		SleepTask(String id) {
			super(id);
		}

		@Override
		void start(Minecraft client) {
			LocalPlayer player = client.player;
			if (player.isSleeping()) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"player is already sleeping",
					evidence(client, "already in bed")
				);
				return;
			}
			bedHead = nearestBed(client);
			if (bedHead == null) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"no bed within " + SLEEP_SEARCH_RADIUS + " blocks",
					evidence(client, "no bed to sleep in")
				);
				return;
			}
			BedRule rule = client.level.environmentAttributes()
				.getValue(EnvironmentAttributes.BED_RULE, bedHead);
			String blocked = SleepEvidence.blockedReason(
				false,
				true,
				occupied(client, bedHead),
				rule.explodes(),
				rule.canSleep(client.level)
			);
			if (blocked != null) {
				finish(id, "failed", "E_PRECONDITION", blocked, evidence(client, blocked));
				return;
			}
			dayBefore = day(client);
			timeBefore = timeOfDay(client);
			walking = interactionPart(client) == null;
			send.accept(progress(id, walking ? "walking" : "opening", 0, 1));
		}

		@Override
		void tick(Minecraft client) {
			LocalPlayer player = client.player;
			if (player.isSleeping()) {
				if (sleepingSince < 0) {
					sleepingSince = age;
					wasSleeping = true;
					send.accept(progress(id, "sleeping", 0, 1));
				}
				int today = day(client);
				if (SleepEvidence.nextDayReached(dayBefore, today)) {
					finishedNormally = true;
					sleptThroughNight = true;
					finish(id, "completed", null, null, evidence(client, null));
				} else if (age - sleepingSince > SLEEP_OBSERVE_TICKS) {
					finish(
						id,
						"timeout",
						"E_TIMEOUT",
						"player stayed in bed but the day did not advance",
						evidence(client, "the night was not skipped (another player may still be awake)")
					);
				}
				return;
			}
			if (
				submittedAt >= 0
					&& client.screen != null
					&& !(client.screen instanceof InBedChatScreen)
			) {
				// An inventory, pause menu or chat screen opened between the
				// click and the server's answer is a conflict, not something
				// the agent may dismiss for the player.
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"a player screen interrupted the bed interaction",
					evidence(client, "the player opened another screen")
				);
				return;
			}
			if (wasSleeping) {
				if (wokeAt < 0) wokeAt = age;
				if (SleepEvidence.nextDayReached(dayBefore, day(client))) {
					finishedNormally = true;
					sleptThroughNight = true;
					finish(id, "completed", null, null, evidence(client, null));
				} else if (age - wokeAt > SLEEP_WAKE_GRACE_TICKS) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"player woke up before the next day",
						evidence(client, "woke up without the night being skipped")
					);
				}
				return;
			}
			if (submittedAt >= 0) {
				if (age - submittedAt > SLEEP_CONFIRM_TICKS) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"bed interaction did not put the player to sleep",
						evidence(client, "the server did not confirm sleeping")
					);
				}
				return;
			}
			BlockPos part = interactionPart(client);
			if (part == null) {
				if (!(client.level.getBlockState(bedHead).getBlock() instanceof BedBlock)) {
					finish(
						id,
						"failed",
						"E_WORLD_CHANGED",
						"the bed disappeared before it could be used",
						evidence(client, "the bed was removed")
					);
					return;
				}
				walking = true;
				approach(client);
				return;
			}
			walking = false;
			releaseWalkInput(client);
			MineTask.aimAt(player, Vec3.atCenterOf(part));
			BlockHitResult hit = MineTask.clip(client, player, Vec3.atCenterOf(part));
			if (hit.getType() != HitResult.Type.BLOCK || !isThisBed(client, hit.getBlockPos())) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"the bed is outside reach or view",
					evidence(client, "could not aim at the bed")
				);
				return;
			}
			submittedAt = age;
			client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, hit);
			send.accept(progress(id, "confirming", 0, 1));
		}

		@Override
		boolean keepScreen(Minecraft client) {
			// Vanilla opens the in-bed chat screen as part of sleeping.
			return sleepingSince >= 0 || client.screen instanceof InBedChatScreen;
		}

		private void approach(Minecraft client) {
			LocalPlayer player = client.player;
			MineTask.aimAt(player, Vec3.atCenterOf(bedHead));
			walkingAge++;
			if (walkingAge > WALK_BUDGET_TICKS) {
				finish(
					id,
					"timeout",
					"E_TIMEOUT",
					"could not reach the bed in time",
					evidence(client, "bed approach timed out")
				);
				return;
			}
			Vec3 center = Vec3.atCenterOf(bedHead);
			if (!bedHead.equals(approachTarget) || walkingAge >= nextApproachPlanAt) {
				ApproachRoute.Route route = ApproachRoute.to(client, bedHead);
				if (route != null && route.waypoints().size() > 1) {
					approachWaypoints = route.waypoints();
					approachWaypoint = 1;
				} else {
					approachWaypoints = List.of();
					approachWaypoint = 0;
				}
				approachTarget = bedHead;
				nextApproachPlanAt = walkingAge + 20;
			}
			Vec3 step = approachWaypoints.size() > approachWaypoint
				? approachWaypoints.get(approachWaypoint)
				: center;
			while (
				approachWaypoint < approachWaypoints.size() - 1
					&& Math.hypot(step.x - player.getX(), step.z - player.getZ()) < 0.75
					&& Math.abs(step.y - player.getY()) < 1.25
			) {
				approachWaypoint++;
				step = approachWaypoints.get(approachWaypoint);
			}
			double progressDistance = player.position().distanceTo(step);
			if (progressDistance + 0.1 < lastApproachDistance) {
				lastApproachDistance = progressDistance;
				lastWalkProgressAge = walkingAge;
			} else if (walkingAge - lastWalkProgressAge > APPROACH_STALL_TICKS) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"bed approach made no progress for 3 seconds",
					evidence(client, "could not reach a safe interaction spot beside the bed")
				);
				return;
			}
			double heading = Math.atan2(-(step.x - player.getX()), step.z - player.getZ());
			player.setYRot((float) Math.toDegrees(heading));
			Vec3 ahead = player.position().add(-Math.sin(heading) * 0.6, 0, Math.cos(heading) * 0.6);
			BlockPos foot = BlockPos.containing(ahead.x, player.getY() - 0.5, ahead.z);
			boolean ledge = client.level.getBlockState(foot).isAir()
				&& client.level.getBlockState(foot.below()).isAir();
			if (ledge && player.onGround()) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"dangerous drop on the route to the bed",
					evidence(client, "refused an unsafe bed approach")
				);
				return;
			}
			if (player.horizontalCollision && player.onGround()) player.jumpFromGround();
			if (player.input != null) setWalkInput(client, true);
			if (walkingAge % 20 == 0) {
				send.accept(progress(id, "walking", (int) Math.round(player.position().distanceTo(center)), 0));
			}
		}

		private BlockPos interactionPart(Minecraft client) {
			LocalPlayer player = client.player;
			for (BlockPos candidate : bedParts(client, bedHead)) {
				if (
					player.isWithinBlockInteractionRange(candidate, 0.0)
						&& MineTask.clip(client, player, Vec3.atCenterOf(candidate)).getBlockPos().equals(candidate)
				) {
					return candidate;
				}
			}
			return null;
		}

		private boolean isThisBed(Minecraft client, BlockPos pos) {
			return bedParts(client, bedHead).contains(pos);
		}

		private static List<BlockPos> bedParts(Minecraft client, BlockPos head) {
			List<BlockPos> parts = new ArrayList<>(2);
			if (head == null) return parts;
			BlockState state = client.level.getBlockState(head);
			if (!(state.getBlock() instanceof BedBlock)) return parts;
			Direction facing = state.getValue(BedBlock.FACING);
			BlockPos other = state.getValue(BedBlock.PART) == BedPart.HEAD
				? head.relative(facing.getOpposite())
				: head.relative(facing);
			parts.add(head);
			if (client.level.getBlockState(other).getBlock() instanceof BedBlock) parts.add(other);
			return parts;
		}

		private static BlockPos nearestBed(Minecraft client) {
			BlockPos origin = client.player.blockPosition();
			List<BlockPos> found = new ArrayList<>();
			for (BlockPos pos : BlockPos.betweenClosed(
				origin.offset(-SLEEP_SEARCH_RADIUS, -8, -SLEEP_SEARCH_RADIUS),
				origin.offset(SLEEP_SEARCH_RADIUS, 8, SLEEP_SEARCH_RADIUS)
			)) {
				BlockState state = client.level.getBlockState(pos);
				if (!(state.getBlock() instanceof BedBlock)) continue;
				double distance = pos.distSqr(origin);
				if (distance > (double) SLEEP_SEARCH_RADIUS * SLEEP_SEARCH_RADIUS) continue;
				found.add(pos.immutable());
			}
			found.sort((left, right) -> Double.compare(left.distSqr(origin), right.distSqr(origin)));
			BlockPos nearestHead = null;
			for (BlockPos candidate : found) {
				BlockState state = client.level.getBlockState(candidate);
				BlockPos head = state.getValue(BedBlock.PART) == BedPart.FOOT
					? candidate.relative(state.getValue(BedBlock.FACING))
					: candidate;
				if (!(client.level.getBlockState(head).getBlock() instanceof BedBlock)) continue;
				if (nearestHead == null) nearestHead = head;
				// Prefer a usable bed, but keep the nearest head so a start
				// failure can name the real reason instead of claiming that
				// the player owns no bed at all.
				BedRule rule = client.level.environmentAttributes()
					.getValue(EnvironmentAttributes.BED_RULE, head);
				if (rule.explodes() || occupied(client, head)) continue;
				return head;
			}
			return nearestHead;
		}

		private static boolean occupied(Minecraft client, BlockPos head) {
			BlockState state = client.level.getBlockState(head);
			return state.getBlock() instanceof BedBlock && state.getValue(BedBlock.OCCUPIED);
		}

		private static int day(Minecraft client) {
			return (int) Math.floorDiv(client.level.getDayTime(), 24_000L);
		}

		private static int timeOfDay(Minecraft client) {
			return (int) Math.floorMod(client.level.getDayTime(), 24_000L);
		}

		private JsonObject evidence(Minecraft client, String problem) {
			int dayAfter = day(client);
			int timeAfter = timeOfDay(client);
			JsonObject outcome = new JsonObject();
			outcome.addProperty(
				"summary",
				problem == null
					? "slept through the night: day " + dayBefore + " -> " + dayAfter
					: "sleep was not confirmed"
			);
			JsonArray changes = new JsonArray();
			if (problem == null) {
				JsonObject change = new JsonObject();
				change.addProperty("kind", "slept");
				change.addProperty("detail", "day " + dayBefore + " -> " + dayAfter);
				if (bedHead != null) change.add("position", position(bedHead));
				changes.add(change);
			}
			outcome.add("changes", changes);
			if (bedHead != null) {
				JsonObject bed = position(bedHead);
				outcome.add("bed", bed);
			}
			outcome.addProperty("dayBefore", dayBefore);
			outcome.addProperty("dayAfter", dayAfter);
			outcome.addProperty("timeOfDayBefore", timeBefore);
			outcome.addProperty("timeOfDayAfter", timeAfter);
			if (problem != null) {
				outcome.addProperty("problem", problem);
				JsonArray unconfirmed = new JsonArray();
				unconfirmed.add("the bed interaction was not confirmed by a new day");
				outcome.add("unconfirmed", unconfirmed);
			}
			return outcome;
		}

		@Override
		void stop(Minecraft client) {
			releaseWalkInput(client);
			CameraController.release();
			LocalPlayer player = client.player;
			if (!finishedNormally && player != null && player.isSleeping()) {
				// Do not leave the body in bed after a cancel, takeover or
				// disconnect: the operator must get the controls back awake.
				player.connection.send(
					new ServerboundPlayerCommandPacket(
						player,
						ServerboundPlayerCommandPacket.Action.STOP_SLEEPING
					)
				);
			}
			if (client.screen instanceof InBedChatScreen && (player == null || !player.isSleeping())) {
				client.setScreen(null);
			}
		}
	}

	private static final class EatTask extends Task {
		private static final int MAX_USE_ATTEMPTS = 5;
		private static final int RETRY_INTERVAL_TICKS = 8;
		private static final int GIVE_UP_TICKS = 20 * 10;
		private final String itemId;
		private int ticks;
		private int foodBefore;
		private String itemBefore;
		private int countBefore;
		private int attempts;
		private int nextAttemptTick;

		EatTask(String id, String itemId) {
			super(id);
			this.itemId = itemId;
		}

		@Override
		void start(Minecraft client) {
			LocalPlayer player = client.player;
			ItemStack stack = player.getInventory().getSelectedItem();
			if (stack.isEmpty() || (itemId != null && !matches(stack, itemId))) {
				int slot = itemId == null ? -1 : findHotbar(player, itemId);
				if (slot < 0) {
					finish(id, "failed", "E_PRECONDITION", "food is not in hotbar");
					return;
				}
				player.getInventory().setSelectedSlot(slot);
			}
			ItemStack eating = player.getInventory().getSelectedItem();
			if (eating.isEmpty()) {
				finish(id, "failed", "E_PRECONDITION", "no food in the selected slot");
				return;
			}
			foodBefore = player.getFoodData().getFoodLevel();
			itemBefore = BuiltInRegistries.ITEM.getKey(eating.getItem()).toString();
			countBefore = eating.getCount();
			useOnce(client);
			send.accept(progress(id, "eating", 0, 1));
		}

		@Override
		void tick(Minecraft client) {
			ticks++;
			int foodAfter = client.player.getFoodData().getFoodLevel();
			ItemStack stack = client.player.getInventory().getSelectedItem();
			String itemAfter = stack.isEmpty()
				? null
				: BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
			boolean consumed =
				foodAfter > foodBefore
					|| InteractionEvidence.itemChanged(itemBefore, countBefore, itemAfter, stack.getCount());
			if (consumed) {
				foodAcquired = true;
				foodConsumed = true;
				finish(id, "completed", null, null, foodEvidence(true, foodAfter));
				return;
			}
			if (
				attempts < MAX_USE_ATTEMPTS
					&& !client.player.isUsingItem()
					&& ticks >= nextAttemptTick
			) {
				// The server may reject or cancel one use when the client did
				// not hold the use input for the whole duration. A human
				// player just tries again; do that with a bounded attempt
				// count instead of claiming success or looping forever.
				useOnce(client);
			}
			if (attempts >= MAX_USE_ATTEMPTS && !client.player.isUsingItem() && ticks >= nextAttemptTick) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"eating stopped without a food or item change",
					foodEvidence(false, foodAfter)
				);
			} else if (ticks > GIVE_UP_TICKS) {
				finish(id, "failed", "E_TIMEOUT", "eating did not finish");
			}
		}

		private void useOnce(Minecraft client) {
			attempts++;
			nextAttemptTick = ticks + RETRY_INTERVAL_TICKS;
			client.gameMode.useItem(client.player, InteractionHand.MAIN_HAND);
		}

		private JsonObject foodEvidence(boolean consumed, int foodAfter) {
			JsonObject outcome = new JsonObject();
			outcome.addProperty(
				"summary",
				consumed
					? "ate " + (itemBefore == null ? "food" : itemBefore)
					: "eating stopped without a confirmed effect"
			);
			JsonArray changes = new JsonArray();
			if (consumed) {
				JsonObject change = new JsonObject();
				change.addProperty("kind", "food_consumed");
				change.addProperty(
					"detail",
					(itemBefore == null ? "food" : itemBefore) + " food " + foodBefore + " -> " + foodAfter
				);
				changes.add(change);
			}
			outcome.add("changes", changes);
			if (!consumed) {
				outcome.addProperty("problem", "food level and held stack were unchanged");
				JsonArray unconfirmed = new JsonArray();
				unconfirmed.add("eating animation ended without a confirmed consumption");
				outcome.add("unconfirmed", unconfirmed);
			}
			return outcome;
		}

		@Override
		void stop(Minecraft client) {
			if (client.player != null && client.player.isUsingItem()) {
				client.gameMode.releaseUsingItem(client.player);
			}
		}
	}

	private static final class UseBlockTask extends Task {
		private final String blockId;
		private BlockPos targetPos;
		private InteractionEvidence.BlockSnapshot beforeBlock;
		private String beforeItem;
		private int beforeCount;
		private boolean screenBefore;
		private int submittedAt = -1;

		UseBlockTask(String id, String blockId) {
			super(id);
			this.blockId = blockId;
		}

		@Override
		void start(Minecraft client) {
			HitResult raw = client.player.raycastHitResult(1.0f, client.player);
			BlockHitResult hit = raw.getType() == HitResult.Type.BLOCK && raw instanceof BlockHitResult blockHit
				? blockHit
				: null;
			if (hit != null && (blockId == null || blockMatches(client.level, hit.getBlockPos(), blockId))) {
				targetPos = hit.getBlockPos().immutable();
				beforeBlock = blockSnapshot(client, targetPos);
				rememberHand(client);
				screenBefore = client.screen != null;
				submittedAt = age;
				client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, hit);
				send.accept(progress(id, "confirming", 0, 1));
			} else if (blockId == null) {
				rememberHand(client);
				submittedAt = age;
				client.gameMode.useItem(client.player, InteractionHand.MAIN_HAND);
				send.accept(progress(id, "confirming", 0, 1));
			} else {
				finish(id, "failed", "E_PRECONDITION", "target block is outside reach or view");
			}
		}

		@Override
		void tick(Minecraft client) {
			if (submittedAt < 0) return;
			if (targetPos == null && itemChanged(client)) {
				finish(id, "completed", null, null, useEvidence("item used", null));
				return;
			}
			boolean screenOpened = client.screen != null && !screenBefore;
			if (
				targetPos != null
					&& InteractionEvidence.useConfirmed(
						beforeBlock,
						blockSnapshot(client, targetPos),
						beforeCount,
						handCount(client)
					)
			) {
				finish(id, "completed", null, null, useEvidence("interaction observed", null));
				return;
			}
			if (screenOpened) {
				finish(
					id,
					"completed",
					null,
					null,
					useEvidence("screen opened; no world change was proven", null)
				);
				return;
			}
			if (age - submittedAt <= InteractionEvidence.CONFIRM_TICKS) return;
			finish(
				id,
				"failed",
				"E_PRECONDITION",
				"use was submitted but produced no confirmed effect",
				useEvidence(
					"use submitted",
					screenOpened
						? "a screen opened but no world or item change was confirmed"
						: "block, held item and screen were unchanged"
				)
			);
		}

		private void rememberHand(Minecraft client) {
			ItemStack stack = client.player.getInventory().getSelectedItem();
			beforeItem = stack.isEmpty() ? null : BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
			beforeCount = stack.getCount();
		}

		private boolean itemChanged(Minecraft client) {
			ItemStack stack = client.player.getInventory().getSelectedItem();
			String after = stack.isEmpty() ? null : BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
			return InteractionEvidence.itemChanged(beforeItem, beforeCount, after, stack.getCount());
		}

		private int handCount(Minecraft client) {
			return client.player.getInventory().getSelectedItem().getCount();
		}

		private JsonObject useEvidence(String summary, String problem) {
			JsonObject outcome = new JsonObject();
			outcome.addProperty("summary", summary);
			JsonArray changes = new JsonArray();
			if (problem == null && targetPos != null) {
				JsonObject change = new JsonObject();
				change.addProperty("kind", "block_used");
				change.addProperty("detail", blockId == null ? "interaction" : blockId);
				change.add("position", position(targetPos));
				changes.add(change);
			}
			if (problem == null && targetPos == null) {
				JsonObject change = new JsonObject();
				change.addProperty("kind", "item_used");
				change.addProperty("detail", beforeItem == null ? "selected item" : beforeItem);
				changes.add(change);
			}
			outcome.add("changes", changes);
			if (problem != null) {
				outcome.addProperty("problem", problem);
				JsonArray unconfirmed = new JsonArray();
				unconfirmed.add("use submission had no observable effect");
				outcome.add("unconfirmed", unconfirmed);
			}
			return outcome;
		}
	}

	private static final class PlaceTask extends Task {
		private static final int SURFACE_SEARCH_RADIUS = 4;
		private final String blockId;
		/**
		 * Namespaced form of {@link #blockId}. `findHotbar` accepts "stone" and
		 * resolves it to "minecraft:stone", so the confirmation has to compare
		 * against the same canonical id or a real placement reads as a failure.
		 */
		private final String expectedBlock;
		private final int count;
		private int placed;
		private BlockPos targetPos;
		private InteractionEvidence.BlockSnapshot beforeBlock;
		private int beforeCount;
		private int submittedAt = -1;
		/** Set when the body turned toward another bed heading this tick. */
		private boolean awaitingRotation;
		/** Set when the body turned toward a ground face this tick. */
		private boolean awaitingSurfaceAim;
		private BlockHitResult aimedSurface;

		PlaceTask(String id, String blockId, int count) {
			super(id);
			this.blockId = blockId;
			Identifier parsed = Identifier.tryParse(blockId);
			this.expectedBlock = parsed == null ? blockId : parsed.toString();
			this.count = count;
		}

		@Override
		boolean validate(Minecraft client) {
			if (!super.validate(client)) return false;
			if (Identifier.tryParse(blockId) == null) {
				validationError = "invalid block " + blockId;
				return false;
			}
			return true;
		}

		@Override
		void start(Minecraft client) {
			beginPlacement(client);
		}

		private void beginPlacement(Minecraft client) {
			int slot = findHotbar(client.player, blockId);
			if (slot < 0) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					placed > 0
						? "only " + placed + " of " + count + " blocks could be placed: item is not in hotbar"
						: "block item is not in hotbar",
					placeEvidence(placed > 0 ? "ran out of " + blockId : null)
				);
				return;
			}
			client.player.getInventory().setSelectedSlot(slot);
			HitResult raw = client.player.raycastHitResult(1.0f, client.player);
			BlockHitResult hit = raw.getType() == HitResult.Type.BLOCK && raw instanceof BlockHitResult blockHit
				? blockHit
				: null;
			if (hit == null || !surfaceAccepts(client, hit)) {
				BlockHitResult surface = findPlacementSurface(client);
				if (surface == null) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						placed > 0
							? "only " + placed + " of " + count + " blocks placed: no placement surface in view"
							: "no placement surface in view",
						placeEvidence(placed > 0 ? "no further placement surface" : null)
					);
					return;
				}
				aimedSurface = surface;
				MineTask.aimAt(client.player, Vec3.atCenterOf(surface.getBlockPos()));
				awaitingSurfaceAim = true;
				send.accept(progress(id, "turning", placed, count));
				return;
			}
			targetPos = hit.getBlockPos().relative(hit.getDirection());
			beforeBlock = blockSnapshot(client, targetPos);
			beforeCount = client.player.getInventory().getSelectedItem().getCount();
			if (beforeBlock != null && !beforeBlock.replaceable()) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					placed > 0
						? "only " + placed + " of " + count + " blocks placed: the next cell is already occupied"
						: "placement cell is already occupied",
					placeEvidence("the target cell was not replaceable")
				);
				return;
			}
			if (isBedItem(blockId)) {
				BedRoom room = bedRoom(client, targetPos);
				if (room == BedRoom.BLOCKED) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"no room to place the bed: both cells must be free",
						placeEvidence("the bed's second cell is not replaceable")
					);
					return;
				}
				if (room == BedRoom.TURNED) {
					send.accept(progress(id, "turning", placed, count));
					return;
				}
			}
			submittedAt = age;
			client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, hit);
			send.accept(progress(id, "confirming", placed, count));
		}

		/**
		 * The visible ray is a convenience, not the whole reachable world. When
		 * the player looks at their feet, a slightly lower face beside them is
		 * still a legal placement surface. Search nearby full block faces and
		 * turn toward the best one before submitting, rather than reporting a
		 * false "nothing to place on".
		 */
		private static BlockHitResult findPlacementSurface(Minecraft client) {
			LocalPlayer player = client.player;
			BlockPos origin = player.blockPosition();
			List<SurfaceCandidate> candidates = new ArrayList<>();
			for (BlockPos pos : BlockPos.betweenClosed(
				origin.offset(-SURFACE_SEARCH_RADIUS, -3, -SURFACE_SEARCH_RADIUS),
				origin.offset(SURFACE_SEARCH_RADIUS, 2, SURFACE_SEARCH_RADIUS)
			)) {
				BlockPos support = pos.immutable();
				BlockState state = client.level.getBlockState(support);
				if (state.isAir() || !state.isSolidRender()) continue;
				for (Direction face : Direction.values()) {
					BlockPos destination = support.relative(face);
					if (!client.level.getBlockState(destination).canBeReplaced()) continue;
					Vec3 aim = Vec3.atCenterOf(support);
					BlockHitResult hit = MineTask.clip(client, player, aim);
					if (!hit.getBlockPos().equals(support) || hit.getDirection() != face) continue;
					double distance = player.getEyePosition().distanceTo(aim);
					candidates.add(new SurfaceCandidate(hit, distance * distance, true));
				}
			}
			SurfaceCandidate best = PlacementTarget.choose(candidates);
			return best == null ? null : best.hit;
		}

		private static boolean surfaceAccepts(Minecraft client, BlockHitResult hit) {
			BlockState state = client.level.getBlockState(hit.getBlockPos());
			if (state.isAir() || !state.isSolidRender()) return false;
			return client.level.getBlockState(hit.getBlockPos().relative(hit.getDirection())).canBeReplaced();
		}

		private record SurfaceCandidate(BlockHitResult hit, double distanceSqr, boolean destinationFree)
			implements PlacementTarget.Surface {}

		private static boolean isBedItem(String itemId) {
			Identifier id = Identifier.tryParse(itemId);
			return id != null && BuiltInRegistries.ITEM.getValue(id) instanceof BedItem;
		}

		private enum BedRoom {
			READY,
			TURNED,
			BLOCKED,
		}

		/**
		 * A bed occupies the clicked cell and the cell in front of the player.
		 * Vanilla derives that second cell from the player's heading, and the
		 * server applies the heading sent in the movement packet, which lags
		 * `setYRot` by a tick. Turning toward a free heading and placing on
		 * the next tick keeps the client prediction and the server's
		 * placement from disagreeing about which half of the bed goes where.
		 */
		private BedRoom bedRoom(Minecraft client, BlockPos foot) {
			if (!cellFree(client, foot)) return BedRoom.BLOCKED;
			Direction start = client.player.getDirection();
			if (cellFree(client, foot.relative(start))) return BedRoom.READY;
			for (Direction candidate : Direction.Plane.HORIZONTAL) {
				if (candidate == start) continue;
				if (!cellFree(client, foot.relative(candidate))) continue;
				client.player.setYRot(Direction.getYRot(candidate));
				awaitingRotation = true;
				return BedRoom.TURNED;
			}
			return BedRoom.BLOCKED;
		}

		private static boolean cellFree(Minecraft client, BlockPos pos) {
			return client.level.getBlockState(pos).canBeReplaced();
		}

		@Override
		void tick(Minecraft client) {
			if (awaitingRotation) {
				awaitingRotation = false;
				beginPlacement(client);
				return;
			}
			if (awaitingSurfaceAim) {
				awaitingSurfaceAim = false;
				BlockHitResult surface = aimedSurface;
				aimedSurface = null;
				if (surface == null) {
					beginPlacement(client);
					return;
				}
				BlockHitResult hit = client.level.clip(
					new ClipContext(
						client.player.getEyePosition(),
						Vec3.atCenterOf(surface.getBlockPos()),
						ClipContext.Block.OUTLINE,
						ClipContext.Fluid.NONE,
						client.player
					)
				);
				if (!hit.getBlockPos().equals(surface.getBlockPos())) {
					beginPlacement(client);
					return;
				}
				targetPos = hit.getBlockPos().relative(hit.getDirection());
				beforeBlock = blockSnapshot(client, targetPos);
				beforeCount = client.player.getInventory().getSelectedItem().getCount();
				if (beforeBlock != null && !beforeBlock.replaceable()) {
					beginPlacement(client);
					return;
				}
				submittedAt = age;
				client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, hit);
				send.accept(progress(id, "confirming", placed, count));
				return;
			}
			if (submittedAt < 0) return;
			int afterCount = client.player.getInventory().getSelectedItem().getCount();
			if (
				InteractionEvidence.placementConfirmed(
					expectedBlock,
					beforeBlock,
					blockSnapshot(client, targetPos),
					beforeCount,
					afterCount,
					client.player.isCreative()
				)
			) {
				placed++;
				if ("minecraft:crafting_table".equals(expectedBlock) && targetPos != null) {
					placedCraftingTable = targetPos.immutable();
					craftingTablePlaced = true;
				}
				submittedAt = -1;
				if (placed >= count) {
					finish(id, "completed", null, null, placeEvidence(null));
					return;
				}
				send.accept(progress(id, "placed", placed, count));
				beginPlacement(client);
				return;
			}
			if (age - submittedAt <= InteractionEvidence.CONFIRM_TICKS) return;
			CraftMateBodyClient.LOGGER.info(
				"place unconfirmed item={} target={} before={} after={} count={}->{} player={} hit={}",
				expectedBlock,
				targetPos,
				beforeBlock == null ? null : beforeBlock.blockId(),
				blockSnapshot(client, targetPos) == null ? null : blockSnapshot(client, targetPos).blockId(),
				beforeCount,
				afterCount,
				client.player.position(),
				client.hitResult == null ? "none" : client.hitResult.getType()
			);
			submittedAt = -1;
			finish(
				id,
				"failed",
				"E_PRECONDITION",
				placed > 0
					? "only " + placed + " of " + count + " blocks were confirmed; the next placement rolled back"
					: "placement was submitted but the world did not show the requested block",
				placeEvidence("no confirmed placement (prediction may roll back)")
			);
		}

		private JsonObject placeEvidence(String problem) {
			JsonObject outcome = new JsonObject();
			outcome.addProperty(
				"summary",
				problem == null
					? "placed " + placed + " x " + blockId
					: placed > 0
						? "placed " + placed + " of " + count + " " + blockId
						: "placement submitted"
			);
			JsonArray changes = new JsonArray();
			for (int index = 0; index < placed; index++) {
				JsonObject change = new JsonObject();
				change.addProperty("kind", "block_placed");
				change.addProperty("detail", blockId);
				changes.add(change);
			}
			outcome.add("changes", changes);
			if (problem != null) {
				outcome.addProperty("problem", problem);
				JsonArray unconfirmed = new JsonArray();
				unconfirmed.add("placement submission was not confirmed by the world");
				outcome.add("unconfirmed", unconfirmed);
			}
			return outcome;
		}
	}

	private static Vec3 vec(JsonObject args) {
		JsonObject target = args.getAsJsonObject("target");
		if (target == null && args.has("x") && args.has("y") && args.has("z")) target = args;
		if (target == null) throw new IllegalArgumentException("missing target");
		return new Vec3(number(target, "x"), number(target, "y"), number(target, "z"));
	}

	/**
	 * Movement has to go through the same key state the human client reads.
	 * `ClientInput` in this version is only a holder: `KeyboardInput.tick`
	 * derives the actual move vector from these `KeyMapping`s. Assigning
	 * `keyPresses` directly leaves the player standing still.
	 */
	private static void setWalkInput(Minecraft client, boolean forward) {
		client.options.keyUp.setDown(forward);
		client.options.keyDown.setDown(false);
		client.options.keyLeft.setDown(false);
		client.options.keyRight.setDown(false);
		client.options.keyJump.setDown(false);
		client.options.keyShift.setDown(false);
		client.options.keySprint.setDown(false);
		// `KeyboardInput.tick` is a one-way state update in 1.21.11. Ask the
		// vanilla input object to derive the new move vector immediately;
		// setting `keyPresses` directly does not update `ClientInput`.
		if (client.player != null && client.player.input instanceof KeyboardInput keyboard) {
			keyboard.tick();
		}
	}

	static void releaseWalkInput(Minecraft client) {
		setWalkInput(client, false);
	}

	/**
	 * Returns the feet Y of a standable column within one block of the
	 * requested level, or `Integer.MIN_VALUE` for a gap, fluid or wall.
	 * Movement is limited to one-block steps up and one-block drops.
	 *
	 * <p>Callers validate the result with {@code == requestedY}. A column has
	 * a solid floor under its own feet, so a downward search would return
	 * `requestedY - 1` for every ordinary cell and reject the whole route.
	 * The start cell is therefore checked at its own level first, then the
	 * one-block step-up. A caller needing a one-block drop starts its search
	 * from the lower cell explicitly.
	 */
	static int standingY(Minecraft client, BlockPos at) {
		int lowest = at.getY() - PATH_STEP_DOWN;
		int highest = at.getY() + PATH_STEP_UP;
		// Prefer the requested level, then a step up, then a drop. The old
		// downward-first scan returned the floor under the body for its own
		// column, which broke every `== y` caller. Try the same-level cell
		// first so a normal shaft resolves to the feet position, not y - 1.
		for (int y : new int[] { at.getY(), at.getY() + 1, at.getY() - 1 }) {
			if (y < lowest || y > highest) continue;
			BlockPos floorPos = new BlockPos(at.getX(), y - 1, at.getZ());
			BlockPos feetPos = new BlockPos(at.getX(), y, at.getZ());
			BlockPos headPos = new BlockPos(at.getX(), y + 1, at.getZ());
			BlockState floor = client.level.getBlockState(floorPos);
			BlockState feet = client.level.getBlockState(feetPos);
			BlockState head = client.level.getBlockState(headPos);
			if (floor.blocksMotion()
				&& !floor.is(BlockTags.LEAVES)
				&& floor.getFluidState().isEmpty()
				&& feet.getFluidState().isEmpty()
				&& (feet.isAir() || !feet.blocksMotion())
				&& head.getFluidState().isEmpty()
				&& (head.isAir() || !head.blocksMotion())) {
				return y;
			}
		}
		return Integer.MIN_VALUE;
	}

	/**
	 * Vanilla stops a destroy when the mouse is not grabbed, which happens
	 * whenever another app is focused. The mixin keeps `continueAttack(true)`
	 * for exactly this window so the agent can mine without stealing focus.
	 */
	private static void holdMiningInput(Minecraft client) {
		miningInputHeld = true;
		client.missTime = 0;
	}

	public static boolean holdsMiningInput() {
		return miningInputHeld;
	}

	/**
	 * A task must not leave the synthetic attack key held after it finishes,
	 * is cancelled, or a reflex interrupts it.
	 */
	static void releaseMiningInput(Minecraft client) {
		miningInputHeld = false;
		if (client.gameMode != null && client.gameMode.isDestroying()) {
			client.gameMode.stopDestroyBlock();
		}
	}

	/** Releases every synthetic input a finished or interrupted task can own. */
	public static void releaseInputs(Minecraft client) {
		releaseMiningInput(client);
		if (client.options != null) releaseWalkInput(client);
	}

	private static BlockPos findBlock(Minecraft client, java.util.function.Predicate<BlockState> matches) {
		BlockPos origin = client.player.blockPosition();
		BlockPos best = null;
		double bestScore = Double.POSITIVE_INFINITY;
		Vec3 eye = client.player.getEyePosition();
		int radius = TARGET_SEARCH_RADIUS;
		for (BlockPos pos : BlockPos.betweenClosed(
			origin.offset(-radius, -16, -radius),
			origin.offset(radius, 16, radius)
		)) {
			BlockState state = client.level.getBlockState(pos);
			if (!matches.test(state)) continue;
			// The block under the body is also the closest matching block.
			// Selecting it made a surface stone task dig straight down into a
			// one-block shaft: the body lost its floor, could no longer path
			// anywhere, and every later hunt failed with "no reachable route".
			// Digging down may still be useful, but only through a staircase
			// plan that keeps an escape cell - never by removing the current
			// support block in place.
			if (removesCurrentSupport(client.player, pos)) continue;
			double distance = pos.distSqr(origin);
			if (distance > (double) radius * radius) continue;
			BlockPos candidate = pos.immutable();
			Vec3 center = Vec3.atCenterOf(candidate);
			BlockHitResult hit = client.level.clip(
				new ClipContext(
					eye,
					center,
					ClipContext.Block.OUTLINE,
					ClipContext.Fluid.NONE,
					client.player
				)
			);
			// A nearby block behind terrain is not a valid target. Prefer the
			// closest unobstructed face so the mining state machine can turn
			// toward it and start destroying it without an immediate stall.
			if (!hit.getBlockPos().equals(candidate)) continue;
			double score = eye.distanceToSqr(center);
			if (score < bestScore) {
				bestScore = score;
				best = candidate;
			}
		}
		return best;
	}

	/**
	 * True when breaking {@code block} would remove the floor the body stands
	 * on in its current column. This is a pure geometric guard; the caller
	 * still needs normal reach and line-of-sight checks for every real target.
	 */
	static boolean removesCurrentSupport(net.minecraft.world.entity.player.Player player, BlockPos block) {
		return removesCurrentSupport(player.getX(), player.getY(), player.getZ(), block);
	}

	static boolean removesCurrentSupport(double feetX, double feetY, double feetZ, BlockPos block) {
		return block.getX() == net.minecraft.util.Mth.floor(feetX)
			&& block.getZ() == net.minecraft.util.Mth.floor(feetZ)
			&& block.getY() >= net.minecraft.util.Mth.floor(feetY) - 2
			&& block.getY() < net.minecraft.util.Mth.floor(feetY);
	}

	/**
	 * Fallback for a log that is present but not currently visible. The walk
	 * loop turns toward it and the destroy loop still enforces line of sight
	 * before starting to break it, so this cannot mine through terrain.
	 */
	private static BlockPos findBlockUnclipped(
		Minecraft client,
		java.util.function.Predicate<BlockState> matches
	) {
		BlockPos origin = client.player.blockPosition();
		BlockPos best = null;
		double bestScore = Double.POSITIVE_INFINITY;
		int radius = TARGET_SEARCH_RADIUS;
		for (BlockPos pos : BlockPos.betweenClosed(
			origin.offset(-radius, -16, -radius),
			origin.offset(radius, 16, radius)
		)) {
			if (!matches.test(client.level.getBlockState(pos))) continue;
			double score = origin.distSqr(pos);
			if (score > (double) radius * radius) continue;
			if (score < bestScore) {
				bestScore = score;
				best = pos.immutable();
			}
		}
		return best;
	}

	/**
	 * True when at least one face of the block is exposed to open air. This is
	 * deliberately weaker than a centre raycast: a trunk surrounded by its own
	 * leaves can still have a choppable side once covered, while a block
	 * completely encased in stone has no face to mine from outside.
	 */
	private static boolean hasVisibleFace(Minecraft client, BlockPos block) {
		for (Direction direction : Direction.values()) {
			BlockPos neighbour = block.relative(direction);
			BlockState state = client.level.getBlockState(neighbour);
			if (!state.blocksMotion() && !state.is(BlockTags.LEAVES)) return true;
		}
		return false;
	}

	private static Entity nearestEntity(Minecraft client, String targetName) {
		return client.level.getEntitiesOfClass(Entity.class, client.player.getBoundingBox().inflate(16.0)).stream()
			.filter(entity -> entity != client.player && entity.isAlive())
			.filter(entity -> {
				String name = entity.getName().getString();
				String key = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
				return name.equalsIgnoreCase(targetName) || key.equalsIgnoreCase(targetName);
			})
			.filter(entity -> client.player.hasLineOfSight(entity))
			.min((left, right) -> Double.compare(left.distanceToSqr(client.player), right.distanceToSqr(client.player)))
			.orElse(null);
	}

	private static String blockId(Minecraft client, BlockPos pos) {
		BlockState state = client.level.getBlockState(pos);
		return state.isAir()
			? "minecraft:air"
			: BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
	}

	private static JsonArray nearbyBlocks(Minecraft client, LocalPlayer player) {
		JsonArray blocks = new JsonArray();
		Map<String, Integer> counts = new java.util.TreeMap<>();
		BlockPos origin = player.blockPosition();
		for (BlockPos pos : BlockPos.betweenClosed(origin.offset(-8, -4, -8), origin.offset(8, 4, 8))) {
			BlockState state = client.level.getBlockState(pos);
			if (state.isAir()) continue;
			String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
			counts.merge(id, 1, Integer::sum);
		}
		counts.entrySet().stream()
			.sorted((left, right) -> {
				// Wood decides whether autonomy should chop next. A generic
				// "most common blocks" limit let nearby water/sand hide a tree.
				boolean leftLog = isLogId(left.getKey());
				boolean rightLog = isLogId(right.getKey());
				if (leftLog != rightLog) return leftLog ? -1 : 1;
				return Integer.compare(right.getValue(), left.getValue());
			})
			.limit(32)
			.forEach(block -> {
			JsonObject summary = new JsonObject();
			summary.addProperty("id", block.getKey());
			summary.addProperty("count", block.getValue());
			blocks.add(summary);
			});
		return blocks;
	}

	private static boolean isLogId(String id) {
		return id.matches(".*[a-z_]+_(log|wood|stem|hyphae)$");
	}

	private static boolean nearbyBlocksContain(Minecraft client, LocalPlayer player, Block block) {
		BlockPos origin = player.blockPosition();
		for (BlockPos pos : BlockPos.betweenClosed(
			origin.offset(-8, -4, -8),
			origin.offset(8, 4, 8)
		)) {
			if (client.level.getBlockState(pos).is(block)) return true;
		}
		return false;
	}

	private static double round(double value) {
		return Math.round(value * 100.0) / 100.0;
	}

	private static int findHotbar(LocalPlayer player, String itemId) {
		Identifier id = Identifier.tryParse(itemId);
		for (int slot = 0; slot < 9; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!stack.isEmpty() && (stack.getItem() == BuiltInRegistries.ITEM.getValue(id))) return slot;
		}
		return -1;
	}

	private static boolean matches(ItemStack stack, String itemId) {
		Identifier id = Identifier.tryParse(itemId);
		return id != null && stack.getItem() == BuiltInRegistries.ITEM.getValue(id);
	}

	private static boolean blockMatches(ClientLevel level, BlockPos pos, String blockId) {
		Identifier id = Identifier.tryParse(blockId);
		return id != null && level.getBlockState(pos).getBlock() == BuiltInRegistries.BLOCK.getValue(id);
	}

	/**
	 * Captures the full block state, not just the registry ID. A door, chest
	 * or redstone component can change without changing its block type.
	 */
	private static InteractionEvidence.BlockSnapshot blockSnapshot(Minecraft client, BlockPos pos) {
		BlockState state = client.level.getBlockState(pos);
		return new InteractionEvidence.BlockSnapshot(
			BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString(),
			state.toString(),
			state.isAir(),
			state.canBeReplaced(),
			!state.getFluidState().isEmpty()
		);
	}

	private static JsonObject position(BlockPos pos) {
		JsonObject point = new JsonObject();
		point.addProperty("x", pos.getX());
		point.addProperty("y", pos.getY());
		point.addProperty("z", pos.getZ());
		return point;
	}
}
