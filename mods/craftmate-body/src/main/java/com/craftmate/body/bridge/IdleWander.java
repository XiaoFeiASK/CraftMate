package com.craftmate.body.bridge;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import com.craftmate.body.CraftMateBodyClient;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.EnderMan;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/**
 * What a player does between instructions: look around, stretch their legs,
 * pick up what is lying on the ground. Without it the body stands perfectly
 * still whenever the coordinator is backing off or thinking, which reads as a
 * frozen agent even though the loop is healthy.
 *
 * <p>This runs only when no command is active and the agent owns the body. Any
 * arriving command resets it immediately, so it can never compete with real
 * work.
 */
final class IdleWander {
	/**
	 * Half a second is enough for the orchestrator to hand over the next
	 * autonomous goal step. The old 1.5-second quiet window inserted a visible
	 * stand-still between every short task and was a large part of why the
	 * body looked like it walked, stopped, and thought forever.
	 */
	private static final int QUIET_TICKS = 10;
	private static final int MIN_WALK_TICKS = 20 * 4;
	private static final int MAX_WALK_TICKS = 20 * 10;
	private static final int MIN_LOOK_TICKS = 20 * 2;
	private static final int MAX_LOOK_TICKS = 20 * 4;
	private static final double MIN_LEG = 5.0;
	private static final double MAX_LEG = 13.0;
	private static final double FETCH_RADIUS = 10.0;
	private static final double PACKED_FETCH_RADIUS = 4.0;
	/**
	 * A nearly full backpack turns a random stroll into visible pacing: the
	 * body cannot pick up most loot and keeps drifting around the same camp
	 * while the goal runtime backs off. Stand and look instead.
	 */
	private static final int PACKED_SLOTS = 28;
	/**
	 * Looking at an enderman's face is an attack, not sightseeing. Idle time
	 * has no reason to take that risk: suppress random panning near one and
	 * only walk along routes whose headings stay outside its gaze cone.
	 */
	private static final double ENDERMAN_RADIUS = 24.0;
	private static final float ENDERMAN_GAZE_CONE = 22.0f;
	/**
	 * Sample a stroll at roughly half-block intervals. Checking only the
	 * destination lets a random heading cut through a one-block wall, while
	 * sampling every tick is needless work for a seven-block walk.
	 */
	private static final int WALK_DIRECTIONS = 16;
	private static final int WALK_SEARCH_NODES = 700;

	private enum Action {
		NONE,
		WALK,
		LOOK,
		FETCH,
		DESCEND,
	}

	private static final Random RANDOM = new Random();
	private static int quietTicks;
	private static int actionTicks;
	private static int holdTicks;
	private static int deferTicks;
	private static Action action = Action.NONE;
	private static double goalX;
	private static double goalZ;
	private static List<BoundedPathfinder.Cell> waypoints = List.of();
	private static int waypointIndex;
	private static float lookYaw;
	private static float lookPitch;
	private static ItemEntity fetch;

	private IdleWander() {
	}

	/** Called once per client tick while the command queue is empty. */
	static void tick(Minecraft client, boolean agentControlled) {
		LocalPlayer player = client.player;
		if (
			!agentControlled
				|| player == null
				|| client.level == null
				|| !player.isAlive()
				|| player.isSleeping()
				|| client.screen != null
		) {
			reset(client);
			return;
		}
		if (quietTicks < QUIET_TICKS) {
			quietTicks++;
			if (quietTicks == QUIET_TICKS) {
				CraftMateBodyClient.LOGGER.info(
					"CraftMate idle window opened at {}, {}, {}",
					player.getX(),
					player.getY(),
					player.getZ()
				);
			}
			return;
		}
		if (action == Action.NONE) {
			if (deferTicks > 0) {
				deferTicks--;
				return;
			}
			choose(client, player);
			return;
		}
		actionTicks--;
		if (actionTicks <= 0) {
			end(client);
			return;
		}
		switch (action) {
			case WALK -> walk(client, player);
			case FETCH -> fetch(client, player);
			case LOOK -> look(client, player);
			case DESCEND -> descend(client);
			default -> end(client);
		}
	}

	/** Drops any idle motion the moment real work arrives. */
	static void reset(Minecraft client) {
		if (action == Action.WALK || action == Action.FETCH) {
			GameActions.releaseWalkInput(client);
		}
		if (action == Action.DESCEND) GameActions.releaseMiningInput(client);
		quietTicks = 0;
		actionTicks = 0;
		holdTicks = 0;
		deferTicks = 0;
		action = Action.NONE;
		fetch = null;
		waypoints = List.of();
		waypointIndex = 0;
	}

