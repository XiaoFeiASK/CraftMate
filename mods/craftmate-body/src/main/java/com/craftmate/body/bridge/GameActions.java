package com.craftmate.body.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Commands are state machines advanced by the client thread. A task remains
 * accepted/running until the world shows observable progress or it fails.
 */
final class GameActions {
	private static final List<String> SKILLS = List.of(
		"goto", "look_at", "mine_block", "say", "wait", "attack", "equip", "eat", "use_block", "place_block"
	);
	private static final List<String> CAPABILITIES = List.of(
		"sensor", "move", "mine", "attack", "use", "build", "camera", "hud"
	);
	private static final Map<String, Task> TASKS = new ConcurrentHashMap<>();
	private static int clientTick;

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
		world.addProperty("health", round(player.getHealth()));
		world.addProperty("food", player.getFoodData().getFoodLevel());
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

	/**
	 * Registers and validates a command without producing any wire result.
	 * The caller acknowledges accepted commands before task progress or an
	 * immediate result can be emitted.
	 */
	static StartDecision start(Minecraft client, String id, String op, JsonObject args, Consumer<JsonObject> send) {
		if (TASKS.containsKey(id)) {
			return StartDecision.rejected("E_BUSY", "duplicate task id");
		}
		Task task = switch (op) {
			case "wait" -> new WaitTask(id, integer(args, "ticks", 1));
			case "say" -> new SayTask(id, required(args, "text"));
			case "look_at" -> new LookTask(id, args);
			case "goto" -> new GotoTask(id, args);
			case "mine_block" -> new MineTask(id, args);
			case "attack" -> new AttackTask(id, required(args, "target"));
			case "equip" -> new EquipTask(id, required(args, "item"));
			case "eat" -> new EatTask(id, optional(args, "item"));
			case "use_block" -> new UseBlockTask(id, optional(args, "block"));
			case "place_block" -> new PlaceTask(id, required(args, "block"), integer(args, "count", 1));
			default -> null;
		};
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
		for (Task task : new ArrayList<>(TASKS.values())) {
			if (!task.started || !TASKS.containsKey(task.id)) continue;
			try {
				task.tick(client);
			} catch (Throwable error) {
				finish(task.id, "failed", "E_INTERNAL", message(error));
			}
		}
	}

	private static void finish(String id, String status, String code, String detail) {
		Task task = TASKS.remove(id);
		if (task == null) return;
		if (task.send != null) task.send.accept(result(id, status, code, detail));
	}

	private static JsonObject result(String id, String status, String code, String detail) {
		return BridgeMessages.result(id, status, code, detail);
	}

