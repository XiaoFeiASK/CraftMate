package com.craftmate.body.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
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
		"goto", "look_at", "mine_block", "chop_tree", "say", "wait", "attack", "equip", "eat", "use_block", "place_block"
	);
	private static final List<String> CAPABILITIES = List.of(
		"sensor", "move", "mine", "attack", "use", "build", "camera", "hud"
	);
	/**
	 * Trunks and leaves can hide a nearby log from a single eye ray. Keep the
	 * visible search local, but let the approach loop walk to a log that is
	 * inside the normal gameplay area. The destroy loop still requires an
	 * unobstructed face before it starts breaking, so this cannot mine through
	 * terrain.
	 */
	private static final int TARGET_SEARCH_RADIUS = 48;
	private static final Map<String, Task> TASKS = new ConcurrentHashMap<>();
	private static int clientTick;
	private static Reflexes reflexes;

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
		closeBlockingScreen(client);
		Task task = switch (op) {
			case "wait" -> new WaitTask(id, integer(args, "ticks", 1));
			case "say" -> new SayTask(id, required(args, "text"));
			case "look_at" -> new LookTask(id, args);
			case "goto" -> new GotoTask(id, args);
			case "mine_block" -> new MineTask(id, args);
			case "chop_tree" -> new MineTask(id, args, true);
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
	 * The body must be able to act without a human closing inventory, chat or
	 * another in-game menu. Keep this to screens that are safe to dismiss; the
	 * title and world-selection screens are only reachable before a world loads
	 * and are already rejected by readiness checks.
	 */
	private static void closeBlockingScreen(Minecraft client) {
		if (client.screen != null && client.level != null) client.setScreen(null);
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
		// Reflexes run before skills so a danger detected this tick stops the
		// input a task would otherwise press again, and so a task that is
		// already underway cannot finish the tick by walking into lava.
		if (reflexes == null || !reflexes.tick(client)) {
			advanceTasks(client);
		}
	}

	private static void advanceTasks(Minecraft client) {
		// `Minecraft.tick` sets `screen` to null while it ticks the world and
		// restores the same instance afterwards. A task runs inside that
		// window, so closing once at command acceptance is not enough: the
		// menu would come back and freeze walking or mining on the next frame.
		closeBlockingScreen(client);
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

	private static void finish(
		String id, String status, String code, String detail, JsonObject data
	) {
		Task task = TASKS.remove(id);
		if (task == null) return;
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
		private static final int STUCK_TICKS = 20 * 3;
		private final Vec3 target;
		private int lastProgressTick;
		private double lastHorizontal;
		private int stuckTicks;

		GotoTask(String id, JsonObject args) {
			super(id);
			this.target = vec(args);
		}

		@Override
		void start(Minecraft client) {
			lastHorizontal = horizontalDistance(client.player);
			send.accept(progress(id, "walking", 0, 1));
		}

		@Override
		void tick(Minecraft client) {
			LocalPlayer player = client.player;
			Vec3 offset = target.subtract(player.position());
			double horizontal = horizontalDistance(player);
			if (horizontal < 1.25 || age > 20 * 60) {
				stop(client);
				if (horizontal < 1.25) finish(id, "completed", null, null);
				else finish(id, "timeout", "E_TIMEOUT", "bounded walk did not reach target");
				return;
			}
			if (player.horizontalCollision && player.onGround()) {
				player.jumpFromGround();
			}
			if (horizontal + 0.05 < lastHorizontal) {
				lastHorizontal = horizontal;
				stuckTicks = 0;
			} else {
				stuckTicks++;
			}
			if (stuckTicks > STUCK_TICKS) {
				stop(client);
				finish(id, "failed", "E_PRECONDITION", "walk made no progress for 3 seconds");
				return;
			}
			player.setYRot((float) Math.toDegrees(Math.atan2(-offset.x, offset.z)));
			if (player.input != null) {
				setWalkInput(client, true);
			}
			if (age - lastProgressTick >= 20) {
				lastProgressTick = age;
				send.accept(progress(id, "walking", (int) Math.round(horizontal), (int) Math.round(age)));
			}
		}

		private double horizontalDistance(LocalPlayer player) {
			return Math.hypot(target.x - player.getX(), target.z - player.getZ());
		}

		@Override
		void stop(Minecraft client) {
			releaseWalkInput(client);
		}
	}

	private static final class MineTask extends Task {
		private static final int WALK_BASE_TICKS = 20 * 10;
		private static final int BREAK_TICKS = 20 * 25;
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
		private boolean destroying;
		private int lastReportedPercent = -1;
		private BlockState blockBeforeDestroy;
		private boolean breaking = false;
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
				stopMining(client);
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
				if (blockBeforeDestroy != null) minedBlocks.add(miningResult(target, blockBeforeDestroy));
				blockBeforeDestroy = null;
				if (mined >= count) {
					JsonObject evidence = new JsonObject();
					evidence.add("mined", minedBlocks);
					evidence.add("outcome", outcome("砍下 " + mined + " 个" + targetName(), minedBlocks, null));
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
						outcome("只砍到 " + mined + " 个" + targetName(), minedBlocks, "附近找不到更多")
					);
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"no further " + targetName() + " within " + TARGET_SEARCH_RADIUS + " blocks",
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
						walkingAge = 0;
					}
				}
				if (distance + 0.1 < lastApproachDistance) {
					lastApproachDistance = distance;
					lastWalkProgressAge = walkingAge;
				}
				double heading = Math.toRadians(player.getYRot());
				Vec3 ahead = player.position().add(
					-Math.sin(heading) * 0.6,
					0,
					Math.cos(heading) * 0.6
				);
				BlockPos foot = BlockPos.containing(ahead.x, player.getY() - 0.5, ahead.z);
				boolean ledge = client.level.getBlockState(foot).isAir()
					&& client.level.getBlockState(foot.below()).isAir();
				if (ledge && player.onGround()) {
					player.setDeltaMovement(0, 0.35, 0);
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
				} else if (walkingAge - lastWalkProgressAge > 20 * 3) {
					stop(client);
					finish(id, "failed", "E_PRECONDITION", targetName() + " approach made no progress for 3 seconds");
				}
				return;
			}
			releaseWalkInput(client);
			aimAt(player, center);
			BlockHitResult hit = clip(client, player, center);
			if (!hit.getBlockPos().equals(target)) {
				stopMining(client);
				target = null;
				finish(id, "failed", "E_PRECONDITION", "target is obstructed from the player's line of sight");
				return;
			}
			if (!breaking) {
				blockBeforeDestroy = client.level.getBlockState(target);
				side = hit.getDirection();
				if (!client.mouseHandler.isMouseGrabbed() && client.isWindowActive()) {
					client.mouseHandler.grabMouse();
				}
				client.missTime = 0;
				miningAge = 0;
				lastReportedPercent = -1;
				// Vanilla starts the destroy state only here. Calling
				// continueDestroyBlock first falls into its start branch and
				// resets progress on every tick, which makes the hand swing
				// forever while the block never breaks.
				client.gameMode.startDestroyBlock(target, side);
				destroying = true;
				breaking = true;
				send.accept(progress(id, "breaking", 0, 100));
			} else {
				if (!client.mouseHandler.isMouseGrabbed() && client.isWindowActive()) {
					client.mouseHandler.grabMouse();
				}
				client.gameMode.continueDestroyBlock(target, side);
			}
			client.missTime = 0;
			// The vanilla destroy loop owns accumulated progress. The block
			// state turning to air is the only trustworthy completion signal;
			// `getDestroyProgress` is a per-tick coefficient, and summing it
			// here only produced a fake progress bar while the block stayed.
			miningAge++;
			BlockState current = client.level.getBlockState(target);
			if (!current.isAir() && miningAge % 20 == 0) {
				int percent = Math.min(99, (int) Math.floor(100.0f * miningAge / BREAK_TICKS));
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

		private JsonObject miningResult(BlockPos position, BlockState state) {
			JsonObject evidence = new JsonObject();
			evidence.addProperty("block", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
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

		private BlockPos selectTarget(Minecraft client) {
			// A tall trunk can hide its lower logs behind leaves or adjacent
			// blocks. Prefer a directly visible log, then accept any log within
			// the same bounded search instead of failing while nearbyBlocks
			// clearly reports wood.
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

		private static BlockHitResult clip(Minecraft client, LocalPlayer player, Vec3 center) {
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
		private static void aimAt(LocalPlayer player, Vec3 center) {
			Vec3 direction = center.subtract(player.getEyePosition()).normalize();
			player.setYRot((float) Math.toDegrees(Math.atan2(-direction.x, direction.z)));
			player.setXRot((float) Math.toDegrees(-Math.asin(direction.y)));
		}

		private static int walkBudgetTicks(LocalPlayer player, BlockPos target) {
			double blocks = Math.sqrt(player.blockPosition().distSqr(target));
			return WALK_BASE_TICKS + (int) Math.ceil(blocks) * 20;
		}

		private void stopMining(Minecraft client) {
			if (client.gameMode != null && client.gameMode.isDestroying()) client.gameMode.stopDestroyBlock();
			destroying = false;
			breaking = false;
			lastReportedPercent = -1;
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
			.findFirst()
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
			.sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
			.limit(32)
			.forEach(block -> {
			JsonObject summary = new JsonObject();
			summary.addProperty("id", block.getKey());
			summary.addProperty("count", block.getValue());
			blocks.add(summary);
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