	private static void choose(Minecraft client, LocalPlayer player) {
		// A completed look_at task deliberately retains its observation pose,
		// which used to make every idle LOOK end on its first tick. Idle time
		// is a new intent, so it owns the camera again. Release rather than
		// reset: a reset snaps the audience camera from the retained pose back
		// to the body's instantly-aimed rotation.
		if (CameraController.retained()) CameraController.release();
		long dayTime = client.level.getDayTime() % 24_000L;
		if (dayTime >= 13_000L && dayTime <= 23_000L) {
			/*
			 * Night idle time is not sightseeing. A respawned body strolled
			 * into a zombie and a skeleton's line while the goal runtime was
			 * backing off, then died before the next safety task. Stand still
			 * and let the safety card or the reflex own the next move.
			 */
			deferTicks = 20;
			return;
		}
		if (GameActions.onCanopy(client)) {
			action = Action.DESCEND;
			actionTicks = MAX_WALK_TICKS;
			CraftMateBodyClient.LOGGER.info("CraftMate idle action=descend");
			return;
		}
		List<EnderMan> endermen = nearbyEndermen(client, player);
		boolean packed = usedStorageSlots(player) >= PACKED_SLOTS;
		ItemEntity drop = nearestDrop(
			client,
			player,
			packed ? PACKED_FETCH_RADIUS : FETCH_RADIUS
		);
		if (
			drop != null
				&& endermen.isEmpty()
				&& player.onGround()
				&& safeRoute(client, player, drop.getX(), drop.getZ())
		) {
			fetch = drop;
			action = Action.FETCH;
			actionTicks = MAX_WALK_TICKS;
			CraftMateBodyClient.LOGGER.info("CraftMate idle action=fetch");
			return;
		}
		if (
			!packed &&
			player.onGround()
				&& RANDOM.nextFloat() < 0.65f
				&& chooseWalkGoal(client, player, endermen)
		) {
			action = Action.WALK;
			actionTicks = MIN_WALK_TICKS + RANDOM.nextInt(MAX_WALK_TICKS - MIN_WALK_TICKS);
			CraftMateBodyClient.LOGGER.info(
				"CraftMate idle action=walk goal={},{}",
				Math.round(goalX),
				Math.round(goalZ)
			);
			return;
		}
		if (!endermen.isEmpty()) {
			// No safe stroll and no random look: both can provoke it. The
			// coordinator's threat task remains free to retreat or fight.
			deferTicks = 20;
			return;
		}
		chooseLook(player);
	}

	/**
	 * Try headings in a shuffled compass order instead of committing to one
	 * Gaussian direction. That is enough local pathfinding to leave a mining
	 * pit without asking the coordinator for a route, and it refuses a stroll
	 * when every nearby line runs into a wall or a drop.
	 */
	private static boolean chooseWalkGoal(
		Minecraft client,
		LocalPlayer player,
		List<EnderMan> endermen
	) {
		BoundedPathfinder.Cell start = new BoundedPathfinder.Cell(
			player.blockPosition().getX(),
			player.blockPosition().getY(),
			player.blockPosition().getZ()
		);
		int offset = RANDOM.nextInt(WALK_DIRECTIONS);
		double minDistance = Math.max(MIN_LEG, 3.0);
		for (int attempt = 0; attempt < WALK_DIRECTIONS; attempt++) {
			int index = (offset + attempt) % WALK_DIRECTIONS;
			double angle = index * Math.PI * 2.0 / WALK_DIRECTIONS;
			double distance = minDistance + RANDOM.nextDouble() * (MAX_LEG - minDistance);
			int goalCellX = start.x() + (int) Math.round(-Math.sin(angle) * distance);
			int goalCellZ = start.z() + (int) Math.round(Math.cos(angle) * distance);
			BoundedPathfinder.Cell requested = new BoundedPathfinder.Cell(
				goalCellX,
				start.y(),
				goalCellZ
			);
			BoundedPathfinder.Result found = BoundedPathfinder.find(
				start,
				requested,
				cell ->
					Math.abs(cell.x() - requested.x()) <= 1
						&& Math.abs(cell.z() - requested.z()) <= 1
						&& Math.abs(cell.y() - requested.y()) <= 1,
				(x, y, z) -> GameActions.standableAt(client, new BlockPos(x, y, z)),
				GameActions.traversal(client),
				WALK_SEARCH_NODES,
				MAX_LEG + 1.5
			);
			if (found == null || found.path().size() < 2) continue;
			BoundedPathfinder.Cell end = found.path().get(found.path().size() - 1);
			if (Math.hypot(end.x() - start.x(), end.z() - start.z()) < 3.0) continue;
			if (pathExposesEnderman(player, found.path(), endermen)) continue;
			waypoints = new ArrayList<>(found.path());
			waypointIndex = 1;
			BoundedPathfinder.Cell goal = waypoints.get(waypoints.size() - 1);
			goalX = goal.x() + 0.5;
			goalZ = goal.z() + 0.5;
			return true;
		}
		return false;
	}