	private static JsonObject progress(String id, String phase, int done, int total) {
		return BridgeMessages.progress(id, phase, done, total);
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

	private static double number(JsonObject args, String name) {
		return args.getAsJsonObject("target").get(name).getAsDouble();
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

		LookTask(String id, JsonObject args) {
			super(id);
			this.target = vec(args);
		}

		@Override
		void start(Minecraft client) {
			LocalPlayer player = client.player;
			Vec3 eyes = player.getEyePosition();
			Vec3 direction = target.subtract(eyes).normalize();
			player.setYRot((float) Math.toDegrees(Math.atan2(-direction.x, direction.z)));
			player.setXRot((float) Math.toDegrees(-Math.asin(direction.y)));
			finish(id, "completed", null, null);
		}

		@Override
		void tick(Minecraft client) {
		}
	}

	private static final class GotoTask extends Task {
		private final Vec3 target;
		private int lastProgressTick;

		GotoTask(String id, JsonObject args) {
			super(id);
			this.target = vec(args);
		}

		@Override
		void start(Minecraft client) {
			send.accept(progress(id, "walking", 0, 1));
		}

		@Override
		void tick(Minecraft client) {
			LocalPlayer player = client.player;
			Vec3 offset = target.subtract(player.position());
			double horizontal = Math.hypot(offset.x, offset.z);
			if (horizontal < 1.25 || age > 20 * 60) {
				stop(client);
				if (horizontal < 1.25) finish(id, "completed", null, null);
				else finish(id, "timeout", "E_TIMEOUT", "bounded walk did not reach target");
				return;
			}
			if (player.horizontalCollision) {
				stop(client);
				finish(id, "failed", "E_PRECONDITION", "walk blocked by terrain");
				return;
			}
			player.setYRot((float) Math.toDegrees(Math.atan2(-offset.x, offset.z)));
			if (player.input != null) {
				player.input.keyPresses = new net.minecraft.world.entity.player.Input(
					true, false, false, false, false, false, false
				);
			}
			if (age - lastProgressTick >= 20) {
				lastProgressTick = age;
				send.accept(progress(id, "walking", (int) Math.round(horizontal), (int) Math.round(age)));
			}
		}

		@Override
		void stop(Minecraft client) {
			if (client.player != null && client.player.input != null) {
				client.player.input.keyPresses = net.minecraft.world.entity.player.Input.EMPTY;
			}
		}
	}

	private static final class MineTask extends Task {
		private final String blockId;
		private final int count;
		private int mined;
		private BlockPos target;
		private Direction side;
		private int lastMinedCount;
		private int miningAge;
		private boolean walking;
		private boolean destroying;
		private float lastProgress;
		private int stalledTicks;

		MineTask(String id, JsonObject args) {
			super(id);
			this.blockId = required(args, "block");
			this.count = integer(args, "count", 1);
		}

		@Override
		boolean validate(Minecraft client) {
			if (!super.validate(client)) return false;
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
			Block block = BuiltInRegistries.BLOCK.getValue(Identifier.parse(blockId));
			target = findBlock(client, block);
			if (target == null) {
				finish(id, "failed", "E_PRECONDITION", "no visible " + blockId + " within 32 blocks");
				return;
			}
			walking = !canReach(client.player, target);
		}

		@Override
		void tick(Minecraft client) {
			if (target == null || client.level.getBlockState(target).isAir()) {
				stopMining(client);
				mined++;
				send.accept(progress(id, "mining", mined, count));
				if (mined >= count) {
					finish(id, "completed", null, null);
					return;
				}
				Block block = BuiltInRegistries.BLOCK.getValue(Identifier.parse(blockId));
				target = findBlock(client, block);
				if (target == null) {
					walking = false;
					finish(id, "failed", "E_PRECONDITION", "no further " + blockId + " within 32 blocks");
					return;
				}
				side = Direction.UP;
				miningAge = 0;
				walking = !canReach(client.player, target);
				lastProgress = 0;
				stalledTicks = 0;
			}
			LocalPlayer player = client.player;
			Vec3 center = Vec3.atCenterOf(target);
			Vec3 direction = center.subtract(player.getEyePosition()).normalize();
			player.setYRot((float) Math.toDegrees(Math.atan2(-direction.x, direction.z)));
			player.setXRot((float) Math.toDegrees(-Math.asin(direction.y)));
			if (walking) {
				if (player.input != null) {
					player.input.keyPresses = new net.minecraft.world.entity.player.Input(true, false, false, false, false, false, false);
				}
				if (canReach(player, target)) {
					walking = false;
					lastProgress = 0;
					stalledTicks = 0;
					if (player.input != null) player.input.keyPresses = net.minecraft.world.entity.player.Input.EMPTY;
				}
				return;
			}
			if (player.input != null) player.input.keyPresses = net.minecraft.world.entity.player.Input.EMPTY;
			BlockHitResult hit = client.level.clip(
				new ClipContext(
					player.getEyePosition(),
					center,
					ClipContext.Block.OUTLINE,
					ClipContext.Fluid.NONE,
					player
				)
			);
			if (!hit.getBlockPos().equals(target)) {
				stopMining(client);
				target = null;
				finish(id, "failed", "E_PRECONDITION", "target is obstructed from the player's line of sight");
				return;
			}
			boolean sameDestroyTarget = destroying && client.gameMode.isDestroying();
			if (!sameDestroyTarget) {
				stopMining(client);
				side = Direction.getNearest(
					(int) Math.round(center.x - player.getX()),
					(int) Math.round(center.y - player.getY()),
					(int) Math.round(center.z - player.getZ()),
					Direction.UP
				);
				client.gameMode.startDestroyBlock(target, side);
				player.swing(InteractionHand.MAIN_HAND);
				// Progress is emitted when a block actually disappears below;
				// sending it for every new start would flood the coordinator.
				miningAge = 0;
				lastProgress = 0;
				stalledTicks = 0;
				destroying = true;
			} else {
				client.gameMode.continueDestroyBlock(target, side);
				player.swing(InteractionHand.MAIN_HAND);
			}
			client.gameMode.tick();
			float progress = blockProgress(client, target);
			if (progress <= lastProgress + 0.0001f) stalledTicks++;
			else stalledTicks = 0;
			lastProgress = Math.max(lastProgress, progress);
			if (stalledTicks > 20 * 5) {
				stopMining(client);
				finish(id, "failed", "E_PRECONDITION", "target block is not being destroyed");
			}
			miningAge++;
			if (miningAge > 20 * 20) {
				stopMining(client);
				finish(id, "failed", "E_TIMEOUT", "block did not break");
			}
		}

		@Override
		void stop(Minecraft client) {
			stopMining(client);
			if (client.player != null && client.player.input != null) client.player.input.keyPresses = net.minecraft.world.entity.player.Input.EMPTY;
		}

		private static boolean canReach(LocalPlayer player, BlockPos target) {
			Vec3 center = Vec3.atCenterOf(target);
			return player.getEyePosition().distanceToSqr(center) <= 4.5 * 4.5;
		}

		private void stopMining(Minecraft client) {
			if (client.gameMode != null && client.gameMode.isDestroying()) client.gameMode.stopDestroyBlock();
			destroying = false;
		}

		private static float blockProgress(Minecraft client, BlockPos target) {
			BlockState state = client.level.getBlockState(target);
			return state.getDestroyProgress(
				client.player,
				client.level,
				target
			);
		}
	}

	private static final class AttackTask extends Task {
		private final String targetName;

		AttackTask(String id, String targetName) {
			super(id);
			this.targetName = targetName;
		}

		@Override
		void start(Minecraft client) {
			Entity entity = nearestEntity(client, targetName);
			if (entity == null) {
				finish(id, "failed", "E_PRECONDITION", "no visible target");
				return;
			}
			if (entity.distanceToSqr(client.player) > 3.0 * 3.0) {
				finish(id, "failed", "E_PRECONDITION", "target is out of reach");
				return;
			}
			client.gameMode.attack(client.player, entity);
			client.player.swing(InteractionHand.MAIN_HAND);
			finish(id, "completed", null, null);
		}

		@Override
		void tick(Minecraft client) {
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
			finish(id, "completed", null, null);
		}

		@Override
		void tick(Minecraft client) {
		}
	}

	private static final class EatTask extends Task {
		private final String itemId;
		private int ticks;
		private boolean useObserved;

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
			client.gameMode.useItem(player, InteractionHand.MAIN_HAND);
			useObserved = player.isUsingItem();
			send.accept(progress(id, "eating", 0, 1));
		}

		@Override
		void tick(Minecraft client) {
			ticks++;
			boolean using = client.player.isUsingItem();
			if (using) useObserved = true;
			if (useObserved && !using) {
				finish(id, "completed", null, null);
			} else if (!useObserved && ticks > 4) {
				finish(id, "failed", "E_PRECONDITION", "held item is not edible");
			} else if (ticks > 20 * 7) {
				finish(id, "failed", "E_TIMEOUT", "eating did not finish");
			}
		}
	}

