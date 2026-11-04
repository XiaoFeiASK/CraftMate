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
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.client.gui.screens.recipebook.RecipeCollection;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.player.KeyboardInput;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.StackedItemContents;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.AbstractCraftingMenu;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.crafting.display.RecipeDisplay;
import net.minecraft.world.item.crafting.display.RecipeDisplayEntry;
import net.minecraft.world.item.crafting.display.RecipeDisplayId;
import net.minecraft.world.item.crafting.display.ShapedCraftingRecipeDisplay;
import net.minecraft.world.item.crafting.display.ShapelessCraftingRecipeDisplay;
import net.minecraft.world.item.crafting.display.SlotDisplay;
import net.minecraft.world.item.crafting.display.SlotDisplayContext;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BaseContainerBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
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
		"equip", "eat", "use_block", "place_block"
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
	private static final int PATH_STEP_UP = 1;
	private static final int PATH_STEP_DOWN = 1;
	private static final Map<String, Task> TASKS = new ConcurrentHashMap<>();
	private static int clientTick;
	private static Reflexes reflexes;
	private static volatile boolean miningInputHeld;

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
		if (!inWorld) return world;
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
		world.addProperty("onGround", player.onGround());
		world.addProperty("fallDistance", round(player.fallDistance));
		world.addProperty("verticalVelocity", round(player.getDeltaMovement().y));
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
		JsonArray entities = new JsonArray();
		client.level.getEntitiesOfClass(Entity.class, player.getBoundingBox().inflate(16.0)).stream()
			.filter(entity -> entity != player && entity.isAlive())
			.sorted((left, right) -> Double.compare(left.distanceToSqr(player), right.distanceToSqr(player)))
			.limit(16)
			.forEach(entity -> {
				JsonObject entry = new JsonObject();
				entry.addProperty("name", entity.getName().getString());
				entry.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString());
				entry.addProperty("distance", round(Math.sqrt(entity.distanceToSqr(player))));
				entities.add(entry);
			});
		world.add("entities", entities);
		world.add("nearbyBlocks", nearbyBlocks(client, player));
		return world;
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
				case "attack" -> new AttackTask(id, required(args, "target"));
				case "equip" -> new EquipTask(id, required(args, "item"));
				case "eat" -> new EatTask(id, optional(args, "item"));
				case "use_block" -> new UseBlockTask(id, optional(args, "block"));
				case "place_block" -> new PlaceTask(id, required(args, "block"), integer(args, "count", 1));
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

	static void cancel(Minecraft client, String id) {
		if (id != null) {
			Task task = TASKS.remove(id);
			if (task != null) {
				task.stop(client);
				task.send.accept(result(id, "cancelled", "E_CANCELLED", "cancelled by orchestrator"));
			}
			return;
		}
		stopLocally(client);
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

	static void update(Minecraft client) {
		tickTasks(client);
		// Reflexes run before skills so a danger detected this tick stops the
		// input a task would otherwise press again, and so a task that is
		// already underway cannot finish the tick by walking into lava.
		if (reflexes == null || !reflexes.tick(client)) {
			advanceTasks(client);
		}
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
			releaseWalkInput(client);
			CameraController.release();
		}
	}

	private static final class MineTask extends Task {
		private static final int WALK_BASE_TICKS = 20 * 10;
		private static final int BREAK_TICKS = 20 * 25;
		private static final int APPROACH_STALL_TICKS = 20 * 3;
		private static final int MAX_REPLANS = 3;
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
			target = selectTarget(client);
			if (target == null) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"no " + targetName() + " within " + TARGET_SEARCH_RADIUS + " blocks"
				);
				return;
			}
			walking = !canReach(client.player, target) || !canSee(client, client.player, target);
			lastApproachDistance = Double.POSITIVE_INFINITY;
			send.accept(progress(id, "target", 0, count));
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
				blockBeforeDestroy = null;
				if (mined >= count) {
					JsonObject evidence = new JsonObject();
					evidence.add("mined", minedBlocks);
					evidence.add(
						"outcome",
						outcome(
							(anyLog ? "砍下 " : "挖掉 ") + mined + " 个" + targetName(),
							minedBlocks,
							null
						)
					);
					finish(id, "completed", null, null, evidence);
					return;
				}
				target = selectTarget(client);
				if (target == null) {
					walking = false;
					JsonObject evidence = new JsonObject();
					evidence.add("mined", minedBlocks);
					evidence.add(
						"outcome",
						outcome(
							(anyLog ? "只砍到 " : "只挖到 ") + mined + " 个" + targetName(),
							minedBlocks,
							"附近找不到更多"
						)
					);
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"only " + mined + " of " + count + " " + targetName() + " found",
						evidence
					);
					return;
				}
				side = Direction.UP;
				miningAge = 0;
				walking = !canReach(client.player, target) || !canSee(client, client.player, target);
				lastApproachDistance = Double.POSITIVE_INFINITY;
				lastReportedPercent = -1;
				return;
			}
			LocalPlayer player = client.player;
			Vec3 center = Vec3.atCenterOf(target);
			CameraController.hold(player);
			aimAt(player, center);
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
					finish(id, "timeout", "E_TIMEOUT", "could not reach " + targetName() + " in time");
				} else if (walkingAge - lastWalkProgressAge > APPROACH_STALL_TICKS) {
					if (++replans > MAX_REPLANS) {
						stop(client);
						finish(id, "failed", "E_PRECONDITION", "no reachable " + targetName() + " after replanning");
						return;
					}
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
					BlockPos canopy = findBlock(client, candidateState ->
						candidateState.is(BlockTags.LEAVES)
					);
					if (canopy != null) {
						// A canopy can completely surround the trunk. The
						// normal destroy state machine can clear the leaf that
						// blocks the next step; it is not a chop count.
						target = canopy;
						desiredTarget = null;
						side = Direction.UP;
						miningAge = 0;
						walking = false;
						breaking = false;
						breakingLeaves = true;
						lastReportedPercent = -1;
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
			if (anyLog) return findBlock(client, state -> state.is(BlockTags.LOGS));
			Block block = BuiltInRegistries.BLOCK.getValue(Identifier.parse(blockId));
			return findBlock(client, state -> state.is(block));
		}

		/**
		 * A different visible target can be reached without crossing the gap
		 * that blocked the previous one. Prefer one whose shortest safe route
		 * reaches it rather than merely selecting the next visible log.
		 */
		private BlockPos findApproachTarget(Minecraft client, BlockPos excluded) {
			BlockPos origin = client.player.blockPosition();
			BlockPos best = null;
			double bestDistance = Double.POSITIVE_INFINITY;
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
				if (!reachableStandingSpot(client, candidate)) continue;
				if (distance < bestDistance) {
					bestDistance = distance;
					best = candidate;
				}
			}
			return best;
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
				desiredTarget = null;
				return reachable;
			}
			BlockPos direct = findTarget(client);
			if (direct != null) {
				desiredTarget = null;
				return direct;
			}
			if (anyLog) {
				BlockPos nearby = findBlockUnclipped(client, state -> state.is(BlockTags.LOGS));
				if (nearby != null) {
					desiredTarget = null;
					return nearby;
				}
			}
			return anyLog ? null : findCoveredTarget(client);
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

		@Override
		void stop(Minecraft client) {
			stopMining(client);
			releaseWalkInput(client);
			CameraController.release();
		}

		private static boolean canReach(LocalPlayer player, BlockPos target) {
			// Use the client's own block interaction range. Eye-to-center
			// rejects a log at the player's feet and leaves the walk loop
			// pushing forever instead of starting to destroy it.
			return player.isWithinBlockInteractionRange(target, 0.0);
		}

		private static boolean canSee(Minecraft client, LocalPlayer player, BlockPos target) {
			return clip(client, player, Vec3.atCenterOf(target)).getBlockPos().equals(target);
		}

		/**
		 * Use the same conservative sample walk as `GotoTask` to decide if the
		 * body can stand beside a block. A visible log on a cliff is not a
		 * usable target just because the line of sight is clear.
		 */
		private static boolean reachableStandingSpot(Minecraft client, BlockPos target) {
			LocalPlayer player = client.player;
			for (Direction direction : Direction.Plane.HORIZONTAL) {
				BlockPos spot = target.relative(direction);
				BlockState below = client.level.getBlockState(spot.below());
				BlockState feet = client.level.getBlockState(spot);
				BlockState head = client.level.getBlockState(spot.above());
				if (!below.blocksMotion() || !below.getFluidState().isEmpty()) continue;
				if (feet.blocksMotion() || head.blocksMotion()) continue;
				double distance = Math.hypot(
					spot.getX() + 0.5 - player.getX(),
					spot.getZ() + 0.5 - player.getZ()
				);
				if (distance <= player.blockInteractionRange() + 0.5) return true;
			}
			return false;
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
		private static final int WALK_BUDGET_TICKS = 20 * 15;
		private static final int APPROACH_STALL_TICKS = 20 * 3;
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
		private double lastApproachDistance = Double.POSITIVE_INFINITY;
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
			table = tablePos != null;
			walking = table && !canInteract(client, client.player, tablePos);
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
					"crafting table approach made no progress for 3 seconds",
					evidence("could not reach a safe interaction spot beside the table")
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
					evidence("refused an unsafe crafting table approach")
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
			if (table) {
				if (tablePos == null || !client.level.getBlockState(tablePos).is(Blocks.CRAFTING_TABLE)) {
					finish(id, "failed", "E_WORLD_CHANGED", "crafting table disappeared", evidence("the crafting table was removed"));
					return;
				}
				if (!canInteract(client, client.player, tablePos)) {
					walking = true;
					lastApproachDistance = Double.POSITIVE_INFINITY;
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
			for (RecipeCollection collection : client.player.getRecipeBook().getCollections()) {
				for (RecipeDisplayEntry entry : collection.getRecipes()) {
					RecipeDisplay display = entry.display();
					if (!fits(display, width, height)) continue;
					if (!produces(display, client)) continue;
					int output = outputCount(display, client);
					if (output <= 0) continue;
					boolean craftable = entry.canCraft(contents);
					RecipeChoice choice = new RecipeChoice(entry.id(), output, craftable);
					if (craftable && made + output >= requested) return choice;
					if (fallback == null || (craftable && !fallback.craftable())) fallback = choice;
				}
			}
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

		private record RecipeChoice(RecipeDisplayId id, int output, boolean craftable) {
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
		private final String targetName;
		private Entity target;
		private InteractionEvidence.TargetSnapshot before;
		private boolean submitted;
		private int submittedAt = -1;

		AttackTask(String id, String targetName) {
			super(id);
			this.targetName = targetName;
		}

		@Override
		void start(Minecraft client) {
			target = nearestEntity(client, targetName);
			before = snapshot(client, target);
		}

		@Override
		void tick(Minecraft client) {
			if (!submitted) {
				String blocked = InteractionEvidence.attackBlocked(before);
				if (blocked != null) {
					finish(id, "failed", "E_PRECONDITION", blocked, attackEvidence(blocked));
					return;
				}
				if (!InteractionEvidence.attackReady(client.player.getAttackStrengthScale(0.5f))) {
					send.accept(progress(id, "charging", 0, 1));
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
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"target disappeared before the hit could be confirmed",
					attackEvidence("hit was submitted but the target could not be verified")
				);
				return;
			}
			InteractionEvidence.TargetSnapshot now = snapshot(client, target);
			if (InteractionEvidence.attackConfirmed(before, now)) {
				finish(id, "completed", null, null, attackEvidence(null));
				return;
			}
			if (age - submittedAt <= InteractionEvidence.CONFIRM_TICKS) return;
			String blocked = InteractionEvidence.attackBlocked(now);
			finish(
				id,
				"failed",
				"E_PRECONDITION",
				blocked == null ? "attack did not change the target's health" : blocked,
				attackEvidence("the swing produced no confirmed health change")
			);
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

		private JsonObject attackEvidence(String problem) {
			JsonObject outcome = new JsonObject();
			JsonObject change = new JsonObject();
			change.addProperty("kind", "entity_damaged");
			change.addProperty("detail", targetName);
			JsonObject position = new JsonObject();
			position.addProperty("x", round(target.getX()));
			position.addProperty("y", round(target.getY()));
			position.addProperty("z", round(target.getZ()));
			change.add("position", position);
			JsonArray changes = new JsonArray();
			if (problem == null) changes.add(change);
			outcome.add("changes", changes);
			outcome.addProperty("summary", problem == null ? "confirmed damage to " + targetName : "swing submitted");
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

	private static final class EatTask extends Task {
		private final String itemId;
		private int ticks;
		private boolean useObserved;
		private int foodBefore;
		private String itemBefore;
		private int countBefore;
		private boolean startedUse;

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
			client.gameMode.useItem(player, InteractionHand.MAIN_HAND);
			useObserved = player.isUsingItem();
			startedUse = useObserved;
			send.accept(progress(id, "eating", 0, 1));
		}

		@Override
		void tick(Minecraft client) {
			ticks++;
			boolean using = client.player.isUsingItem();
			if (using) useObserved = true;
			if (useObserved && !using) {
				int foodAfter = client.player.getFoodData().getFoodLevel();
				ItemStack stack = client.player.getInventory().getSelectedItem();
				String itemAfter = stack.isEmpty()
					? null
					: BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				boolean consumed =
					foodAfter > foodBefore
						|| InteractionEvidence.itemChanged(itemBefore, countBefore, itemAfter, stack.getCount());
				JsonObject evidence = foodEvidence(consumed, foodAfter);
				if (consumed) {
					finish(id, "completed", null, null, evidence);
				} else {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"eating stopped without a food or item change",
						evidence
					);
				}
			} else if (!useObserved && ticks > 4) {
				finish(id, "failed", "E_PRECONDITION", "held item is not edible");
			} else if (ticks > 20 * 7) {
				finish(id, "failed", "E_TIMEOUT", "eating did not finish");
			}
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
		private final String blockId;
		private final int count;
		private int placed;
		private BlockPos targetPos;
		private InteractionEvidence.BlockSnapshot beforeBlock;
		private int beforeCount;
		private int submittedAt = -1;

		PlaceTask(String id, String blockId, int count) {
			super(id);
			this.blockId = blockId;
			this.count = count;
		}

		@Override
		boolean validate(Minecraft client) {
			return super.validate(client);
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
			if (hit == null) {
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
			targetPos = hit.getBlockPos().relative(hit.getDirection());
			beforeBlock = blockSnapshot(client, targetPos);
			beforeCount = client.player.getInventory().getSelectedItem().getCount();
			submittedAt = age;
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
			client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, hit);
			send.accept(progress(id, "confirming", placed, count));
		}

		@Override
		void tick(Minecraft client) {
			if (submittedAt < 0) return;
			int afterCount = client.player.getInventory().getSelectedItem().getCount();
			if (
				InteractionEvidence.placementConfirmed(
					blockId,
					beforeBlock,
					blockSnapshot(client, targetPos),
					beforeCount,
					afterCount,
					client.player.isCreative()
				)
			) {
				placed++;
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

	private static void releaseWalkInput(Minecraft client) {
		setWalkInput(client, false);
	}

	/**
	 * Returns the feet Y of a standable column within one block of the
	 * expected level, or `Integer.MIN_VALUE` for a gap, fluid, or wall.
	 * Movement is limited to one-block steps up and one-block drops.
	 */
	static int standingY(Minecraft client, BlockPos at) {
		for (int offset = -PATH_STEP_DOWN; offset <= PATH_STEP_UP; offset++) {
			BlockPos candidate = at.above(offset);
			BlockState floor = client.level.getBlockState(candidate.below());
			BlockState feet = client.level.getBlockState(candidate);
			BlockState head = client.level.getBlockState(candidate.above());
			if (floor.blocksMotion()
				&& floor.getFluidState().isEmpty()
				&& feet.getFluidState().isEmpty()
				&& (feet.isAir() || !feet.blocksMotion())
				&& head.getFluidState().isEmpty()
				&& (head.isAir() || !head.blocksMotion())) {
				return candidate.getY();
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