	/**
	 * A route is only idle-safe if every segment points outside the enderman's
	 * gaze cone. Looking at one while walking is just as provocative as a
	 * deliberate stare.
	 */
	private static boolean pathExposesEnderman(
		LocalPlayer player,
		List<BoundedPathfinder.Cell> path,
		List<EnderMan> endermen
	) {
		if (endermen.isEmpty()) return false;
		double fromX = player.getX();
		double fromZ = player.getZ();
		for (BoundedPathfinder.Cell cell : path) {
			double toX = cell.x() + 0.5;
			double toZ = cell.z() + 0.5;
			if (Math.hypot(toX - fromX, toZ - fromZ) > 0.01) {
				float heading = (float) Math.toDegrees(Math.atan2(-(toX - fromX), toZ - fromZ));
				if (unsafeEndermanGaze(player, heading, endermen)) return true;
			}
			fromX = toX;
			fromZ = toZ;
		}
		return false;
	}

	private static void chooseLook(LocalPlayer player) {
		lookYaw = player.getYRot() + (RANDOM.nextFloat() * 2.0f - 1.0f) * 150.0f;
		lookPitch = (RANDOM.nextFloat() * 2.0f - 1.0f) * 30.0f;
		action = Action.LOOK;
		actionTicks = MIN_LOOK_TICKS + RANDOM.nextInt(MAX_LOOK_TICKS - MIN_LOOK_TICKS);
		holdTicks = 8 + RANDOM.nextInt(14);
		CraftMateBodyClient.LOGGER.info(
			"CraftMate idle action=look yaw={} pitch={}",
			Math.round(lookYaw),
			Math.round(lookPitch)
		);
	}

	private static void walk(Minecraft client, LocalPlayer player) {
		if (
			waypoints.isEmpty()
				|| waypointIndex >= waypoints.size()
				|| player.fallDistance > 1.0
		) {
			end(client);
			return;
		}
		BoundedPathfinder.Cell waypoint = waypoints.get(waypointIndex);
		double waypointX = waypoint.x() + 0.5;
		double waypointZ = waypoint.z() + 0.5;
		double horizontal = Math.hypot(
			waypointX - player.getX(),
			waypointZ - player.getZ()
		);
		if (horizontal < 0.55 && Math.abs(waypoint.y() - player.getY()) < 1.25) {
			waypointIndex++;
			if (waypointIndex >= waypoints.size()) {
				end(client);
				return;
			}
			waypoint = waypoints.get(waypointIndex);
			waypointX = waypoint.x() + 0.5;
			waypointZ = waypoint.z() + 0.5;
		}
		float heading = (float) Math.toDegrees(
			Math.atan2(-(waypointX - player.getX()), waypointZ - player.getZ())
		);
		if (unsafeEndermanGaze(player, heading, nearbyEndermen(client, player))) {
			end(client);
			return;
		}
		boolean aligned = GameActions.turnTowards(player, heading);
		CameraController.steerHeading(
			player,
			player.getYRot(),
			CameraController.displayPitch(player)
		);
		if (!aligned) {
			GameActions.setWalkInput(client, false);
			return;
		}
		GameActions.setWalkInput(client, true);
		if (player.horizontalCollision) player.jumpFromGround();
	}

	private static void fetch(Minecraft client, LocalPlayer player) {
		if (!nearbyEndermen(client, player).isEmpty()) {
			end(client);
			return;
		}
		if (fetch == null || !fetch.isAlive() || fetch.isRemoved()) {
			end(client);
			return;
		}
		Vec3 position = fetch.position();
		if (player.distanceToSqr(position) < 1.4) {
			// Vanilla picks the item up on contact; the walk only has to put
			// the body on top of it.
			end(client);
			return;
		}
		float heading = (float) Math.toDegrees(
			Math.atan2(-(position.x - player.getX()), position.z - player.getZ())
		);
		boolean aligned = GameActions.turnTowards(player, heading);
		CameraController.steerHeading(
			player,
			player.getYRot(),
			CameraController.displayPitch(player)
		);
		boolean safe = safeAhead(client, player);
		GameActions.setWalkInput(client, aligned && safe);
		if (aligned && !safe) end(client);
		if (player.horizontalCollision && player.onGround()) player.jumpFromGround();
	}