	private static final class UseBlockTask extends Task {
		private final String blockId;

		UseBlockTask(String id, String blockId) {
			super(id);
			this.blockId = blockId;
		}

		@Override
		void start(Minecraft client) {
			BlockHitResult hit = client.player.pick(5.0, 1.0f, false) instanceof BlockHitResult blockHit ? blockHit : null;
			if (hit != null && (blockId == null || blockMatches(client.level, hit.getBlockPos(), blockId))) {
				client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, hit);
				finish(id, "completed", null, null);
			} else if (blockId == null) {
				client.gameMode.useItem(client.player, InteractionHand.MAIN_HAND);
				finish(id, "completed", null, null);
			} else {
				finish(id, "failed", "E_PRECONDITION", "target block is outside reach or view");
			}
		}

		@Override
		void tick(Minecraft client) {
		}
	}

	private static final class PlaceTask extends Task {
		private final String blockId;
		private final int count;

		PlaceTask(String id, String blockId, int count) {
			super(id);
			this.blockId = blockId;
			this.count = count;
		}

		@Override
		void start(Minecraft client) {
			int slot = findHotbar(client.player, blockId);
			if (slot < 0) {
				finish(id, "failed", "E_PRECONDITION", "block item is not in hotbar");
				return;
			}
			client.player.getInventory().setSelectedSlot(slot);
			BlockHitResult hit = client.player.pick(5.0, 1.0f, false) instanceof BlockHitResult blockHit ? blockHit : null;
			if (hit == null) {
				finish(id, "failed", "E_PRECONDITION", "no placement surface in view");
				return;
			}
			client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, hit);
			finish(id, "completed", null, count == 1 ? null : "one placement per command");
		}

		@Override
		void tick(Minecraft client) {
		}
	}

	private static Vec3 vec(JsonObject args) {
		JsonObject target = args.getAsJsonObject("target");
		if (target == null) throw new IllegalArgumentException("missing target");
		return new Vec3(number(target, "x"), number(target, "y"), number(target, "z"));
	}

	private static BlockPos findBlock(Minecraft client, Block block) {
		BlockPos origin = client.player.blockPosition();
		BlockPos best = null;
		double bestScore = Double.POSITIVE_INFINITY;
		Vec3 eye = client.player.getEyePosition();
		for (BlockPos pos : BlockPos.betweenClosed(origin.offset(-32, -16, -32), origin.offset(32, 16, 32))) {
			if (!client.level.getBlockState(pos).is(block)) continue;
			double distance = pos.distSqr(origin);
			if (distance > 32.0 * 32.0) continue;
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

	private static Entity nearestEntity(Minecraft client, String targetName) {
		return client.level.getEntitiesOfClass(Entity.class, client.player.getBoundingBox().inflate(16.0)).stream()
			.filter(entity -> entity != client.player && entity.isAlive())
			.filter(entity -> {
				String name = entity.getName().getString();
				String key = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
				return name.equalsIgnoreCase(targetName) || key.equalsIgnoreCase(targetName);
			})
			.findFirst()
			.orElse(null);
	}

	private static JsonArray nearbyBlocks(Minecraft client, LocalPlayer player) {
		JsonArray blocks = new JsonArray();
		BlockPos origin = player.blockPosition();
		client.level.getBlockStates(
			new net.minecraft.world.phys.AABB(origin).inflate(8.0)
		).filter(state -> !state.isAir()).limit(32).forEach(state -> {
			JsonObject entry = new JsonObject();
			entry.addProperty("id", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
			blocks.add(entry);
		});
		return blocks;
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
}