	private static void look(Minecraft client, LocalPlayer player) {
		if (CameraController.retained()) {
			end(client);
			return;
		}
		if (!nearbyEndermen(client, player).isEmpty()) {
			end(client);
			return;
		}
		boolean bodySettled = GameActions.lookTowards(player, lookYaw, lookPitch);
		// The rendered camera follows the body through the same spring used
		// by walking. Without this call, an idle scan moved the real player
		// rotation and vanilla camera in lockstep, so the audience saw a
		// constant-speed head turn with no easing or per-frame cap.
		CameraController.steerHeading(
			player,
			player.getYRot(),
			player.getXRot()
		);
		if (bodySettled && CameraController.settled(2.5f)) {
			if (holdTicks-- <= 0) end(client);
			return;
		}
		GameActions.setWalkInput(client, false);
	}

	/**
	 * A body resting on a tree crown has no standable A* neighbour. Use the
	 * same controlled peel the mining tasks use, before choosing a random
	 * stroll that can never exist from this cell.
	 */
	private static void descend(Minecraft client) {
		if (!GameActions.descendCanopyStep(client)) end(client);
	}

	private static void end(Minecraft client) {
		GameActions.releaseWalkInput(client);
		action = Action.NONE;
		actionTicks = 0;
		holdTicks = 0;
		fetch = null;
		// Idle work is not a command; keep a small pause between episodes so
		// the body does not pace like a pendulum.
		quietTicks = QUIET_TICKS - 12;
	}

	/**
	 * The body is allowed to wander, not to walk off a cliff or into lava.
	 * One cell ahead is enough at walking speed, and the check is cheap.
	 */
	private static boolean safeAhead(Minecraft client, LocalPlayer player) {
		double radians = Math.toRadians(player.getYRot());
		double x = player.getX() - Math.sin(radians) * 0.7;
		double z = player.getZ() + Math.cos(radians) * 0.7;
		return standable(client, x, player.getY(), z);
	}

	/**
	 * A same-level route is conservative on purpose: idle walking must not
	 * turn into a fall or an accidental swim. Real navigation tasks still use
	 * the bounded A* pathfinder and may take safe steps up or down.
	 */
	private static boolean safeRoute(
		Minecraft client,
		LocalPlayer player,
		double targetX,
		double targetZ
	) {
		double dx = targetX - player.getX();
		double dz = targetZ - player.getZ();
		double distance = Math.hypot(dx, dz);
		if (distance < 0.01) return true;
		int samples = Math.max(1, (int) Math.ceil(distance / 0.45));
		for (int sample = 1; sample <= samples; sample++) {
			double progress = (double) sample / samples;
			if (
				!standable(
					client,
					player.getX() + dx * progress,
					player.getY(),
					player.getZ() + dz * progress
				)
			) {
				return false;
			}
		}
		return true;
	}

	private static boolean standable(
		Minecraft client,
		double x,
		double y,
		double z
	) {
		BlockPos feet = BlockPos.containing(x, y + 0.05, z);
		BlockState floor = client.level.getBlockState(feet.below());
		if (
			!floor.blocksMotion()
				|| floor.is(net.minecraft.tags.BlockTags.LEAVES)
				|| floor.getFluidState().is(FluidTags.LAVA)
		) {
			return false;
		}
		for (int dy = 0; dy <= 1; dy++) {
			BlockState body = client.level.getBlockState(feet.above(dy));
			if (body.blocksMotion() || !body.getFluidState().isEmpty()) return false;
		}
		return true;
	}

	private static int usedStorageSlots(LocalPlayer player) {
		Inventory inventory = player.getInventory();
		int used = 0;
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			if (!inventory.getItem(slot).isEmpty()) used++;
		}
		return used;
	}

	private static ItemEntity nearestDrop(
		Minecraft client,
		LocalPlayer player,
		double radius
	) {
		List<ItemEntity> drops = client.level.getEntitiesOfClass(
			ItemEntity.class,
			player.getBoundingBox().inflate(radius),
			entity -> entity.isAlive() && !entity.isRemoved()
		);
		return drops
			.stream()
			.min((left, right) -> Double.compare(left.distanceToSqr(player), right.distanceToSqr(player)))
			.orElse(null);
	}

	private static List<EnderMan> nearbyEndermen(Minecraft client, LocalPlayer player) {
		return client.level.getEntitiesOfClass(
			EnderMan.class,
			player.getBoundingBox().inflate(ENDERMAN_RADIUS),
			EnderMan::isAlive
		);
	}

	private static boolean unsafeEndermanGaze(
		LocalPlayer player,
		float heading,
		List<EnderMan> endermen
	) {
		for (EnderMan enderman : endermen) {
			double dx = enderman.getX() - player.getX();
			double dz = enderman.getZ() - player.getZ();
			if (Math.hypot(dx, dz) > ENDERMAN_RADIUS) continue;
			float bearing = (float) Math.toDegrees(Math.atan2(-dx, dz));
			if (Math.abs(ViewSlew.wrap(bearing - heading)) <= ENDERMAN_GAZE_CONE) {
				return true;
			}
		}
		return false;
	}
}
