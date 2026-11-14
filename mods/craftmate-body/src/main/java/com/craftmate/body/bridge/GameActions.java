package com.craftmate.body.bridge;

import com.craftmate.body.CraftMateBodyClient;
import com.mojang.blaze3d.platform.InputConstants;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.loader.api.FabricLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.regex.Pattern;
import net.minecraft.client.Minecraft;
import net.minecraft.client.KeyMapping;
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
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.EnderMan;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.StackedContents;
import net.minecraft.world.item.BedItem;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.AbstractFurnaceMenu;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.inventory.RecipeBookMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.crafting.CraftingRecipe;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.item.crafting.Recipe;
import net.minecraft.world.item.crafting.RecipeManager;
import net.minecraft.world.item.crafting.ShapedRecipe;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.entity.BaseContainerBlockEntity;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.AABB;
import org.lwjgl.glfw.GLFW;

/**
 * Commands are state machines advanced by the client thread. A task remains
 * accepted/running until the world shows observable progress or it fails.
 */
public final class GameActions {
	private static final List<String> SKILLS = List.of(
		"goto", "look_at", "mine_block", "chop_tree", "collect_items", "craft", "deposit", "say", "wait", "attack",
		"equip", "eat", "use_block", "place_block", "pillar_up", "smelt", "sleep"
	);
	private static final List<String> CAPABILITIES = List.of(
		"sensor", "move", "mine", "container", "attack", "use", "build", "camera", "hud"
	);
	private static final int MINE_SITE_RADIUS = 10;
	/**
	 * A branch tunnel only makes sense once the staircase is below the dirt
	 * layer. Cutting one while the body still stands under a tree canopy
	 * selected leaves as the next "ore" cell and produced a useless tunnel.
	 */
	private static final int MIN_BRANCH_DEPTH = 4;
	private static final Direction[] MINE_HORIZONTAL = {
		Direction.NORTH,
		Direction.EAST,
		Direction.SOUTH,
		Direction.WEST,
	};
	/**
	 * Trunks and leaves can hide a nearby log from a single eye ray. Keep the
	 * visible search local, but let the approach loop walk to a log that is
	 * inside the normal gameplay area. The destroy loop still requires an
	 * unobstructed face before it starts breaking, so this cannot mine through
	 * terrain.
	 */
	private static final int TARGET_SEARCH_RADIUS = 48;
	/**
	 * The count-only cube below answers "what am I standing in", not "what can
	 * I see". A tree twenty blocks across a lake was visible to the player but
	 * absent from the planner's world, so the model kept choosing a random
	 * search direction. This survey samples loaded surface columns within the
	 * same radius the chop skill can reach, keeps only line-of-sight wood, and
	 * refreshes at a bounded cadence instead of scanning every heartbeat.
	 */
	/**
	 * Match the normal eight-chunk render distance closely enough that a tree
	 * visible on screen is also visible to the planner. The interaction skill
	 * still has a shorter reach; a distant target is an approach cue, not a
	 * claim that the body can chop it from here. 56 keeps a useful approach
	 * ring while the per-tick budget can finish a full survey in under 1.5s.
	 */
	private static final int VISUAL_WOOD_RADIUS = 56;
	private static final int VISUAL_SCAN_INTERVAL_TICKS = 30;
	private static final int VISUAL_COLUMN_DEPTH = 12;
	private static final int VISUAL_TARGET_LIMIT = 12;
	private static final int VISUAL_RESCAN_DISTANCE_SQR = 8 * 8;
	/**
	 * Tree canopies are several blocks wide, so a phased grid is enough to
	 * find them without paying a heightmap lookup for every column out to 96
	 * blocks. Near columns stay dense; farther rings rotate their sampling
	 * phase so successive scans cover the gaps.
	 */
	private static final int VISUAL_DENSE_RADIUS = 24;
	private static final int VISUAL_MID_RADIUS = 44;
	private static final int VISUAL_RAYCAST_LIMIT = 40;
	/**
	 * Per-tick budget for the surface survey. The old one-shot scan blocked
	 * the render thread for 20-40ms every 1.5s, which showed up as periodic
	 * WASD stutter. A survey is allowed to span a few ticks while the last
	 * complete result stays available.
	 */
	private static final long VISUAL_SCAN_BUDGET_NANOS = 6_000_000L;
	/** Bounded rows per tick; the time budget is checked between rows. */
	private static final int VISUAL_SCAN_ROWS_PER_TICK = 4;
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
	/**
	 * A body can walk away from the station it built, and a client restart
	 * clears process memory. Recover the station from the loaded world so a
	 * real table is not reported as missing merely because it is outside the
	 * small nearby-block observation cube.
	 */
	private static final int STATION_RECOVERY_RADIUS = 32;
	/** Recover a camp chest even when the body is deep in a nearby shaft. */
	private static final int HOME_RECOVERY_RADIUS = 64;
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
	private static int staleMenuSince = -1;
	private static Reflexes reflexes;
	private static volatile boolean miningInputHeld;
	/** The canopy cell currently being peeled by the shared escape helper. */
	private static BlockPos canopyMining;
	private static volatile boolean agentInputAllowed;
	private static final RespawnRetry RESPAWN_RETRY = new RespawnRetry();
	/**
	 * Death ends the current life's work but not the goal. Preempt in-flight
	 * skills once so they cannot keep mining or walking with stale coordinates
	 * after the respawn; the planner observes the new body and chooses again.
	 */
	private static boolean deathPreempted;
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
	/** Server-confirmed ender dragon death for this world session. */
	private static volatile boolean dragonDefeated;
	private static LocalPlayer observedPlayer;
	/** True once this session crafted a crafting table. */
	private static volatile boolean craftingTableCrafted;
	/** True once this session placed a crafting table in the world. */
	private static volatile boolean craftingTablePlaced;
	/** Session facts for the home camp. */
	private static volatile boolean chestCrafted;
	private static volatile boolean chestPlaced;
	private static volatile boolean bedPlaced;
	private static volatile boolean shelterBuilt;
	private static volatile BlockPos placedShelter;
	/** Chosen hut footprint is stable across planner retries. */
	private static volatile BlockPos plannedHutSite;
	/** Foundation cells chosen with the site, so a reload cannot move the house. */
	private static volatile List<BlockPos> plannedHutFoundation = List.of();
	/** Cached footprint scan; selecting a 5x5 site is too costly per tick. */
	private static volatile HutSite cachedHutSite;
	private static int cachedHutSiteTick = Integer.MIN_VALUE;
	private static BlockPos cachedHutSiteAnchor;
	/** Surface entrance of the reusable main mine staircase. */
	private static volatile BlockPos mineEntrance;
	private static volatile Direction mineDirection;
	/** Bounded entrance search runs at most twice a second, not every tick. */
	private static int nextMineEntranceSearchTick = Integer.MIN_VALUE;
	/** A remembered surface entrance that cannot produce a first step is stale. */
	private static int minePlanFailures;
	/** Latest visible-wood survey. The render thread owns the mutable cache. */
	private static List<VisibleWood> visibleWood = List.of();
	private static int visibleWoodScanTick = Integer.MIN_VALUE;
	private static BlockPos visibleWoodOrigin;
	private static String visibleWoodSignature;
	private static int visibleWoodColumns;
	private static int visibleWoodCandidates;
	/** In-progress incremental survey; null when no scan is running. */
	private static VisibleWoodScan visibleWoodScan;
	/** Local block counts change slowly; rebuilding the map every tick is waste. */
	private static List<NearbyCount> nearbyCounts = List.of();
	private static int nearbyCountsTick = Integer.MIN_VALUE;
	private static BlockPos nearbyCountsOrigin;
	/**
	 * Ores with a real visible face from the current cell. The count-only
	 * nearby summary is enough to know a block type exists, but the planner
	 * needs a location before it can choose a direct {@code mine_block}
	 * instead of digging a speculative branch tunnel.
	 */
	private static List<OreTarget> visibleOres = List.of();
	/**
	 * Nearest ores in the local survey, including those behind a wall. The
	 * count-only summary says "there is iron nearby" but gives the planner no
	 * direction; these entries let it choose the vein instead of a random
	 * branch tunnel. Only the visible subset is marked as a line-of-sight
	 * target.
	 */
	private static List<OreTarget> localOres = List.of();
	/**
	 * Mutable state for one surface survey. Minecraft world reads stay on the
	 * client thread; only the amount of work per tick is bounded.
	 */
	private static final class VisibleWoodScan {
		final BlockPos origin;
		final int startedTick;
		final int scanOrdinal;
		final int minY;
		final int maxY;
		final long startedAt = System.nanoTime();
		final int radiusSqr = VISUAL_WOOD_RADIUS * VISUAL_WOOD_RADIUS;
		final int denseRadiusSqr = VISUAL_DENSE_RADIUS * VISUAL_DENSE_RADIUS;
		final int midRadiusSqr = VISUAL_MID_RADIUS * VISUAL_MID_RADIUS;
		final List<WoodCandidate> candidates = new ArrayList<>();
		final BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
		int nextDx = -VISUAL_WOOD_RADIUS;
		int columns;

		VisibleWoodScan(
			BlockPos origin,
			int startedTick,
			int scanOrdinal,
			int minY,
			int maxY
		) {
			this.origin = origin;
			this.startedTick = startedTick;
			this.scanOrdinal = scanOrdinal;
			this.minY = minY;
			this.maxY = maxY;
		}
	}
	private record WoodCandidate(
		String id,
		BlockPos top,
		BlockPos canopy,
		double distance
	) {
	}
	private record NearbyCount(String id, int count) {
	}

	private record OreTarget(String id, int x, int y, int z, double distance) {
	}
	/**
	 * The last crafting table this body placed. A table is a durable world
	 * station, but the snapshot only observes a 17-block cube. Remembering the
	 * exact position lets a later craft walk back to it instead of declaring
	 * that the table no longer exists.
	 */
	private static volatile BlockPos placedCraftingTable;
	/** The first chest and bed placed this session; they anchor the camp. */
	private static volatile BlockPos placedChest;
	private static volatile BlockPos placedBed;
	/**
	 * Client-side chest block entities do not expose their contents until a
	 * menu has been opened. Remember the last capacity actually seen in a
	 * container menu; treating the unsynced block entity as empty made a full
	 * chest report 27 free slots and looped the planner back to deposit.
	 */
	private static volatile BlockPos observedChest;
	private static volatile int observedChestEmptySlots = -1;
	/** Last furnace this body placed; a smelt can walk back to it. */
	private static volatile BlockPos placedFurnace;
	/**
	 * The last block placed by the cave-pillar escape. Persist it across a
	 * client restart so a controller retry cannot strand the body on top of
	 * its own pillar after the in-memory state was lost.
	 */
	private static volatile BlockPos lastEscapePillar;
	/**
	 * Every block the pillar escape placed, oldest first. A single retry used
	 * to remove only the top block and then forget the column underneath,
	 * leaving the body perched one block lower with the same impossible route.
	 */
	private static volatile List<BlockPos> escapePillarColumn = List.of();
	private static final Path HOME_MEMORY_FILE = homeMemoryFile();
	private static final Gson HOME_MEMORY_GSON = new Gson();
	/**
	 * Durable anchors belong to one save. Without this key a brand new world
	 * inherited the previous run's camp and reported "crafting table placed"
	 * with no table in the inventory, so every survival milestone looked
	 * complete and the planner had no task to execute.
	 */
	private static String homeMemoryWorld;
	/** Throttle the recovery scan; the observation path runs every tick. */
	private static int nextStationRecoveryTick;
	private static int nextFurnaceRecoveryTick;
	private static int nextHomeRecoveryTick;
	private static int nextHutStepLogTick = Integer.MIN_VALUE;

	static {
		loadHomeMemory();
	}

	/**
	 * Unit tests load GameActions without a running Fabric game. Resolve the
	 * real game config directory at runtime, then fall back to a writable
	 * project-relative path instead of failing the whole class initializer.
	 */
	private static Path homeMemoryFile() {
		try {
			FabricLoader loader = FabricLoader.getInstance();
			if (loader != null) {
				return loader.getConfigDir().resolve("craftmate-body-home.json");
			}
		} catch (Throwable ignored) {
			// No Fabric runtime in a plain unit-test JVM.
		}
		return Path.of(
			System.getProperty("user.dir", "."),
			"config",
			"craftmate-body-home.json"
		);
	}

	private GameActions() {
	}

	private static void loadHomeMemory() {
		if (!Files.isRegularFile(HOME_MEMORY_FILE)) return;
		try {
			JsonObject saved = JsonParser.parseString(
				Files.readString(HOME_MEMORY_FILE, StandardCharsets.UTF_8)
			).getAsJsonObject();
			placedChest = readHomePosition(saved, "chest");
			placedBed = readHomePosition(saved, "bed");
			observedChest = readHomePosition(saved, "observedChest");
			if (saved.has("observedChestEmptySlots")) {
				observedChestEmptySlots = saved.get("observedChestEmptySlots").getAsInt();
			}
			placedFurnace = readHomePosition(saved, "furnace");
			placedCraftingTable = readHomePosition(saved, "craftingTable");
			placedShelter = readHomePosition(saved, "shelter");
			plannedHutSite = readHomePosition(saved, "plannedHutSite");
			plannedHutFoundation = readHomePositions(saved, "plannedHutFoundation");
			mineEntrance = readHomePosition(saved, "mineEntrance");
			lastEscapePillar = readHomePosition(saved, "lastEscapePillar");
			escapePillarColumn = readHomePositions(saved, "escapePillarColumn");
			homeMemoryWorld = saved.has("world")
				? saved.get("world").getAsString()
				: null;
			chestCrafted = saved.has("chestCrafted") && saved.get("chestCrafted").getAsBoolean();
			chestPlaced = placedChest != null;
			shelterBuilt = placedShelter != null;
			mineDirection = saved.has("mineDirection")
				? Direction.byName(saved.get("mineDirection").getAsString())
				: null;
			bedPlaced = placedBed != null;
			craftingTableCrafted =
				saved.has("craftingTableCrafted")
				&& saved.get("craftingTableCrafted").getAsBoolean();
			craftingTablePlaced = placedCraftingTable != null;
		} catch (Exception error) {
			CraftMateBodyClient.LOGGER.warn(
				"CraftMate could not load home memory: {}",
				error.getMessage()
			);
		}
	}

	private static BlockPos readHomePosition(JsonObject saved, String name) {
		if (!saved.has(name) || !saved.get(name).isJsonObject()) return null;
		JsonObject position = saved.getAsJsonObject(name);
		if (!position.has("x") || !position.has("y") || !position.has("z")) return null;
		return new BlockPos(
			position.get("x").getAsInt(),
			position.get("y").getAsInt(),
			position.get("z").getAsInt()
		);
	}

	private static void saveHomeMemory() {
		JsonObject saved = new JsonObject();
		if (homeMemoryWorld != null) saved.addProperty("world", homeMemoryWorld);
		writeHomePosition(saved, "chest", placedChest);
		writeHomePosition(saved, "bed", placedBed);
		writeHomePosition(saved, "observedChest", observedChest);
		if (observedChestEmptySlots >= 0) {
			saved.addProperty("observedChestEmptySlots", observedChestEmptySlots);
		}
		writeHomePosition(saved, "furnace", placedFurnace);
		writeHomePosition(saved, "craftingTable", placedCraftingTable);
		writeHomePosition(saved, "shelter", placedShelter);
		writeHomePosition(saved, "plannedHutSite", plannedHutSite);
		writeHomePositions(saved, "plannedHutFoundation", plannedHutFoundation);
		writeHomePosition(saved, "mineEntrance", mineEntrance);
		writeHomePosition(saved, "lastEscapePillar", lastEscapePillar);
		writeHomePositions(saved, "escapePillarColumn", escapePillarColumn);
		saved.addProperty("chestCrafted", chestCrafted);
		saved.addProperty("craftingTableCrafted", craftingTableCrafted);
		saved.addProperty("shelterBuilt", shelterBuilt);
		if (mineDirection != null) {
			saved.addProperty("mineDirection", mineDirection.getName());
		}
		try {
			Files.createDirectories(HOME_MEMORY_FILE.getParent());
			Files.writeString(
				HOME_MEMORY_FILE,
				HOME_MEMORY_GSON.toJson(saved),
				StandardCharsets.UTF_8
			);
		} catch (Exception error) {
			CraftMateBodyClient.LOGGER.warn(
				"CraftMate could not save home memory: {}",
				error.getMessage()
			);
		}
	}

	private static void writeHomePosition(JsonObject saved, String name, BlockPos position) {
		if (position == null) return;
		JsonObject value = new JsonObject();
		value.addProperty("x", position.getX());
		value.addProperty("y", position.getY());
		value.addProperty("z", position.getZ());
		saved.add(name, value);
	}

	private static List<BlockPos> readHomePositions(JsonObject saved, String name) {
		if (!saved.has(name) || !saved.get(name).isJsonArray()) return List.of();
		List<BlockPos> positions = new ArrayList<>();
		for (var entry : saved.getAsJsonArray(name)) {
			if (!entry.isJsonObject()) continue;
			JsonObject value = entry.getAsJsonObject();
			if (!value.has("x") || !value.has("y") || !value.has("z")) continue;
			positions.add(
				new BlockPos(
					value.get("x").getAsInt(),
					value.get("y").getAsInt(),
					value.get("z").getAsInt()
				)
			);
		}
		return List.copyOf(positions);
	}

	private static void writeHomePositions(
		JsonObject saved,
		String name,
		List<BlockPos> positions
	) {
		if (positions.isEmpty()) return;
		JsonArray values = new JsonArray();
		for (BlockPos position : positions) {
			JsonObject value = new JsonObject();
			value.addProperty("x", position.getX());
			value.addProperty("y", position.getY());
			value.addProperty("z", position.getZ());
			values.add(value);
		}
		saved.add(name, values);
	}

	private static void rememberEscapePillar(BlockPos position) {
		List<BlockPos> next = new ArrayList<>(escapePillarColumn);
		next.remove(position);
		next.add(position.immutable());
		while (next.size() > 64) next.remove(0);
		escapePillarColumn = List.copyOf(next);
	}

	/** Stable identity of the save the body is currently playing in. */
	private static String currentWorldKey(Minecraft client) {
		MinecraftServer server = client.getSingleplayerServer();
		if (server != null) {
			try {
				return "singleplayer:" + server.getWorldData().getLevelName();
			} catch (Throwable ignored) {
				// Server still starting; try again on the next snapshot.
			}
		}
		var remote = client.getCurrentServer();
		if (remote != null) return "server:" + remote.ip;
		return null;
	}

	/**
	 * Drops durable camp/tool facts when the save changes. Switching worlds
	 * must be a fresh survival run, not a continuation of the old shelter or
	 * an "already placed" crafting table whose coordinates now point at
	 * unrelated terrain.
	 */
	static void syncWorld(Minecraft client) {
		String world = currentWorldKey(client);
		if (world == null) return;
		if (homeMemoryWorld == null) {
			homeMemoryWorld = world;
			saveHomeMemory();
			return;
		}
		if (homeMemoryWorld.equals(world)) return;
		homeMemoryWorld = world;
		clearHomeMemory();
		saveHomeMemory();
		CraftMateBodyClient.LOGGER.info(
			"CraftMate reset home memory for world {}",
			world
		);
	}

	private static void clearHomeMemory() {
		placedChest = null;
		placedBed = null;
		observedChest = null;
		observedChestEmptySlots = -1;
		placedFurnace = null;
		placedCraftingTable = null;
		placedShelter = null;
		plannedHutSite = null;
		plannedHutFoundation = List.of();
		mineEntrance = null;
		mineDirection = null;
		lastEscapePillar = null;
		escapePillarColumn = List.of();
		chestCrafted = false;
		chestPlaced = false;
		shelterBuilt = false;
		bedPlaced = false;
		craftingTableCrafted = false;
		craftingTablePlaced = false;
		cachedHutSite = null;
		cachedHutSiteTick = Integer.MIN_VALUE;
		cachedHutSiteAnchor = null;
		minePlanFailures = 0;
		nextStationRecoveryTick = 0;
		nextFurnaceRecoveryTick = 0;
		nextHomeRecoveryTick = 0;
		nextMineEntranceSearchTick = Integer.MIN_VALUE;
		foodAcquired = false;
		foodConsumed = false;
		sleptThroughNight = false;
		dragonDefeated = false;
		visibleWood = List.of();
		visibleWoodScanTick = Integer.MIN_VALUE;
		visibleWoodOrigin = null;
		visibleWoodSignature = null;
		visibleWoodColumns = 0;
		visibleWoodCandidates = 0;
		visibleWoodScan = null;
		nearbyCounts = List.of();
		nearbyCountsTick = Integer.MIN_VALUE;
		nearbyCountsOrigin = null;
		visibleOres = List.of();
		localOres = List.of();
	}

	private record VisibleWood(
		String id,
		int x,
		int y,
		int z
	) {
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

	/** Records the one terminal fact the planner cannot infer from absence. */
	public static void noteDragonDefeated() {
		dragonDefeated = true;
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
			dragonDefeated = false;
			observedPlayer = null;
			sleptThroughNight = false;
			// Durable camp anchors and the "this body built one" facts are
			// persisted home memory, not session consumables. Clearing them
			// while the title screen was loading made the next snapshot recover
			// whichever chest happened to be nearest and move the camp.
			visibleWood = List.of();
			visibleWoodSignature = null;
			visibleWoodOrigin = null;
			nearbyCounts = List.of();
			nearbyCountsOrigin = null;
			visibleOres = List.of();
			localOres = List.of();
			return world;
		}
		syncWorld(client);
		// A respawn creates a fresh life. Keeping the old meal bits made the
		// planner believe the food stage was satisfied forever and skip
		// hunting after every death, even when keepInventory retained items.
		if (SessionFacts.resetConsumables(player.isAlive(), observedPlayer == player)) {
			foodAcquired = false;
			foodConsumed = false;
		}
		observedPlayer = player;
		world.addProperty("world", client.level.dimension().location().toString());
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
		world.addProperty("dragonDefeated", dragonDefeated);
		world.addProperty("craftingTableCrafted", craftingTableCrafted);
		world.addProperty("craftingTablePlaced", craftingTablePlaced);
		world.addProperty("chestCrafted", chestCrafted);
		world.addProperty("chestPlaced", chestPlaced);
		world.addProperty("bedPlaced", bedPlaced);
		world.addProperty("shelterBuilt", shelterBuilt);
		world.addProperty("furnacePlaced", placedFurnace != null);
		if (
			(placedChest == null || placedBed == null || placedCraftingTable == null) &&
			tick(client) >= nextHomeRecoveryTick
		) {
			nextHomeRecoveryTick = tick(client) + 20 * 5;
			if (placedChest == null) {
				BlockPos recoveredChest = loadedChestPosition(
					client,
					player,
					HOME_RECOVERY_RADIUS
				);
				if (recoveredChest != null) {
					placedChest = recoveredChest;
					chestPlaced = true;
					saveHomeMemory();
				}
			}
			if (placedBed == null) {
				BlockPos recoveredBed = nearbyBedPosition(
					client,
					player,
					STATION_RECOVERY_RADIUS
				);
				if (recoveredBed != null) {
					placedBed = recoveredBed;
					bedPlaced = true;
					saveHomeMemory();
				}
			}
		}
		if (
			placedChest != null &&
			StationMemory.shouldForgetNearby(
				player.blockPosition().distSqr(placedChest),
				client.level.hasChunkAt(placedChest),
				client.level.getBlockState(placedChest).is(Blocks.CHEST) ||
					client.level.getBlockState(placedChest).is(Blocks.TRAPPED_CHEST)
			)
		) {
			placedChest = null;
			chestPlaced = false;
			saveHomeMemory();
		}
		if (
			placedBed != null &&
			StationMemory.shouldForgetNearby(
				player.blockPosition().distSqr(placedBed),
				client.level.hasChunkAt(placedBed),
				client.level.getBlockState(placedBed).getBlock() instanceof BedBlock
			)
		) {
			placedBed = null;
			bedPlaced = false;
			saveHomeMemory();
		}
		if (placedChest != null) {
			JsonObject chest = new JsonObject();
			chest.addProperty("x", placedChest.getX());
			chest.addProperty("y", placedChest.getY());
			chest.addProperty("z", placedChest.getZ());
			world.add("chest", chest);
			if (
				observedChest != null &&
				observedChestEmptySlots >= 0 &&
				sameChestCluster(placedChest, observedChest)
			) {
				world.addProperty("chestEmptySlots", observedChestEmptySlots);
			}
		}
		if (placedShelter != null) {
			JsonObject shelter = new JsonObject();
			shelter.addProperty("x", placedShelter.getX());
			shelter.addProperty("y", placedShelter.getY());
			shelter.addProperty("z", placedShelter.getZ());
			world.add("shelter", shelter);
		}
		if (mineEntrance != null) {
			JsonObject mine = new JsonObject();
			mine.addProperty("x", mineEntrance.getX());
			mine.addProperty("y", mineEntrance.getY());
			mine.addProperty("z", mineEntrance.getZ());
			world.add("mineEntrance", mine);
		}
		addHutSnapshot(world, client, player);
		addMineSnapshot(world, client, player);
		if (placedBed != null) {
			JsonObject bed = new JsonObject();
			bed.addProperty("x", placedBed.getX());
			bed.addProperty("y", placedBed.getY());
			bed.addProperty("z", placedBed.getZ());
			world.add("bed", bed);
			// A bed two blocks below the rim is still usable when its face is
			// inside interaction reach. The planner used to order a
			// walk to the bed floor first, and an invalid floor candidate made
			// it circle the same pit until morning.
			world.addProperty("bedInReach", bedInReach(client, player, placedBed));
		}
		if (
			placedFurnace != null &&
			StationMemory.shouldForgetNearby(
				player.blockPosition().distSqr(placedFurnace),
				client.level.hasChunkAt(placedFurnace),
				client.level.getBlockState(placedFurnace).is(Blocks.FURNACE)
			)
		) {
			placedFurnace = null;
			saveHomeMemory();
		}
		if (placedFurnace == null && tick(client) >= nextFurnaceRecoveryTick) {
			nextFurnaceRecoveryTick = tick(client) + 20 * 5;
			BlockPos recovered = nearbyBlockPosition(client, player, Blocks.FURNACE, STATION_RECOVERY_RADIUS);
			if (recovered != null) {
				placedFurnace = recovered;
				saveHomeMemory();
			}
		}
		if (placedFurnace != null) {
			JsonObject furnace = new JsonObject();
			furnace.addProperty("x", placedFurnace.getX());
			furnace.addProperty("y", placedFurnace.getY());
			furnace.addProperty("z", placedFurnace.getZ());
			world.add("furnace", furnace);
		}
		if (placedCraftingTable == null && tick(client) >= nextStationRecoveryTick) {
			nextStationRecoveryTick = tick(client) + 20 * 5;
			BlockPos recovered = nearbyBlockPosition(client, player, Blocks.CRAFTING_TABLE, STATION_RECOVERY_RADIUS);
			if (recovered != null) {
				placedCraftingTable = recovered;
				craftingTablePlaced = true;
				saveHomeMemory();
			}
		} else if (placedCraftingTable != null
			&& StationMemory.shouldForgetNearby(
				player.blockPosition().distSqr(placedCraftingTable),
				client.level.hasChunkAt(placedCraftingTable),
				client.level.getBlockState(placedCraftingTable).is(Blocks.CRAFTING_TABLE)
			)) {
			// The remembered block was broken or replaced. Keep the fact that
			// this run built a table, but do not claim a station that is gone.
			placedCraftingTable = null;
			saveHomeMemory();
		}
		boolean craftingTableNearby =
			(placedCraftingTable != null
				&& client.level.getBlockState(placedCraftingTable).is(Blocks.CRAFTING_TABLE)
				&& player.distanceToSqr(Vec3.atCenterOf(placedCraftingTable)) <= 8.0 * 8.0)
				|| nearbyBlocksContain(client, player, Blocks.CRAFTING_TABLE);
		world.addProperty(
			"craftingTableNearby",
			craftingTableNearby
		);
		BlockPos reachableTable = placedCraftingTable != null
			&& client.level.getBlockState(placedCraftingTable).is(Blocks.CRAFTING_TABLE)
			? placedCraftingTable
			: nearbyBlockPosition(client, player, Blocks.CRAFTING_TABLE, STATION_RECOVERY_RADIUS);
		world.addProperty(
			"craftingTableReachable",
			reachableTable != null
				&& stationReachable(player, reachableTable)
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
		BlockPos bodyPos = player.blockPosition();
		world.addProperty(
			"surfaceY",
			client.level.getHeight(Heightmap.Types.WORLD_SURFACE, bodyPos.getX(), bodyPos.getZ())
		);
		world.addProperty("canSeeSky", client.level.canSeeSky(bodyPos));
		world.addProperty(
			"inWater",
			player.isInWater() || player.isEyeInFluid(FluidTags.WATER)
		);
		/*
		 * A one-block emergency shaft is a real shelter even though the
		 * heightmap at its floor says "surface". The planner needs the wall
		 * count and the surrounding ground height so it can dig two more
		 * blocks and cap the opening above its head instead of waiting in the
		 * open or treating the shaft as a normal surface cell.
		 */
		int shaftWalls = 0;
		int shaftTopY = bodyPos.getY();
		for (Direction direction : Direction.Plane.HORIZONTAL) {
			BlockPos side = bodyPos.relative(direction);
			if (client.level.getBlockState(side).blocksMotion()) shaftWalls++;
			shaftTopY = Math.max(
				shaftTopY,
				client.level.getHeight(Heightmap.Types.WORLD_SURFACE, side.getX(), side.getZ())
			);
		}
		int shaftDepth = Math.max(0, shaftTopY - bodyPos.getY());
		boolean shaftEnclosed = shaftIsEnclosed(
			shaftWalls,
			shaftDepth,
			!client.level.getBlockState(bodyPos.above(2)).blocksMotion(),
			client.level.getBlockState(bodyPos.above(3)).blocksMotion()
		);
		world.addProperty("shaftWalls", shaftWalls);
		world.addProperty("shaftTopY", shaftTopY);
		world.addProperty("shaftDepth", shaftDepth);
		world.addProperty("enclosed", shaftEnclosed);
		world.addProperty(
			"lightLevel",
			client.level.getMaxLocalRawBrightness(bodyPos)
		);
		long dayTime = client.level.getDayTime();
		world.addProperty("timeOfDay", (int) Math.floorMod(dayTime, 24_000L));
		world.addProperty("day", (int) Math.floorDiv(dayTime, 24_000L));
		world.addProperty("sleeping", player.isSleeping());
		world.addProperty("sleptThroughNight", sleptThroughNight);
		world.addProperty("screenOpen", client.screen != null);
		world.addProperty(
			"screen",
			client.screen == null ? null : client.screen.getClass().getSimpleName()
		);
		SupportBlock support = supportBlock(client, player);
		BlockState floor = support.state();
		world.addProperty(
			"floor",
			floor.isAir() ? null : BuiltInRegistries.BLOCK.getKey(floor.getBlock()).toString()
		);
		if (!floor.isAir()) {
			JsonObject floorPosition = new JsonObject();
			floorPosition.addProperty("x", support.pos().getX());
			floorPosition.addProperty("y", support.pos().getY());
			floorPosition.addProperty("z", support.pos().getZ());
			world.add("floorPos", floorPosition);
		}
		BlockPos spawn = client.level.getSharedSpawnPos();
		JsonObject spawnPoint = new JsonObject();
		spawnPoint.addProperty("x", spawn.getX() + 0.5);
		spawnPoint.addProperty("y", spawn.getY());
		spawnPoint.addProperty("z", spawn.getZ() + 0.5);
		world.add("spawn", spawnPoint);
		ItemStack selected = player.getInventory().getSelected();
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
				entry.addProperty("x", round(entity.getX()));
				entry.addProperty("y", round(entity.getY()));
				entry.addProperty("z", round(entity.getZ()));
				entities.add(entry);
			});
		world.add("entities", entities);
		world.add("nearbyBlocks", nearbyBlocks(client, player));
		world.add("reachableBlock", reachableBlock(client, player));
		return world;
	}

	/**
	 * The house is data, not a script. The snapshot names the next blueprint
	 * cell and the interior cell the body must stand on; the planner then
	 * issues an ordinary `goto` plus one `place_block`. Re-running the whole
	 * schematic after a single unreachable cell was the visible build loop.
	 */
	private static void addHutSnapshot(
		JsonObject world,
		Minecraft client,
		LocalPlayer player
	) {
		if (shelterBuilt) return;
		BlockPos anchor =
			placedChest != null
				? placedChest
				: placedBed != null
					? placedBed
					: player.blockPosition();
		int now = tick(client);
		HutSite site = cachedHutSite;
		if (
			site == null ||
			now - cachedHutSiteTick >= 100 ||
			cachedHutSiteAnchor == null ||
			!cachedHutSiteAnchor.equals(anchor)
		) {
			site = PlaceTask.chooseHutSite(client, anchor);
			cachedHutSite = site;
			cachedHutSiteTick = now;
			cachedHutSiteAnchor = anchor.immutable();
		}
		if (site == null) return;
		List<BlockPos> clear = new ArrayList<>();
		List<BlockPos> place = new ArrayList<>();
		for (BlockPos cell : site.foundation()) {
			if (!client.level.hasChunkAt(cell)) continue;
			BlockState state = client.level.getBlockState(cell);
			if (state.canBeReplaced()) place.add(cell);
			else if (!hutBuildingBlock(state)) clear.add(cell);
		}
		for (BlockPos cell : starterHutCells(site.origin())) {
			if (!client.level.hasChunkAt(cell)) continue;
			BlockState state = client.level.getBlockState(cell);
			if (state.canBeReplaced()) place.add(cell);
			else if (!hutBuildingBlock(state)) clear.add(cell);
		}
		if (clear.isEmpty() && place.isEmpty()) {
			placedShelter = site.origin().immutable();
			shelterBuilt = true;
			saveHomeMemory();
			return;
		}
		// The first blueprint cell is not always reachable from the interior
		// stand. A far foundation corner then failed "no reachable support
		// face" every cycle. Choose any remaining cell that has a real stand
		// and support face, preferring the one closest to the body.
		BlockPos next = null;
		BlockPos stand = null;
		double bestScore = Double.POSITIVE_INFINITY;
		List<BlockPos> remainingCells = new ArrayList<>(clear.size() + place.size());
		remainingCells.addAll(clear);
		remainingCells.addAll(place);
		for (BlockPos cell : remainingCells) {
			BlockPos candidate = PlaceTask.standForCell(client, site.origin(), cell);
			if (candidate == null) continue;
			// standForCell uses an ideal centre. When that centre is the cell
			// the body already occupies, also probe the real eye: a roof
			// stance can be 0.2 blocks off and see a lower wall hole as
			// cloaked, which made every retry select the same unreachable
			// cell. Skip it now and let another cell make progress.
			if (
				candidate.equals(player.blockPosition())
					&& PlaceTask.findSupportForTarget(client, cell) == null
			) {
				continue;
			}
			double distance = player.position().distanceToSqr(Vec3.atCenterOf(candidate));
			// Build bottom-up. Choosing the nearest cell let the roof and
			// upper walls close over a lower wall hole before it was filled;
			// that cell then had no visible support face and stalled the hut.
			double score =
				Math.max(0, cell.getY() - site.origin().getY()) * 100.0 + distance;
			if (score < bestScore) {
				bestScore = score;
				next = cell;
				stand = candidate;
			}
		}
		if (next == null) {
			// Every remaining cell is cloaked. The usual cause is a lower
			// wall cell that was left empty while the blocks above it were
			// already placed. Remove the hut block directly above the lowest
			// missing cell, fill the hole, then rebuild that block.
			BlockPos lowest = null;
			for (BlockPos cell : place) {
				if (lowest == null || cell.getY() < lowest.getY()) lowest = cell;
			}
			if (lowest != null) {
				BlockPos ceiling = lowest.above();
				BlockState ceilingState = client.level.getBlockState(ceiling);
				if (
					hutBuildingBlock(ceilingState)
						&& starterHutCells(site.origin()).contains(ceiling)
				) {
					next = ceiling;
					stand = PlaceTask.standForCell(client, site.origin(), ceiling);
					if (stand == null) stand = player.blockPosition();
					clear.add(ceiling);
					CraftMateBodyClient.LOGGER.info(
						"hut repair ceiling={} hole={} player={}",
						ceiling,
						lowest,
						player.blockPosition()
					);
				}
			}
		}
		if (next == null || stand == null) {
			int logNow = tick(client);
			if (logNow >= nextHutStepLogTick) {
				nextHutStepLogTick = logNow + 100;
				CraftMateBodyClient.LOGGER.info(
					"hut step none origin={} remaining={} player={}",
					site.origin(),
					remainingCells.size(),
					player.blockPosition()
				);
			}
			return;
		}
		boolean clearing = clear.contains(next);
		String material = clearing ? null : PlaceTask.chooseHutMaterial(player, 1);
		JsonObject hut = new JsonObject();
		hut.add("origin", position(site.origin()));
		hut.add("stand", position(stand));
		hut.add("pending", position(next));
		hut.addProperty("action", clearing ? "clear" : "place");
		hut.addProperty("remaining", clear.size() + place.size());
		if (clearing) {
			hut.addProperty(
				"block",
				BuiltInRegistries.BLOCK.getKey(
					client.level.getBlockState(next).getBlock()
				).toString()
			);
		}
		if (material != null) hut.addProperty("material", material);
		world.add("hut", hut);
	}

	/**
	 * A cell that already holds a hut material is finished work, not an
	 * obstruction. Without this the snapshot listed the planks it had just
	 * placed as `clear`, so the body mined its own walls and the remaining
	 * count never went down.
	 */
	private static boolean hutBuildingBlock(BlockState state) {
		return state.is(BlockTags.PLANKS)
			|| state.is(Blocks.COBBLESTONE)
			|| state.is(Blocks.DIRT);
	}

	/**
	 * A three-block shaft needs two air cells for the body and a solid roof
	 * above the head. The surrounding ground height is measured by the
	 * caller, so this predicate stays independent of the client world and is
	 * covered by a plain unit test.
	 */
	static boolean shaftIsEnclosed(
		int walls,
		int depth,
		boolean headroomAir,
		boolean roofSolid
	) {
		return walls >= 3 && depth >= 3 && headroomAir && roofSolid;
	}

	/**
	 * The mine is the same shape as the house: a fixed reusable entrance plus
	 * one next block to break and one place to stand. A whole-shaft `descend`
	 * skill hid progress, so a failed step dragged the entire trip back to the
	 * surface. The planner now advances the staircase one cell at a time.
	 */
	private static void addMineSnapshot(
		JsonObject world,
		Minecraft client,
		LocalPlayer player
	) {
		BlockPos entrance = ensureMineEntrance(client, player);
		if (entrance == null || mineDirection == null) return;
		int dx = mineDirection.getStepX();
		int dz = mineDirection.getStepZ();
		int depth = entrance.getY() - player.blockPosition().getY();
		JsonObject mine = new JsonObject();
		mine.add("entrance", position(entrance));
		mine.addProperty("direction", mineDirection.getName());
		BlockPos stairStand = entrance;
		if (depth >= 0) {
			BlockPos expected = entrance.offset(dx * depth, -depth, dz * depth);
			if (nearColumn(player, expected)) stairStand = expected;
		}
		JsonObject stair = stairBlueprint(client, entrance, stairStand, dx, dz);
		if (stair != null) {
			minePlanFailures = 0;
			mine.add("stair", stair);
		} else if (player.blockPosition().getY() >= entrance.getY() - 3) {
			minePlanFailures++;
			if (minePlanFailures > 100) {
				CraftMateBodyClient.LOGGER.info(
					"mine entrance stale entrance={} player={}",
					entrance,
					player.blockPosition()
				);
				mineEntrance = null;
				mineDirection = null;
				minePlanFailures = 0;
				nextMineEntranceSearchTick = 0;
				saveHomeMemory();
			}
		}
		JsonObject branch = branchBlueprint(client, entrance, player, dx, dz);
		if (branch != null) mine.add("branch", branch);
		if (mine.has("stair") || mine.has("branch")) world.add("mine", mine);
	}

	private static JsonObject stairBlueprint(
		Minecraft client,
		BlockPos entrance,
		BlockPos stand,
		int dx,
		int dz
	) {
		BlockPos current = stand;
		for (int advance = 0; advance < 2; advance++) {
			BlockPos front = current.offset(dx, 0, dz);
			BlockState landingFloor = client.level.getBlockState(front.below(2));
			if (
				!landingFloor.blocksMotion() ||
				!landingFloor.getFluidState().isEmpty() ||
				landingFloor.is(BlockTags.LEAVES)
			) {
				return null;
			}
			BlockPos pending = firstBreakable(client, front, front.above(), front.below());
			if (pending == null) return null;
			if (pending == front || pending == front.above() || pending == front.below()) {
				if (!safeMineCell(client, front)
					|| !safeMineCell(client, front.above())
					|| !safeMineCell(client, front.below())) {
					return null;
				}
				JsonObject step = mineStep(client, current, pending);
				step.addProperty("depth", Math.max(0, entrance.getY() - current.getY()));
				return step;
			}
			BlockPos next = front.below();
			if (!PlaceTask.canStandAt(client, next)) return null;
			current = next;
		}
		return null;
	}

	private static JsonObject branchBlueprint(
		Minecraft client,
		BlockPos entrance,
		LocalPlayer player,
		int dx,
		int dz
	) {
		int depth = entrance.getY() - player.blockPosition().getY();
		if (depth < MIN_BRANCH_DEPTH) return null;
		BlockPos center = entrance.offset(dx * depth, -depth, dz * depth);
		if (!PlaceTask.canStandAt(client, center) && !center.equals(player.blockPosition())) {
			return null;
		}
		int surface = client.level.getHeight(
			Heightmap.Types.MOTION_BLOCKING_NO_LEAVES,
			center.getX(),
			center.getZ()
		);
		if (center.getY() >= surface - 2) return null;
		double along =
			(player.getX() - (center.getX() + 0.5)) * dx +
			(player.getZ() - (center.getZ() + 0.5)) * dz;
		double sideways =
			(player.getX() - (center.getX() + 0.5)) * dz -
			(player.getZ() - (center.getZ() + 0.5)) * dx;
		boolean onBranch =
			Math.abs(sideways) <= 1.1 &&
			Math.abs(player.getY() - center.getY()) <= 0.75 &&
			along >= -0.6;
		int distance = onBranch ? Math.max(0, (int) Math.round(along)) : 0;
		BlockPos stand = center.offset(dx * distance, 0, dz * distance);
		if (!PlaceTask.canStandAt(client, stand) && !stand.equals(player.blockPosition())) {
			stand = center;
			distance = 0;
		}
		BlockPos front = stand.offset(dx, 0, dz);
		BlockState branchFloor = client.level.getBlockState(front.below());
		if (!branchFloor.blocksMotion() || !branchFloor.getFluidState().isEmpty()) {
			return null;
		}
		BlockPos pending = firstBreakable(client, front, front.above());
		if (pending == null) {
			BlockPos next = front;
			if (!PlaceTask.canStandAt(client, next)) return null;
			stand = next;
			distance++;
			front = stand.offset(dx, 0, dz);
			pending = firstBreakable(client, front, front.above());
			if (pending == null) return null;
		}
		if (!safeMineCell(client, front) || !safeMineCell(client, front.above())) {
			return null;
		}
		JsonObject step = mineStep(client, stand, pending);
		step.addProperty("distance", Math.max(0, distance));
		return step;
	}

	private static JsonObject mineStep(
		Minecraft client,
		BlockPos stand,
		BlockPos pending
	) {
		JsonObject step = new JsonObject();
		step.add("stand", position(stand));
		JsonObject target = position(pending);
		target.addProperty(
			"id",
			BuiltInRegistries.BLOCK.getKey(client.level.getBlockState(pending).getBlock()).toString()
		);
		step.add("pending", target);
		return step;
	}

	/**
	 * Air is already open. A solid cell is usable only when it is not a fluid
	 * source and can actually be broken; a bedrock block in the stair line is
	 * an honest "no plan", never an invitation to try forever.
	 */
	private static boolean safeMineCell(Minecraft client, BlockPos cell) {
		BlockState state = client.level.getBlockState(cell);
		if (!state.getFluidState().isEmpty()) return false;
		if (state.isAir()) return true;
		if (state.is(Blocks.BEDROCK) || state.is(Blocks.BARRIER)) return false;
		// Trees are not a mine. Breaking a leaf or a trunk in the staircase
		// line makes the "next cell" look valid while the body tunnels through
		// a canopy instead of descending into stone.
		if (state.is(BlockTags.LEAVES) || state.is(BlockTags.LOGS)) return false;
		return state.getDestroySpeed(client.level, cell) >= 0.0f;
	}

	private static BlockPos firstBreakable(Minecraft client, BlockPos... cells) {
		for (BlockPos cell : cells) {
			if (!client.level.getBlockState(cell).isAir()) return cell;
		}
		return null;
	}

	private static boolean nearColumn(LocalPlayer player, BlockPos cell) {
		return Math.abs(player.getX() - (cell.getX() + 0.5)) <= 0.9
			&& Math.abs(player.getZ() - (cell.getZ() + 0.5)) <= 0.9
			&& Math.abs(player.getY() - cell.getY()) <= 0.75;
	}

	/**
	 * Pick one fixed surface entrance near the camp. It must be reachable on
	 * foot, standable, outside the hut footprint, and have three descending
	 * steps whose floors are solid. The old site search only checked the hut
	 * footprint and could choose a cell across a ravine, so the body circled
	 * forever without ever reaching its own mine.
	 */
	private static BlockPos ensureMineEntrance(
		Minecraft client,
		LocalPlayer player
	) {
		if (mineEntrance != null) {
			if (mineDirection == null) {
				mineDirection = horizontalFromYaw(player.getYRot());
				saveHomeMemory();
			}
			String problem = mineEntranceProblem(client, mineEntrance, mineDirection);
			if (problem == null) {
				return mineEntrance;
			}
			// A remembered entrance can be buried by the finished hut, washed
			// out, or left on a tree that has since grown. Trusting it forever
			// made the planner walk to a cell that could never advance.
			CraftMateBodyClient.LOGGER.info(
				"mine entrance invalid entrance={} reason={} player={}",
				mineEntrance,
				problem,
				player.blockPosition()
			);
			mineEntrance = null;
			mineDirection = null;
			minePlanFailures = 0;
			nextMineEntranceSearchTick = 0;
			saveHomeMemory();
		}
		int now = tick(client);
		if (now < nextMineEntranceSearchTick) return null;
		nextMineEntranceSearchTick = now + 40;
		if (!nearEstablishedHome(player.blockPosition(), 24)) return null;
		BlockPos anchor =
			placedChest != null
				? placedChest
				: placedBed != null
					? placedBed
					: player.blockPosition();
		BlockPos best = null;
		Direction bestDirection = null;
		double bestScore = Double.POSITIVE_INFINITY;
		for (int dx = -MINE_SITE_RADIUS; dx <= MINE_SITE_RADIUS; dx++) {
			for (int dz = -MINE_SITE_RADIUS; dz <= MINE_SITE_RADIUS; dz++) {
				int x = anchor.getX() + dx;
				int z = anchor.getZ() + dz;
				if (!client.level.hasChunkAt(new BlockPos(x, anchor.getY(), z))) continue;
				int ground = PlaceTask.hutGroundY(client.level, x, z, anchor.getY());
				if (Math.abs(ground - anchor.getY()) > 4) continue;
				BlockPos candidate = new BlockPos(x, ground, z);
				if (!PlaceTask.canStandAt(client, candidate)) continue;
				if (insideHutFootprint(candidate)) continue;
				for (Direction direction : MINE_HORIZONTAL) {
					// The selection and the persistence check must agree. The
					// old search could choose a cell that the next snapshot
					// immediately rejected, then choose the same cell again
					// every tick.
					if (mineEntranceProblem(client, candidate, direction) != null) continue;
					if (
						stairBlueprint(
							client,
							candidate,
							candidate,
							direction.getStepX(),
							direction.getStepZ()
						) == null
					) {
						continue;
					}
					double distance = Math.hypot(dx, dz);
					double score =
						Math.abs(distance - 5.0) +
						Math.abs(candidate.getY() - anchor.getY()) * 2.0;
					if (score < bestScore) {
						bestScore = score;
						best = candidate;
						bestDirection = direction;
					}
				}
			}
		}
		if (best == null || bestDirection == null) return null;
		mineEntrance = best.immutable();
		mineDirection = bestDirection;
		saveHomeMemory();
		CraftMateBodyClient.LOGGER.info(
			"mine entrance={} direction={} anchor={} player={}",
			mineEntrance,
			mineDirection,
			anchor,
			player.blockPosition()
		);
		return mineEntrance;
	}

	/**
	 * Validate a persisted entrance only when its chunk is loaded. The body
	 * can be a hundred blocks underground with the surface chunk unloaded;
	 * that is not evidence that the entrance disappeared.
	 */
	private static String mineEntranceProblem(
		Minecraft client,
		BlockPos entrance,
		Direction direction
	) {
		if (!client.level.hasChunkAt(entrance)) return null;
		if (insideHutFootprint(entrance)) return "inside_hut";
		if (
			!client.level.getBlockState(entrance).getFluidState().isEmpty()
				|| !client.level.getBlockState(entrance.above()).getFluidState().isEmpty()
		) {
			return "fluid";
		}
		if (!PlaceTask.canStandAt(client, entrance)) return "not_standable";
		if (!client.level.getBlockState(entrance.below()).blocksMotion()) return "no_floor";
		// Use the same trunk/leaf-blind ground probe as the site search. The
		// no-leaves heightmap still counts a trunk, so an entrance under a
		// tree looked six blocks "too deep" and was rejected forever.
		int ground = PlaceTask.hutGroundY(
			client.level,
			entrance.getX(),
			entrance.getZ(),
			entrance.getY()
		);
		if (Math.abs(entrance.getY() - ground) > 2) return "buried";
		if (!descentAheadClear(client, entrance, direction)) return "descent_blocked";
		return null;
	}

	private static boolean insideHutFootprint(BlockPos cell) {
		BlockPos origin = placedShelter != null ? placedShelter : plannedHutSite;
		if (origin == null) return false;
		return Math.abs(cell.getX() - origin.getX()) <= 3
			&& Math.abs(cell.getZ() - origin.getZ()) <= 3
			&& cell.getY() >= origin.getY() - 1
			&& cell.getY() <= origin.getY() + 5;
	}

	private static boolean descentAheadClear(
		Minecraft client,
		BlockPos entrance,
		Direction direction
	) {
		for (int step = 0; step < 4; step++) {
			BlockPos feet = entrance.offset(
				direction.getStepX() * step,
				-step,
				direction.getStepZ() * step
			);
			BlockPos front = feet.relative(direction);
			if (
				!safeMineCell(client, front) ||
				!safeMineCell(client, front.above()) ||
				!safeMineCell(client, front.below())
			) {
				return false;
			}
			BlockState floor = client.level.getBlockState(front.below(2));
			if (
				!floor.blocksMotion() ||
				!floor.getFluidState().isEmpty() ||
				floor.is(BlockTags.LEAVES)
			) {
				return false;
			}
		}
		return true;
	}

	private static Direction horizontalFromYaw(float yaw) {
		float normalized = (yaw % 360.0f + 360.0f) % 360.0f;
		if (normalized >= 315.0f || normalized < 45.0f) return Direction.SOUTH;
		if (normalized < 135.0f) return Direction.WEST;
		if (normalized < 225.0f) return Direction.NORTH;
		return Direction.EAST;
	}

	/**
	 * The nearest block with a reachable exposed face. This is independent of
	 * where the rendered camera points, so the planner can name a real target
	 * even when the body is looking at its feet.
	 */
	private static JsonObject reachableBlock(Minecraft client, LocalPlayer player) {
		BlockPos origin = player.blockPosition();
		Vec3 eye = player.getEyePosition();
		BlockPos best = null;
		double bestDistance = Double.POSITIVE_INFINITY;
		for (BlockPos pos : BlockPos.betweenClosed(
			origin.offset(-5, -3, -5),
			origin.offset(5, 3, 5)
		)) {
			BlockPos candidate = pos.immutable();
			BlockState state = client.level.getBlockState(candidate);
			if (state.isAir()) continue;
			if (removesCurrentSupport(player, candidate)) continue;
			if (!canTouchBlock(client, eye, candidate)) continue;
			Direction face = BlockInteraction.nearestExposedFace(
				client.level,
				eye,
				candidate
			);
			if (face == null) continue;
			double distance = eye.distanceToSqr(
				BlockInteraction.facePoint(candidate, face)
			);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = candidate;
			}
		}
		if (best == null) return null;
		BlockState state = client.level.getBlockState(best);
		JsonObject entry = new JsonObject();
		entry.addProperty("id", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
		entry.addProperty("x", best.getX());
		entry.addProperty("y", best.getY());
		entry.addProperty("z", best.getZ());
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
			if (!stack.isEmpty() && stack.getItem().isEdible()) return true;
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
					optionalBlockPos(args, "container"),
					integer(args, "maxStacks", Integer.MAX_VALUE)
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
				case "place_block" -> new PlaceTask(
					id,
					required(args, "block"),
					integer(args, "count", 1),
					optionalBlockPos(args, "at"),
					flag(args, "emergency")
				);
				case "smelt" -> new SmeltTask(
					id,
					required(args, "input"),
					required(args, "output"),
					integer(args, "count", 1),
					optional(args, "fuel")
				);
				case "pillar_up" -> new PillarTask(
					id,
					optional(args, "block"),
					integer(args, "height", 3)
				);
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
		// A blueprint is dozens of one-block commands. Printing every exact
		// `place_block`/`mine_block` turned the in-game chat into a wall of
		// text and hid the actual task changes. Keep status for coarse moves
		// and stations; exact-cell work is already visible in the world.
		if (!(args.has("at") && ("place_block".equals(op) || "mine_block".equals(op)))) {
			showStatus(
				client,
				SkillLabels.displayName(op) + " · " + id.substring(0, Math.min(8, id.length()))
			);
		}
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
		stopLocally(client, false);
	}

	public static void stopLocally(Minecraft client, boolean preserveHumanInput) {
		LocalPlayer player = client.player;
		if (player != null && player.input != null) player.input.tick(false, 1.0f);
		boolean wasMining = miningInputHeld;
		releaseMiningInput(client);
		IdleWander.reset(client);
		MultiPlayerGameMode mode = client.gameMode;
		if (wasMining && mode != null && mode.isDestroying()) {
			mode.stopDestroyBlock();
			mode.tick();
		}
		for (String id : new ArrayList<>(TASKS.keySet())) {
			Task task = TASKS.remove(id);
			if (task != null) task.stop(client);
		}
		if (preserveHumanInput) {
			restorePhysicalInputs(client);
		} else {
			releaseInputs(client);
		}
	}

	static void update(Minecraft client, boolean agentControlled) {
		agentInputAllowed = agentControlled;
		if (!agentControlled) {
			boolean wasMining = miningInputHeld;
			miningInputHeld = false;
			if (
				wasMining
					&& client.gameMode != null
					&& client.gameMode.isDestroying()
			) {
				client.gameMode.stopDestroyBlock();
			}
			// Never release movement keys here. A human holding W during
			// takeover owns those mappings now; the transition cleanup does
			// one handoff and restores physically held keys.
			return;
		}
		LocalPlayer player = client.player;
		if (player != null) {
			if (!player.isAlive()) {
				if (!deathPreempted) {
					deathPreempted = true;
					preemptTasksForDeath(client);
				}
			} else {
				deathPreempted = false;
			}
		}
		closeStaleMenu(client, agentControlled);
		respawnIfDead(client, agentControlled);
		tickTasks(client);
		// Reflexes run before skills so a danger detected this tick stops the
		// input a task would otherwise press again, and so a task that is
		// already underway cannot finish the tick by walking into lava.
		boolean emergencyAction = TASKS.values().stream().anyMatch(task -> task.emergencyAction);
		if (
			reflexes == null ||
			!reflexes.tick(client, agentControlled, emergencyAction)
		) {
			advanceTasks(client, agentControlled);
		}
		// Vanilla buoyancy is slow. A body that falls into deep water used to
		// sink for several seconds before any task noticed and started
		// swimming. Surface on the first water-contact tick regardless of
		// which skill owns the body; tasks may still steer forward while this
		// key lifts the eyes out of the fluid.
		surfaceIfSubmerged(client);
	}

	private static void surfaceIfSubmerged(Minecraft client) {
		LocalPlayer player = client.player;
		if (
			player == null ||
			!player.isAlive()
		) return;
		boolean bodyInWater = player.isInWater();
		boolean eyesInWater = player.isEyeInFluid(FluidTags.WATER);
		if (!WaterSurface.needsJump(bodyInWater, eyesInWater, player.onGround())) {
			return;
		}
		client.options.keyJump.setDown(true);
		if (player.input != null) {
			// KeyboardInput normally derives this from keyJump, but writing
			// the field as well makes the very next player tick rise even if
			// another input backend (or a same-tick task) already refreshed it.
			player.input.jumping = true;
			if (player.input instanceof KeyboardInput keyboard) {
				keyboard.tick(false, 1.0f);
			}
			player.input.jumping = true;
		}
	}

	/**
	 * Stops every skill belonging to the previous life. Results are reported as
	 * `preempted` rather than failures: a death is a normal world event, and the
	 * goal runtime must not open a strategy circuit or add backoff for it.
	 */
	private static void preemptTasksForDeath(Minecraft client) {
		releaseMiningInput(client);
		releaseWalkInput(client);
		IdleWander.reset(client);
		CameraController.reset(client);
		for (String id : new ArrayList<>(TASKS.keySet())) {
			finish(id, "preempted", "E_CANCELLED", "角色死亡，重生后继续当前目标");
		}
	}

	/**
	 * A container screen opened by a task must be closed by that task. If a
	 * path fails midway and leaves it open, every later skill is rejected with
	 * "the player has a screen open" and the run looks frozen at a workbench.
	 * Give the owning task a grace window, then reclaim the body.
	 */
	private static void closeStaleMenu(Minecraft client, boolean agentControlled) {
		if (
			!agentControlled
			|| client.player == null
			|| !(client.screen instanceof AbstractContainerScreen<?>)
			|| !TASKS.isEmpty()
		) {
			staleMenuSince = -1;
			return;
		}
		if (staleMenuSince < 0) {
			staleMenuSince = clientTick;
			return;
		}
		if (clientTick - staleMenuSince < 20 * 5) return;
		staleMenuSince = -1;
		client.player.closeContainer();
		showStatus(client, "关闭遗留容器界面");
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

	private static void advanceTasks(Minecraft client, boolean agentControlled) {
		// A screen the player opened pauses the agent instead of being closed.
		// Tasks that need a menu mark it with `keepScreen` and keep working.
		boolean keepScreen = TASKS.values().stream()
			.anyMatch(task -> task.started && task.keepScreen(client));
		if (blocksOnPlayerScreen(client) && !keepScreen) {
			releaseWalkInput(client);
			releaseMiningInput(client);
			return;
		}
		// Real work always wins over idling. Reset before ticking so a task's
		// own key press in this tick is not immediately released again.
		if (!TASKS.isEmpty()) IdleWander.reset(client);
		for (Task task : new ArrayList<>(TASKS.values())) {
			if (!task.started || !TASKS.containsKey(task.id)) continue;
			try {
				task.tick(client);
			} catch (Throwable error) {
				finish(task.id, "failed", "E_INTERNAL", message(error));
			}
		}
		if (TASKS.isEmpty()) {
			if (!CameraController.retained()) CameraController.release();
			IdleWander.tick(client, agentControlled);
		}
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

	private static boolean flag(JsonObject args, String name) {
		return args.has(name)
			&& args.get(name).isJsonPrimitive()
			&& args.get(name).getAsBoolean();
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
		/**
		 * A deliberate danger response (fight, pillar, emergency shaft, seal).
		 * The reflex may still report environmental hazards, but it must not
		 * cancel the action the planner chose to survive a nearby mob.
		 */
		boolean emergencyAction;
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
			/*
			 * Waiting must not inherit the previous task's held keys. A wait
			 * issued at night after a mining task kept walking and mining
			 * into the cave while the planner believed the body was standing
			 * still inside its shelter.
			 */
			releaseWalkInput(client);
			releaseMiningInput(client);
			CameraController.release();
			send.accept(progress(id, "waiting", 0, total));
		}

		@Override
		void tick(Minecraft client) {
			LocalPlayer player = client.player;
			// Waiting is only safe while nothing can see the body. A skeleton
			// that kept line of sight through the night turned a 30-second
			// wait into several deaths; abort so the planner can retreat or
			// dig in instead of standing still under fire.
			if (player != null && client.level != null) {
				boolean seen = !client.level.getEntitiesOfClass(
					Monster.class,
					player.getBoundingBox().inflate(16.0),
					monster -> monster.isAlive() && monster.hasLineOfSight(player)
				).isEmpty();
				if (seen) {
					finish(id, "failed", "E_PRECONDITION", "hostile can see the body while waiting");
					return;
				}
			}
			remaining--;
			if (remaining <= 0) {
				JsonObject evidence = new JsonObject();
				evidence.addProperty("summary", "waited " + total + " ticks");
				JsonArray changes = new JsonArray();
				JsonObject change = new JsonObject();
				change.addProperty("kind", "action_completed");
				change.addProperty("detail", "wait");
				changes.add(change);
				evidence.add("changes", changes);
				finish(id, "completed", null, null, evidence);
			}
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
			JsonObject evidence = new JsonObject();
			evidence.addProperty("summary", "sent chat message");
			JsonArray changes = new JsonArray();
			JsonObject change = new JsonObject();
			change.addProperty("kind", "action_completed");
			change.addProperty("detail", "say");
			changes.add(change);
			evidence.add("changes", changes);
			finish(id, "completed", null, null, evidence);
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
				JsonObject evidence = new JsonObject();
				evidence.addProperty("summary", "camera settled on the target");
				JsonArray changes = new JsonArray();
				JsonObject change = new JsonObject();
				change.addProperty("kind", "action_completed");
				change.addProperty("detail", "look_at");
				changes.add(change);
				evidence.add("changes", changes);
				finish(id, "completed", null, null, evidence);
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
		private static final int QUICK_PATH_NODES = 3_000;
		private static final double QUICK_PATH_RADIUS = 56.0;
		private static final int QUICK_PATH_VERTICAL = 16;
		private static final int EXTENDED_PATH_NODES = 6_000;
		private static final double EXTENDED_PATH_RADIUS = 64.0;
		private static final int EXTENDED_PATH_VERTICAL = 32;
		/**
		 * A deep mine can sit more than a hundred blocks below the surface.
		 * The pathfinder still receives a hard node budget, but the vertical
		 * window has to cover the requested climb or the return verifies as
		 * an impossible route and falls through to hand mining.
		 */
		private static final int MAX_RETURN_VERTICAL = 384;
		private static final int MAX_RETURN_PATH_NODES = 20_000;
		private static final double MAX_RETURN_RADIUS = 128.0;
		/** A partial leg this long still moved the observer somewhere new. */
		private static final double PARTIAL_PROGRESS = 8.0;
		/**
		 * Cross-task memory for exploration only. A mountain corridor offers
		 * exactly two complete routes: one up the slope and one back down.
		 * Each fresh task only saw its own terrain and picked the single
		 * complete heading, so the body walked the same forty metres in
		 * reverse forever. Remembering where the last explore leg ended lets
		 * the next one try another heading first.
		 */
		private static final java.util.ArrayDeque<Vec3> exploreTrail =
			new java.util.ArrayDeque<>();
		private static final int EXPLORE_TRAIL = 3;
		private static final double OSCILLATION_RADIUS = 8.0;
		/**
		 * A bounded A* search often stops at a ravine or a chunk edge after a
		 * safe eight-block leg. Finishing the whole command there made the
		 * coordinator pick a new heading every few seconds, which the viewer
		 * sees as walking a little and then stopping. Keep the same explore
		 * target and replan from the new cell a few times before reporting.
		 */
		private static final int MAX_EXPLORE_CONTINUATIONS = 5;
		private final List<Vec3> requests;
		private final boolean acceptPartial;
		private final NavigationMode mode;
		private Vec3 target;
		private Vec3 startedAt;
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
		private int exploreContinuations;
		/**
		 * A bounded A* can return an incomplete path whose last standable cell
		 * is the body's own one-block aisle. Walking half a block and then
		 * calling the task finished used to consume the whole plan without
		 * moving the body, while the coordinator reissued the same heading
		 * every few seconds. Track the best distance reached by any partial
		 * leg so a retry cannot count the same endpoint as progress twice.
		 */
		private double bestPartialTargetDistance = Double.POSITIVE_INFINITY;
		private BlockPos escapeWall;
		/**
		 * A wall cell that never turns air must not own the body until the
		 * whole walk budget expires. Leaves and dirt usually break in a few
		 * ticks; fifteen seconds means the hit or the tool is wrong.
		 */
		private int escapeWallSince = -1;
		/** Temporary perpendicular cell used only to leave a wedged lip. */
		private Vec3 detour;
		private int detourTicks;
		/**
		 * A one-block pillar or a hilltop can have no standable A* neighbour
		 * at all. Falling one to four blocks onto a proven floor is still a
		 * safe way out; without it the body stands on the peak forever and
		 * the planner keeps producing the same impossible route.
		 */
		private Vec3 ledgeTarget;
		private int ledgeStartY;
		private int ledgeTicks;
		private double ledgeLastDistance;
		/**
		 * Cross-command memory: a rejected ledge or tunnel heading is not
		 * re-issued by the next goto. These counters live beyond one Task,
		 * while the durable route blacklist still belongs to the agent.
		 */
		private static final Map<String, Integer> recentLedgeAttempts =
			new ConcurrentHashMap<>();
		private static Direction lastFailedTunnelDirection;
		private static int tunnelDirectionFailures;
		/** A canopy has no standable neighbour, so descend before planning. */
		private boolean escapingCanopy;
		private int canopyEscapeStartedAge = -1;
		/**
		 * A cave with no standable route is not a dead end. A player mines a
		 * one-block staircase toward the surface: clear the two head cells in
		 * front, jump onto the remaining floor block, repeat. Keep this state
		 * alive across ticks so the body actually completes several steps.
		 */
		private boolean escapingNoRoute;
		private BlockPos climbStep;
		private BlockPos climbHead;
		private BlockPos climbAbove;
		private BlockPos climbMining;
		/**
		 * The first block hit by the eye ray while trying to clear a
		 * staircase cell. Adjacent cave corners often hide the intended cell
		 * behind one exposed block. Mining that blocker keeps the same goto
		 * alive instead of failing in a single tick and making the planner
		 * reissue the same unreachable route forever.
		 */
		private BlockPos climbObstruction;
		private Direction climbDirection;
		private int climbStartY;
		private int climbStepAt;
		/**
		 * A staircase jump can rubber-band against a stale step block: the
		 * body keeps bouncing between two client positions while the server
		 * never confirms a landing. Judge real approach progress instead of
		 * waiting the full twenty-second budget.
		 */
		private int climbLastProgressAt;
		private double climbLastDistance;
		private int climbSteps;
		private int climbEquipAt = -1;
		private int climbFallbacks;
		/**
		 * A same-level or downhill target cannot be reached by staircasing
		 * upward. When A* has no route, clear a two-block-high corridor toward
		 * the target, walk in, and re-plan. This is the normal human move in a
		 * sealed cave and avoids the visible "climb forever" loop.
		 */
		private boolean tunneling;
		private Direction tunnelDirection;
		private BlockPos tunnelFeet;
		private BlockPos tunnelHead;
		private int tunnelStartedAt;
		private int tunnelSteps;
		/**
		 * Last-resort vertical escape: mine the ceiling, jump, and place the
		 * block that was under the feet back into the freed cell. In an open
		 * cave there is no adjacent step to staircase, and the body may still
		 * have building blocks.
		 */
		private boolean ceilingActive;
		private BlockPos ceilingMine;
		private boolean ceilingPlacing;
		private int ceilingBase;
		private int ceilingStepAt;
		private Vec3 ceilingCenter;
		private int ceilingCenterSince = -1;
		private BlockPos pillarPlacedAt;
		private boolean pillarRetreat;
		private boolean pillarRetreatMining;
		private int pillarRetreatAt;
		/** Water has no standable cells, so it needs a swim-to-shore state. */
		private boolean swimming;
		private Vec3 swimTarget;
		private int swimTicks;
		private Vec3 swimLastPosition;
		private int swimStalledTicks;
		private double swimBestDistance = Double.POSITIVE_INFINITY;
		private int swimPillarAt = -1;
		/**
		 * Terrain commands often arrive during an idle jump. The old escape
		 * decision only had a three-second window and could sample nothing
		 * but the jump apex, then report "no way out" even though the body
		 * landed a few ticks later. Track the last grounded tick so every
		 * decision is made from a frame that can actually jump, mine or
		 * place.
		 */
		private int lastGroundedAge = -1;
		private int airborneSinceAge = -1;
		/**
		 * Gap crossing state. A body with dirt or cobblestone can extend a
		 * floor one block at a time, just like a player holding sneak and
		 * right-clicking the side of the block underfoot.
		 */
		private boolean bridging;
		private Direction bridgeDirection;
		private BlockPos bridgeSupport;
		private BlockPos bridgePlace;
		private BlockPos bridgeTarget;
		private int bridgeStartedAt;
		private int bridgeSubmittedAt = -1;
		private int bridgeBlocks;
		private int bridgeGap;
		/**
		 * A one-block lip is the most common terrain feature in this world.
		 * The old rule only jumped while `stuckTicks < 4`, so by the time the
		 * body was visibly blocked it had already disabled the one input that
		 * could climb the step. Keep a small cooldown instead of a stall gate.
		 */
		private int lastStepJumpAt = -100;

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
				if (
					client.level.getBlockState(feet.relative(direction)).blocksMotion()
						|| client.level.getBlockState(feet.above().relative(direction))
							.blocksMotion()
				) {
					walls++;
				}
			}
			boolean harvestableWall = false;
			for (Direction direction : Direction.Plane.HORIZONTAL) {
				BlockPos wallPos = feet.relative(direction);
				BlockPos headPos = feet.above().relative(direction);
				BlockState wall = client.level.getBlockState(wallPos);
				BlockState head = client.level.getBlockState(headPos);
				if (
					wall.blocksMotion()
						&& !playerFacility(wall)
						&& canBreakEscapeCell(client, player, wallPos, wall)
				) {
					harvestableWall = true;
				}
				if (
					head.blocksMotion()
						&& !playerFacility(head)
						&& canBreakEscapeCell(client, player, headPos, head)
				) {
					harvestableWall = true;
				}
			}
			if (!ShaftEscape.shouldDigOut(walls, harvestableWall)) {
				return false;
			}
			for (Direction direction : Direction.Plane.HORIZONTAL) {
				BlockPos wall = feet.relative(direction);
				BlockPos headWall = feet.above().relative(direction);
				boolean feetOpen = !client.level.getBlockState(wall).blocksMotion();
				boolean headSolid = client.level.getBlockState(headWall).blocksMotion();
				// A one-high opening is not walkable. If the feet cell is
				// already open, finish the doorway by clearing the head cell
				// instead of mining an unrelated wall.
				if (feetOpen && headSolid) {
					if (breakEscapeWall(client, player, headWall)) return true;
					continue;
				}
				if (!feetOpen) {
					if (breakEscapeWall(client, player, wall)) return true;
				}
			}
			return false;
		}

		/** Start destroying one escape cell with a valid tool for its material. */
		private boolean breakEscapeWall(
			Minecraft client,
			LocalPlayer player,
			BlockPos wall
		) {
			BlockState state = client.level.getBlockState(wall);
			if (!state.blocksMotion()) return false;
			if (playerFacility(state)) return false;
			if (!state.getFluidState().isEmpty()) return false;
			if (state.getDestroySpeed(client.level, wall) < 0.0f) return false;
			if (!BlockInteraction.hasExposedFace(client.level, wall)) return false;
			int tool = bestToolSlot(player, state);
			if (
				ShaftEscape.needsToolEquip(
					state.requiresCorrectToolForDrops(),
					tool >= 0
				)
			) {
				if (equipEscapeToolFromInventory(client, state)) {
					CraftMateBodyClient.LOGGER.info(
						"CraftMate escape lift tool target={} state={}",
						wall,
						state
					);
					return true;
				}
				return false;
			}
			boolean harvestable = ToolSelection.canHarvest(
				state.requiresCorrectToolForDrops(),
				tool >= 0
			);
			if (!harvestable) {
				return false;
			}
			Vec3 centre = Vec3.atCenterOf(wall);
			BlockHitResult hit = BlockInteraction.nearestExposedHit(
				client.level,
				player.getEyePosition(),
				wall
			);
			aimBodyAt(player, hit.getLocation());
			CameraController.steerTo(player, centre);
			if (!ShaftEscape.canBreakWall(state.blocksMotion(), hit.getBlockPos().equals(wall))) {
				return false;
			}
			escapeWall = wall;
			escapeWallSince = age;
			if (tool >= 0) player.getInventory().selected = tool;
			client.hitResult = hit;
			client.gameMode.startDestroyBlock(wall, hit.getDirection());
			CraftMateBodyClient.LOGGER.info(
				"CraftMate escape wall target={} state={} face={} tool={} bareHand={} player={} yaw={} pitch={}",
				wall,
				state,
				hit.getDirection(),
				tool,
				!harvestable,
				player.position(),
				player.getYRot(),
				player.getXRot()
			);
			return true;
		}

		/**
		 * A tool still in the main inventory cannot break anything. Swapping
		 * it into the hotbar lets the next tick continue the same escape
		 * instead of failing and making the planner reissue a doomed goto.
		 */
		private boolean equipEscapeToolFromInventory(Minecraft client, BlockState state) {
			LocalPlayer player = client.player;
			int source = -1;
			for (int slot = 9; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (!stack.isEmpty() && stack.isCorrectToolForDrops(state)) {
					source = slot;
					break;
				}
			}
			if (source < 0) return false;
			int hotbar = MineTask.toolHotbarSlot(player);
			player.getInventory().selected = hotbar;
			player.connection.send(new ServerboundSetCarriedItemPacket(hotbar));
			client.gameMode.handleInventoryMouseClick(
				player.inventoryMenu.containerId,
				source,
				hotbar,
				ClickType.SWAP,
				player
			);
			return true;
		}

		private boolean canBreakEscapeCell(
			Minecraft client,
			LocalPlayer player,
			BlockPos pos,
			BlockState state
		) {
			if (state.getDestroySpeed(client.level, pos) < 0.0f) {
				return false;
			}
			return !state.requiresCorrectToolForDrops()
				|| bestToolSlot(player, state) >= 0;
		}

		/**
		 * A workbench, furnace or bed is infrastructure the body built for
		 * itself. Treating one as a cave wall destroyed the station it needed
		 * for the next recipe, so escape paths must leave player facilities
		 * alone and choose a different direction.
		 */
		private static boolean playerFacility(BlockState state) {
			return state.is(Blocks.CRAFTING_TABLE)
				|| state.is(Blocks.FURNACE)
				|| state.is(Blocks.BLAST_FURNACE)
				|| state.is(Blocks.SMOKER)
				|| state.is(Blocks.CHEST)
				|| state.is(Blocks.TRAPPED_CHEST)
				|| state.is(Blocks.BARREL)
				|| state.is(Blocks.HOPPER)
				|| state.is(Blocks.DISPENSER)
				|| state.is(Blocks.DROPPER)
				|| state.is(Blocks.OBSERVER)
				|| state.is(Blocks.PISTON)
				|| state.is(Blocks.STICKY_PISTON)
				|| state.is(Blocks.ANVIL)
				|| state.is(Blocks.CHIPPED_ANVIL)
				|| state.is(Blocks.DAMAGED_ANVIL)
				|| state.is(BlockTags.BEDS)
				|| state.is(Blocks.TORCH)
				|| state.is(Blocks.WALL_TORCH)
				|| state.is(Blocks.SOUL_TORCH)
				|| state.is(Blocks.SOUL_WALL_TORCH)
				|| state.is(Blocks.LANTERN)
				|| state.is(Blocks.SOUL_LANTERN)
				|| state.is(Blocks.CAMPFIRE)
				|| state.is(Blocks.SOUL_CAMPFIRE);
		}

		private static boolean softWall(BlockState state) {
			return state.is(Blocks.DIRT)
				|| state.is(Blocks.GRASS_BLOCK)
				|| state.is(Blocks.SAND)
				|| state.is(Blocks.GRAVEL)
				|| state.is(Blocks.CLAY)
				|| state.is(Blocks.SNOW_BLOCK)
				|| state.is(Blocks.COARSE_DIRT)
				|| state.is(Blocks.ROOTED_DIRT);
		}

		GotoTask(String id, JsonObject args) {
			super(id);
			List<Vec3> requested = new ArrayList<>();
			requested.add(cellCentre(vec(args)));
			if (args.has("candidates") && args.get("candidates").isJsonArray()) {
				for (var entry : args.getAsJsonArray("candidates")) {
					if (!entry.isJsonObject()) continue;
					Vec3 candidate = cellCentre(vec(entry.getAsJsonObject()));
					if (requested.stream().noneMatch(seen -> seen.equals(candidate))) {
						requested.add(candidate);
					}
				}
			}
			this.requests = List.copyOf(requested);
			this.target = this.requests.get(0);
			this.mode = NavigationMode.parse(optional(args, "mode"));
			this.acceptPartial =
				args.has("acceptPartial")
					&& args.get("acceptPartial").isJsonPrimitive()
					&& args.get("acceptPartial").getAsBoolean();
			// A retreat chosen by the planner is already the answer to the
			// nearby mob. Let it run instead of letting the threat reflex
			// release every key and restart the same escape each report.
			this.emergencyAction = flag(args, "emergency");
		}

		/**
		 * A JSON block position names a cell, not its north-west corner.
		 * Walking to the raw integer made the body stop at the edge of the
		 * cell (still in the neighbouring block), which then failed exact
		 * placement with "overlaps the body". Snap every request to the cell
		 * centre; already-centred floats stay where they are.
		 */
		private static Vec3 cellCentre(Vec3 point) {
			return new Vec3(
				Math.floor(point.x) + 0.5,
				point.y,
				Math.floor(point.z) + 0.5
			);
		}

		/**
		 * A one-block pillar, a tree stump or a hilltop can have no standable
		 * A* neighbour in any direction. The body does not need a path to step
		 * off a small ledge; it needs one proven floor within a survivable
		 * drop. Four blocks costs only half a heart and cannot be lava or
		 * water, so this is always safer than freezing on the peak.
		 */
		private static Vec3 safeLedge(Minecraft client, LocalPlayer player) {
			if (!player.onGround()) return null;
			BlockPos feet = player.blockPosition();
			Vec3 best = null;
			double bestScore = Double.POSITIVE_INFINITY;
			for (int radius = 1; radius <= 4; radius++) {
				for (int dx = -radius; dx <= radius; dx++) {
					for (int dz = -radius; dz <= radius; dz++) {
						if (Math.max(Math.abs(dx), Math.abs(dz)) != radius) continue;
						if (dx == 0 && dz == 0) continue;
						int x = feet.getX() + dx;
						int z = feet.getZ() + dz;
						for (int drop = 1; drop <= 4; drop++) {
							BlockPos landing = new BlockPos(x, feet.getY() - drop, z);
							if (!standableAt(client, landing)) continue;
							if (!bodySpaceAt(client, landing)) continue;
							// The target must be open all the way up to the
							// body. A plateau has standable cells *inside* the
							// hill at lower Y, but walking toward one only
							// paces along the surface; it is not a ledge.
							boolean openAbove = true;
							for (int y = landing.getY() + 1; y <= feet.getY(); y++) {
								if (
									client.level.getBlockState(new BlockPos(x, y, z))
										.blocksMotion()
								) {
									openAbove = false;
									break;
								}
							}
							if (!openAbove) continue;
							// Stepping sideways first needs body clearance at the
							// current feet level. The old check only looked above
							// the landing cell, so it kept choosing a ledge whose
							// head cell was stone and could never be entered.
							if (
								!bodySpaceAt(
									client,
									new BlockPos(x, feet.getY(), z)
								)
							) continue;
							if (!bodyLineClear(client, feet, x, z)) continue;
							if (!client.level.getBlockState(landing).getFluidState().isEmpty()) continue;
							if (!client.level.getBlockState(landing.above()).getFluidState().isEmpty()) continue;
							if (
								client.level.getBlockState(landing.below())
									.getFluidState()
									.is(FluidTags.LAVA)
							) continue;
							double score = drop * 10.0 + Math.hypot(dx, dz);
							if (score < bestScore) {
								bestScore = score;
								best = new Vec3(x + 0.5, landing.getY(), z + 0.5);
							}
						}
					}
				}
			}
			return best;
		}

		/**
		 * A ledge on the far side of a wall is not reachable. Check every
		 * body cell on the straight horizontal line before choosing it, so
		 * the body does not jump against the same wall for six seconds and
		 * then ask the planner for the identical route again.
		 */
		private static boolean bodyLineClear(
			Minecraft client,
			BlockPos feet,
			int targetX,
			int targetZ
		) {
			int x = feet.getX();
			int z = feet.getZ();
			while (x != targetX || z != targetZ) {
				x += Integer.signum(targetX - x);
				z += Integer.signum(targetZ - z);
				if (!bodySpaceAt(client, new BlockPos(x, feet.getY(), z))) {
					return false;
				}
			}
			return true;
		}

		private boolean beginLedge(Minecraft client, LocalPlayer player, Vec3 target) {
			BlockPos from = player.blockPosition();
			BlockPos landing = BlockPos.containing(target);
			String ledgeKey = from.asLong() + ":" + landing.asLong();
			Integer lastAttempt = recentLedgeAttempts.get(ledgeKey);
			int priorAttempts = lastAttempt == null ? 0 : 1;
			int sinceAttempt = lastAttempt == null
				? -1
				: clientTick - lastAttempt;
			if (ShaftEscape.ledgeAttemptExhausted(priorAttempts, sinceAttempt)) {
				releaseWalkInput(client);
				CraftMateBodyClient.LOGGER.info(
					"CraftMate goto ledge suppressed from={} landing={} priorAttempts={} since={}",
					from,
					landing,
					priorAttempts,
					sinceAttempt
				);
				finish(
					id,
					"failed",
					"E_STUCK",
					"the same ledge already failed; refusing to retry the same drop"
				);
				return false;
			}
			if (recentLedgeAttempts.size() > 256) recentLedgeAttempts.clear();
			recentLedgeAttempts.put(ledgeKey, clientTick);
			ledgeTarget = target;
			ledgeStartY = player.blockPosition().getY();
			ledgeTicks = 0;
			ledgeLastDistance = player.position().distanceTo(target);
			releaseWalkInput(client);
			send.accept(progress(id, "descend", 0, 1));
			CraftMateBodyClient.LOGGER.info(
				"CraftMate goto ledge from={} target={}",
				player.position(),
				target
			);
			return true;
		}

		private void tickLedge(Minecraft client, LocalPlayer player) {
			Vec3 target = ledgeTarget;
			if (target == null) return;
			ledgeTicks++;
			if (ledgeTicks % 20 == 0) {
				double distance = Math.hypot(
					target.x - player.getX(),
					target.z - player.getZ()
				);
				if (distance + 0.1 >= ledgeLastDistance) {
					ledgeTarget = null;
					releaseWalkInput(client);
					if (!digOut(client)) {
						finish(
							id,
							"failed",
							"E_PRECONDITION",
							"ledge approach made no progress"
						);
					}
					return;
				}
				ledgeLastDistance = distance;
			}
			boolean landed =
				player.onGround() && player.getY() <= ledgeStartY - 0.5;
			if (landed) {
				ledgeTarget = null;
				releaseWalkInput(client);
				Route route = firstSafeRoute(client, player);
				if (route == null) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"no safe route after stepping off the ledge"
					);
					return;
				}
				destination = route.destination();
				routeComplete = route.complete();
				waypoints = route.waypoints();
				waypointIndex = waypoints.size() > 1 ? 1 : 0;
				lastWaypointIndex = waypointIndex;
				lastWaypointDistance = playerDistance(player);
				nextReplanAt = 0;
				send.accept(progress(id, "walking", 0, 1));
				return;
			}
			if (ledgeTicks > 20 * 6) {
				ledgeTarget = null;
				releaseWalkInput(client);
				finish(id, "failed", "E_TIMEOUT", "could not step safely off the ledge");
				return;
			}
			double dx = target.x - player.getX();
			double dz = target.z - player.getZ();
			float heading = (float) Math.toDegrees(Math.atan2(-dx, dz));
			boolean aligned = turnTowards(player, heading);
			CameraController.steerHeading(
				player,
				player.getYRot(),
				CameraController.displayPitch(player)
			);
			// Once airborne, keep the forward key held even if the body has not
			// finished turning; otherwise a jump straight up drops back onto
			// the same pillar.
			setWalkInput(client, aligned || !player.onGround());
			if (player.onGround()) player.jumpFromGround();
		}

		@Override
		void start(Minecraft client) {
			destination = target;
			startedAt = client.player.position();
			bestPartialTargetDistance = Math.hypot(
				target.x - client.player.getX(),
				target.z - client.player.getZ()
			);
			// A recovered respawn may carry a stale fallDistance from the
			// death tick. Reset it only when the body is actually on ground;
			// an airborne body must keep the real fall for the safety reflex.
			if (client.player.onGround()) client.player.resetFallDistance();
			if (!mode.isWalk() && onCanopy(client)) {
				escapingCanopy = true;
				canopyEscapeStartedAge = age;
				send.accept(progress(id, "unstick", 0, 1));
				return;
			}
			/*
			 * Land pathfinding refuses water, so a body that starts inside a
			 * lake or a flooded shaft used to fail the walk immediately and
			 * then only drift upward on vanilla buoyancy until the coordinator
			 * happened to issue another command. Enter the swim state right
			 * away instead; it holds jump and heads for the nearest shore.
			 * Standing in a shallow riverbed is not swimming: keep the walk
			 * plan when both feet are on the ground and the eyes are clear.
			 */
			if (WaterSurface.needsJump(
				client.player.isInWater(),
				client.player.isEyeInFluid(FluidTags.WATER),
				client.player.onGround()
			)) {
				beginSwim(client);
				return;
			}
			planRoute(client);
		}

		/**
		 * Install a fresh walk route. Used both for the first tick and after a
		 * swim leg reaches dry land, so leaving water does not leave the task
		 * with an empty waypoint list.
		 */
		private void planRoute(Minecraft client) {
			Route route = firstSafeRoute(client, client.player);
			if (route == null || !routeMovesBody(route, client.player)) {
				if (mode.isWalk()) {
					Vec3 ledge = safeLedge(client, client.player);
					if (ledge != null) {
						beginLedge(client, client.player, ledge);
						return;
					}
					failUnreachable(client, client.player, "no natural route within the walk budget");
					return;
				}
				startEscape(client, client.player);
				return;
			}
			destination = route.destination();
			routeComplete = route.complete();
			waypoints = route.waypoints();
			waypointIndex = waypoints.size() > 1 ? 1 : 0;
			lastWaypointIndex = waypointIndex;
			lastWaypointDistance = playerDistance(client.player);
			nextReplanAt = 0;
			escapingNoRoute = false;
			CraftMateBodyClient.LOGGER.info(
				"CraftMate goto start target={} destination={} position={} points={} complete={} distance={}",
				target,
				destination,
				client.player.position(),
				waypoints.size(),
				route.complete(),
				Math.hypot(
					destination.x - client.player.getX(),
					destination.z - client.player.getZ()
				)
			);
			send.accept(progress(id, "walking", 0, 1));
		}

		private void beginSwim(Minecraft client) {
			swimming = true;
			swimTarget = null;
			swimTicks = 0;
			swimStalledTicks = 0;
			swimBestDistance = Double.POSITIVE_INFINITY;
			swimLastPosition = client.player.position();
			// Start rising on the same tick the command arrives instead of
			// waiting for the next tickSwim frame.
			setSwimInput(client, false);
			send.accept(progress(id, "swimming", 0, 1));
		}

		private void startEscape(Minecraft client, LocalPlayer player) {
			if (mode.isWalk()) {
				failUnreachable(client, player, "walk mode cannot enter a destructive escape");
				return;
			}
			escapingNoRoute = true;
			climbSteps = 0;
			climbFallbacks = 0;
			tunnelSteps = 0;
			releaseWalkInput(client);
			CraftMateBodyClient.LOGGER.info(
				"CraftMate goto escape no useful route position={} target={}",
				player.position(),
				target
			);
			send.accept(progress(id, "unstick", 0, 1));
			tickEscape(client, player);
		}

		private void failUnreachable(
			Minecraft client,
			LocalPlayer player,
			String detail
		) {
			stop(client);
			boolean enclosed = enclosedRecoverySite(client, player);
			JsonObject data = new JsonObject();
			data.addProperty("mode", mode.wireName());
			data.addProperty("reason", enclosed ? "enclosed" : "no_route");
			data.addProperty("attemptedNodes", EXTENDED_PATH_NODES);
			data.addProperty("attemptedRadius", EXTENDED_PATH_RADIUS);
			data.addProperty("attemptedVertical", EXTENDED_PATH_VERTICAL);
			JsonObject nearest = new JsonObject();
			nearest.addProperty("x", player.getX());
			nearest.addProperty("y", player.getY());
			nearest.addProperty("z", player.getZ());
			data.add("nearestReachable", nearest);
			finish(
				id,
				"failed",
				enclosed ? "E_ENCLOSED" : "E_UNREACHABLE",
				detail,
				data
			);
		}

		private static boolean enclosedRecoverySite(
			Minecraft client,
			LocalPlayer player
		) {
			BlockPos feet = player.blockPosition();
			boolean ceiling =
				isRecoveryBarrier(client.level.getBlockState(feet.above(2)))
					|| isRecoveryBarrier(client.level.getBlockState(feet.above(3)));
			int walls = 0;
			for (Direction direction : Direction.Plane.HORIZONTAL) {
				if (
					isRecoveryBarrier(client.level.getBlockState(feet.relative(direction)))
						|| isRecoveryBarrier(
							client.level.getBlockState(feet.above().relative(direction))
						)
				) {
					walls++;
				}
			}
			return ShaftEscape.shouldStartPillar(ceiling, walls);
		}

		/**
		 * Leaves and logs are solid for movement but are not a roof. A player
		 * standing under a tree canopy must not be treated as an enclosed
		 * shaft; that misclassification produced the live sky pillar.
		 */
		private static boolean isRecoveryBarrier(BlockState state) {
			return (
				ShaftEscape.isStructuralBarrier(
					state.blocksMotion(),
					state.is(BlockTags.LEAVES),
					state.is(BlockTags.LOGS)
				)
			);
		}

		/**
		 * A complete route is always usable. An incomplete one is useful only
		 * if it actually leaves the body's current cell; the bounded search
		 * often ends one half-block away when the body is boxed in, and
		 * following that route makes the task look finished while nothing
		 * moved.
		 */
		private boolean routeMovesBody(Route route, LocalPlayer player) {
			if (
				!ShaftEscape.routeAdvancesTowardTarget(
					route.complete(),
					route.destination().y,
					player.getY(),
					target.y
				)
			) {
				return false;
			}
			if (route.complete()) return true;
			Vec3 end = route.destination();
			double moved = Math.hypot(end.x - player.getX(), end.z - player.getZ());
			// Explore legs are allowed to stop at a safe observation point,
			// but a two-block partial leg is not an exploration. Following it
			// burned the command, failed the eight-block progress check, and
			// supplied the runtime with the same heading again every retry.
			return moved >= (acceptPartial ? PARTIAL_PROGRESS : 2.0);
		}

		/**
		 * The body cannot path out of a cave whose only exit is upward. Try
		 * the cheap escapes first, then mine a staircase toward the requested
		 * target. Progress frames keep the bridge deadline open while several
		 * blocks are being cleared.
		 */
		private void tickEscape(Minecraft client, LocalPlayer player) {
			if (pillarRetreat) {
				tickPillarRetreat(client, player);
				return;
			}
			if (ceilingActive) {
				tickCeilingPillar(client, player);
				return;
			}
			if (bridging) {
				tickBridge(client, player);
				return;
			}
			if (tunneling) {
				tickTunnel(client, player);
				return;
			}
			if (climbStep != null) {
				tickClimb(client, player);
				return;
			}
			boolean inWater =
				player.isInWater() || player.isEyeInFluid(FluidTags.WATER);
			// Swimming is a valid non-grounded mode, not a physics desync.
			// Counting those ticks as airborne made the body fail a fraction
			// of a second after it finally mined out of a flooded shaft, then
			// the bridge disconnected on an error code the wire schema did not
			// know. Water resets the airborne clock just like solid ground.
			if (player.onGround() || inWater) {
				lastGroundedAge = age;
				airborneSinceAge = -1;
			} else if (airborneSinceAge < 0) {
				airborneSinceAge = age;
			}
			if (age > 20 * 300) {
				stop(client);
				CraftMateBodyClient.LOGGER.info(
					"CraftMate escape timeout pos={} feet={} onGround={} water={} delta={} target={}",
					player.position(),
					player.blockPosition(),
					player.onGround(),
					player.isInWater(),
					player.getDeltaMovement(),
					target
				);
				finish(id, "failed", "E_TIMEOUT", "could not mine out of the current position");
				return;
			}
			if (age % 20 == 0) {
				CraftMateBodyClient.LOGGER.info(
					"CraftMate escape state pos={} feet={} onGround={} water={} delta={} hcoll={} climb={} bridge={} ceiling={} ledge={} wall={}",
					player.position(),
					player.blockPosition(),
					player.onGround(),
					player.isInWater(),
					player.getDeltaMovement(),
					player.horizontalCollision,
					climbStep,
					bridgeDirection,
					ceilingActive,
					ledgeTarget,
					escapeWall
				);
			}
			if (inWater) {
				tickSwim(client, player);
				return;
			}
			// Bobbing at a water surface alternates `isInWater` between true
			// and false every few ticks. Clearing the swim state on each dry
			// frame reset its timer before it could ever mine the pocket, so
			// only an actual landing clears it (see tickSwim).
			// A command frequently arrives on the same tick as an idle jump or
			// while the player is still settling after a respawn. Every escape
			// below needs solid footing, so deciding "impossible" from an
			// airborne frame made a perfectly walkable cave look like a dead
			// end and alternated goto/attack every few seconds.
			if (!player.onGround() && age < 20 * 3) {
				releaseWalkInput(client);
				if (age % 20 == 0) {
					CraftMateBodyClient.LOGGER.info(
						"CraftMate escape airborne age={} pos={} delta={} onGround={} fall={} flying={} mayfly={} fallFlying={} passenger={} vehicle={} noGravity={} jumpKey={} inputJump={} paused={} gameTime={} below={} above={} spectator={} dead={} noPhysics={} tickCount={} box={}",
						age,
						player.position(),
						player.getDeltaMovement(),
						player.onGround(),
						player.fallDistance,
						player.getAbilities().flying,
						player.getAbilities().mayfly,
						player.isFallFlying(),
						player.isPassenger(),
						player.getVehicle() == null
							? "none"
							: player.getVehicle().getType().toString(),
						player.isNoGravity(),
						client.options.keyJump.isDown(),
						player.input != null && player.input.jumping,
						client.isPaused(),
						client.level.getGameTime(),
						client.level.getBlockState(player.blockPosition().below()),
						client.level.getBlockState(player.blockPosition().above()),
						player.isSpectator(),
						player.isDeadOrDying(),
						player.noPhysics,
						player.tickCount,
						player.getBoundingBox()
					);
					send.accept(progress(id, "landing", 0, 1));
				}
				return;
			}
			// Every escape below needs a grounded body. A jump apex is not a
			// dead end, it is simply the wrong frame to decide from. Wait for
			// the next landing instead of failing on a 20-tick sampling
			// boundary. The only exception is a body that has genuinely
			// hovered for seconds: that is a physics desync, not terrain.
			if (!player.onGround()) {
				int airborneFor = airborneSinceAge < 0 ? 0 : age - airborneSinceAge;
				if (airborneFor < 20 * 6) {
					releaseWalkInput(client);
					if (age % 20 == 0) {
						send.accept(progress(id, "landing", 0, 1));
						CraftMateBodyClient.LOGGER.info(
							"CraftMate escape waiting for landing airborneFor={} age={} pos={} delta={} support={} feet={} head={}",
							airborneFor,
							age,
							player.position(),
							player.getDeltaMovement(),
							supportBlock(client, player).state(),
							client.level.getBlockState(player.blockPosition()),
							client.level.getBlockState(player.blockPosition().above())
						);
					}
					return;
				}
				CraftMateBodyClient.LOGGER.info(
					"CraftMate stale airborne pos={} airborneFor={} tickCount={} spectator={} dead={} noPhysics={} delta={} box={} feet={} below={} above={}",
					player.position(),
					airborneFor,
					player.tickCount,
					player.isSpectator(),
					player.isDeadOrDying(),
					player.noPhysics,
					player.getDeltaMovement(),
					player.getBoundingBox(),
					client.level.getBlockState(player.blockPosition()),
					client.level.getBlockState(player.blockPosition().below()),
					client.level.getBlockState(player.blockPosition().above())
				);
				stop(client);
				finish(
					id,
					"failed",
					"E_TIMEOUT",
					"body stayed airborne without water or flight; terrain state is desynchronised"
				);
				return;
			}
			Route route = firstSafeRoute(client, player);
			if (age % 20 == 0) {
				CraftMateBodyClient.LOGGER.info(
					"CraftMate escape route found={} complete={} destination={} distance={} target={}",
					route != null,
					route != null && route.complete(),
					route == null ? null : route.destination(),
					route == null
						? -1
						: Math.hypot(
							route.destination().x - player.getX(),
							route.destination().z - player.getZ()
						),
					target
				);
			}
			if (route != null && routeMovesBody(route, player)) {
				escapingNoRoute = false;
				followRoute(client, player, route);
				return;
			}
			// A request several blocks above the body is a vertical problem.
			// In a low tunnel the staircase planner could spend its entire
			// budget jumping against the same ceiling; a proven ceiling
			// pillar is the reliable human move and preserves a safe floor.
			boolean wantsUp = target.y - player.getY() > 2.5;
			if (wantsUp && mode.mayBuild() && beginCeilingPillar(client, player)) {
				send.accept(progress(id, "climbing", climbSteps, 16));
				return;
			}
			if (mode.mayDig() && digOut(client)) {
				send.accept(progress(id, "unstick", 0, 1));
				return;
			}
			if (mode.mayDig() && !wantsUp && beginTunnel(client, player)) {
				send.accept(progress(id, "tunneling", tunnelSteps, 6));
				return;
			}
			if (mode.mayDig() && beginClimbStep(client, player)) {
				send.accept(progress(id, "climbing", climbSteps, 16));
				return;
			}
			if (!wantsUp && mode.mayBuild() && beginCeilingPillar(client, player)) {
				send.accept(progress(id, "climbing", climbSteps, 16));
				return;
			}
			if (mode.mayBuild() && beginPillarRetreat(client, player)) {
				send.accept(progress(id, "descend", 0, 1));
				return;
			}
			Vec3 ledge = safeLedge(client, player);
			if (ledge != null) {
				beginLedge(client, player, ledge);
				return;
			}
			CraftMateBodyClient.LOGGER.info(
				"CraftMate escape failed pos={} feet={} feetBlock={} above={} above2={} ground={} ceiling={} buildingSlot={} onGround={} delta={} fall={} hcoll={} vcoll={} water={}",
				player.position(),
				player.blockPosition(),
				client.level.getBlockState(player.blockPosition()),
				client.level.getBlockState(player.blockPosition().above()),
				client.level.getBlockState(player.blockPosition().above(2)),
				client.level.getBlockState(player.blockPosition().below()),
				client.level.getBlockState(player.blockPosition().above(2)),
				buildingSlot(client, player),
				player.onGround(),
				player.getDeltaMovement(),
				player.fallDistance,
				player.horizontalCollision,
				player.verticalCollision,
				player.isInWater()
			);
			stop(client);
			finish(
				id,
				"failed",
				enclosedRecoverySite(client, player) ? "E_ENCLOSED" : "E_STUCK",
				"no safe route and no legal recovery step"
			);
		}

		/**
		 * The body is in a solid pocket with no walkable route. Pick the
		 * horizontal direction closest to the requested target, verify that
		 * the floor continues and that both body cells can be cleared, then
		 * mine them in place. The next tick decides whether to walk in or
		 * clear the second cell.
		 */
		private boolean beginTunnel(Minecraft client, LocalPlayer player) {
			BlockPos feet = player.blockPosition();
			double horizontal = Math.hypot(
				target.x - player.getX(),
				target.z - player.getZ()
			);
			if (!ShaftEscape.shouldTunnel(
				player.onGround(),
				target.y - player.getY(),
				horizontal
			)) {
				return false;
			}
			Vec3 toward = target.subtract(player.position());
			Direction best = null;
			double bestAlignment = -Double.MAX_VALUE;
			for (Direction direction : Direction.Plane.HORIZONTAL) {
				BlockPos front = feet.relative(direction);
				BlockPos head = front.above();
				BlockPos floor = front.below();
				BlockState floorState = client.level.getBlockState(floor);
				if (
					!floorState.blocksMotion()
						|| !floorState.getFluidState().isEmpty()
				) {
					continue;
				}
				if (
					!tunnelCellClearable(client, player, front)
						|| !tunnelCellClearable(client, player, head)
				) {
					continue;
				}
				double alignment =
					(direction.getStepX() * toward.x + direction.getStepZ() * toward.z)
						/ Math.max(1.0e-4, horizontal);
				if (alignment > bestAlignment) {
					bestAlignment = alignment;
					best = direction;
				}
			}
			if (best == null) return false;
			int priorFailures = best == lastFailedTunnelDirection
				? tunnelDirectionFailures
				: 0;
			if (ShaftEscape.tunnelDirectionExhausted(priorFailures)) {
				CraftMateBodyClient.LOGGER.info(
					"CraftMate tunnel suppressed feet={} direction={} priorFailures={}",
					feet,
					best,
					priorFailures
				);
				return false;
			}
			tunneling = true;
			tunnelDirection = best;
			tunnelFeet = feet.relative(best);
			tunnelHead = tunnelFeet.above();
			tunnelStartedAt = age;
			releaseWalkInput(client);
			CraftMateBodyClient.LOGGER.info(
				"CraftMate tunnel start feet={} direction={} target={} steps={}",
				feet,
				best,
				target,
				tunnelSteps
			);
			return true;
		}

		private boolean tunnelCellClearable(
			Minecraft client,
			LocalPlayer player,
			BlockPos pos
		) {
			BlockState state = client.level.getBlockState(pos);
			return state.getFluidState().isEmpty()
				&& !playerFacility(state)
				&& state.getDestroySpeed(client.level, pos) >= 0.0f
				&& (
					!state.requiresCorrectToolForDrops()
						|| hasCorrectToolInInventory(player, state)
				);
		}

		private void tickTunnel(Minecraft client, LocalPlayer player) {
			if (tunnelFeet == null || tunnelHead == null) {
				tunneling = false;
				tickEscape(client, player);
				return;
			}
			if (age - tunnelStartedAt > 20 * 120) {
				abortTunnel(client, "horizontal tunnel made no progress");
				return;
			}
			if (!player.onGround()) {
				releaseWalkInput(client);
				return;
			}
			if (player.blockPosition().equals(tunnelFeet)) {
				tunnelSteps++;
				releaseWalkInput(client);
				tunnelFeet = null;
				tunnelHead = null;
				tunnelDirection = null;
				tunneling = false;
				// A tie between two equally aligned directions made the body
				// mine east then west through the same two cells. After six
				// such steps it had no net movement and retried forever. Stop
				// after two steps when the body is still where it started so
				// goto can try a pillar or another escape instead.
				if (tunnelSteps >= 2 && tunnelSteps < 6 && movedFromStart(client.player) < 1.0) {
					abortTunnel(client, "tunnel is looping without net progress");
					return;
				}
				if (tunnelSteps >= 6) {
					completeTunnel(client);
					return;
				}
				send.accept(progress(id, "tunneling", tunnelSteps, 6));
				Route route = firstSafeRoute(client, player);
				if (route != null && routeMovesBody(route, player)) {
					followRoute(client, player, route);
					return;
				}
				if (beginTunnel(client, player)) return;
				completeTunnel(client);
				return;
			}
			boolean feetOpen = !client.level.getBlockState(tunnelFeet).blocksMotion();
			boolean headOpen = !client.level.getBlockState(tunnelHead).blocksMotion();
			// Clear the eye-level cell first. Mining the feet cell while the
			// head cell is still solid makes the crosshair clip through the
			// head block, so the body alternates targets and neither block
			// ever breaks. A player digs head-height first for the same reason.
			if (!headOpen) {
				if (breakTunnelCell(client, player, tunnelHead)) return;
				abortTunnel(client, "tunnel head cell is not mineable");
				return;
			}
			if (!feetOpen) {
				if (breakTunnelCell(client, player, tunnelFeet)) return;
				abortTunnel(client, "tunnel floor cell is not mineable");
				return;
			}
			BlockPos floor = tunnelFeet.below();
			BlockState floorState = client.level.getBlockState(floor);
			if (!floorState.blocksMotion() || !floorState.getFluidState().isEmpty()) {
				abortTunnel(client, "tunnel opened onto an unsafe floor");
				return;
			}
			Vec3 center = Vec3.atCenterOf(tunnelFeet);
			double dx = center.x - player.getX();
			double dz = center.z - player.getZ();
			float heading = (float) Math.toDegrees(Math.atan2(-dx, dz));
			boolean aligned = turnTowards(player, heading);
			CameraController.steerHeading(
				player,
				player.getYRot(),
				CameraController.displayPitch(player)
			);
			setWalkInput(client, aligned);
			if (age % 20 == 0) {
				send.accept(progress(id, "tunneling", tunnelSteps, 6));
			}
		}

		private boolean breakTunnelCell(
			Minecraft client,
			LocalPlayer player,
			BlockPos intended
		) {
			BlockState state = client.level.getBlockState(intended);
			if (playerFacility(state) || !state.getFluidState().isEmpty()) return false;
			return breakEscapeWall(client, player, intended);
		}

		private void completeTunnel(Minecraft client) {
			releaseWalkInput(client);
			tunneling = false;
			tunnelFeet = null;
			tunnelHead = null;
			tunnelDirection = null;
			lastFailedTunnelDirection = null;
			tunnelDirectionFailures = 0;
			if (movedFromStart(client.player) < 3.0) {
				abortTunnel(client, "horizontal tunnel did not move the body");
				return;
			}
			JsonObject evidence = new JsonObject();
			evidence.addProperty("summary", "挖出水平通道并进入新的区域");
			evidence.addProperty("partial", true);
			JsonArray changes = new JsonArray();
			JsonObject change = new JsonObject();
			change.addProperty("kind", "position_reached");
			change.addProperty("detail", "horizontal_tunnel");
			JsonObject position = new JsonObject();
			position.addProperty("x", round(client.player.getX()));
			position.addProperty("y", round(client.player.getY()));
			position.addProperty("z", round(client.player.getZ()));
			change.add("position", position);
			changes.add(change);
			evidence.add("changes", changes);
			if (acceptPartial) rememberExplore(client.player);
			finish(id, "completed", null, null, evidence);
		}

		private void abortTunnel(Minecraft client, String reason) {
			releaseMiningInput(client);
			releaseWalkInput(client);
			Direction failedDirection = tunnelDirection;
			tunneling = false;
			tunnelFeet = null;
			tunnelHead = null;
			tunnelDirection = null;
			if (failedDirection != null) {
				if (failedDirection == lastFailedTunnelDirection) {
					tunnelDirectionFailures++;
				} else {
					lastFailedTunnelDirection = failedDirection;
					tunnelDirectionFailures = 1;
				}
			}
			escapeWall = null;
			escapeWallSince = -1;
			CraftMateBodyClient.LOGGER.info(
				"CraftMate tunnel abort reason={} pos={}",
				reason,
				client.player.position()
			);
			finish(id, "failed", "E_STUCK", reason);
		}

		/**
		 * Extend the floor across a same-level gap. The body must stand on a
		 * solid edge block, face the gap, and right-click the side of the
		 * support block underfoot. Each confirmed placement is followed by
		 * one deliberate step onto the new block; the body never walks into
		 * an unconfirmed air cell.
		 */
		private boolean beginBridgeStep(Minecraft client, LocalPlayer player) {
			if (!player.onGround() || buildingSlot(client, player) < 0) return false;
			BlockPos feet = player.blockPosition();
			BlockPos feetSupport = feet.below();
			BlockPos support = client.level.getBlockState(feetSupport).blocksMotion()
				? feetSupport
				: supportBlock(client, player).pos();
			if (!client.level.getBlockState(support).blocksMotion()) return false;
			Vec3 toward = target.subtract(player.position());
			double horizontal = Math.hypot(toward.x, toward.z);
			if (horizontal < 2.0) return false;
			Direction best = null;
			int bestGap = 0;
			BlockPos bestFar = null;
			double bestScore = Double.POSITIVE_INFINITY;
			for (Direction direction : Direction.Plane.HORIZONTAL) {
				double alignment =
					(direction.getStepX() * toward.x + direction.getStepZ() * toward.z)
						/ horizontal;
				if (alignment < 0.35) continue;
				BlockPos first = feet.relative(direction);
				if (standableAt(client, first)) continue;
				BlockPos floor = first.below();
				if (!client.level.getBlockState(floor).canBeReplaced()) continue;
				if (!client.level.getBlockState(floor).getFluidState().isEmpty()) continue;
				if (!bodySpaceAt(client, first)) continue;
				BlockPos far = null;
				int gap = 0;
				// A river or a ravine is often wider than the four-block
				// window the first bridge prototype used. The body crosses
				// one confirmed block at a time, so the scan can look much
				// farther without ever stepping onto unproven air.
				for (int step = 1; step <= 12; step++) {
					BlockPos cell = feet.relative(direction, step);
					if (!bodySpaceAt(client, cell)) break;
					BlockPos cellFloor = cell.below();
					if (!client.level.getBlockState(cellFloor).canBeReplaced()) break;
					if (!client.level.getBlockState(cellFloor).getFluidState().isEmpty()) break;
					gap = step;
					BlockPos landing = feet.relative(direction, step + 1);
					if (standableAt(client, landing) && bodySpaceAt(client, landing)) {
						far = landing;
						break;
					}
				}
				if (far == null || gap < 1 || gap > 12) continue;
				double score = -alignment + gap * 0.05;
				if (score < bestScore) {
					bestScore = score;
					best = direction;
					bestGap = gap;
					bestFar = far;
				}
			}
			if (best == null) return false;
			bridgeDirection = best;
			bridgeSupport = support;
			bridgePlace = feet.relative(best).below();
			bridgeGap = bestGap;
			bridgeTarget = bestFar;
			bridgeStartedAt = age;
			bridgeSubmittedAt = -1;
			bridgeBlocks = 0;
			bridging = true;
			CraftMateBodyClient.LOGGER.info(
				"CraftMate bridge start feet={} direction={} gap={} far={} place={} support={}",
				feet,
				best,
				bestGap,
				bestFar,
				bridgePlace,
				bridgeSupport
			);
			showStatus(client, "前方有缺口，开始垫方块");
			return true;
		}

		private void tickBridge(Minecraft client, LocalPlayer player) {
			if (bridgeDirection == null || bridgeSupport == null || bridgePlace == null) {
				bridgeAbort(client, "bridge state is incomplete");
				return;
			}
			if (age - bridgeStartedAt > 20 * 6) {
				bridgeAbort(client, "bridge did not finish in time");
				return;
			}
			if (!client.level.getBlockState(bridgePlace).canBeReplaced()) {
				// The prediction is solid, but only a step onto its top proves
				// the server accepted it. Walk forward while staying aligned.
				Vec3 center = new Vec3(
					bridgePlace.getX() + 0.5,
					bridgePlace.getY() + 1.0,
					bridgePlace.getZ() + 0.5
				);
				double dx = center.x - player.getX();
				double dz = center.z - player.getZ();
				float heading = (float) Math.toDegrees(Math.atan2(-dx, dz));
				boolean aligned = turnTowards(player, heading);
				CameraController.steerHeading(
					player,
					player.getYRot(),
					CameraController.displayPitch(player)
				);
				setWalkInput(client, aligned);
				if (aligned && Math.hypot(dx, dz) < 0.45 && player.onGround()) {
					bridgeBlocks++;
					releaseWalkInput(client);
					bridgeSubmittedAt = -1;
					send.accept(progress(id, "bridging", bridgeBlocks, 4));
					Route route = firstSafeRoute(client, player);
					// A partial route still stops at the next edge. Follow it
					// only when it actually finishes the walk; otherwise keep
					// laying floor so a multi-block gap is crossed in one
					// bridge run instead of one block per planner decision.
					if (route != null && route.complete()) {
						bridging = false;
						bridgeClear();
						escapingNoRoute = false;
						followRoute(client, player, route);
						return;
					}
					if (bridgeTarget != null && player.blockPosition().equals(bridgeTarget)) {
						bridging = false;
						bridgeClear();
						escapingNoRoute = false;
						tickEscape(client, player);
						return;
					}
					bridgeDirection = null;
					bridgeSupport = null;
					bridgePlace = null;
					bridgeTarget = null;
					bridging = false;
					if (beginBridgeStep(client, player)) return;
					bridgeAbort(client, "no adjacent gap remains on the bridge line");
				}
				return;
			}
			if (bridgeSubmittedAt >= 0 && age - bridgeSubmittedAt > 20 * 2) {
				bridgeAbort(client, "the server rejected the bridge placement");
				return;
			}
			if (!player.onGround()) {
				releaseWalkInput(client);
				return;
			}
			releaseWalkInput(client);
			Vec3 faceCenter = new Vec3(
				bridgeSupport.getX() + 0.5 + bridgeDirection.getStepX() * 0.5,
				bridgeSupport.getY() + 0.35,
				bridgeSupport.getZ() + 0.5 + bridgeDirection.getStepZ() * 0.5
			);
			CameraController.steerTo(player, faceCenter);
			// The support block is directly underfoot, so a look ray from the
			// eye enters through its top face and never reaches the side face.
			// The body still looks at the edge, but the interaction names the
			// side explicitly. The server validates reach and the adjacent
			// replaceable cell, which is what a human bridging click does.
			if (!client.level.getBlockState(bridgePlace).canBeReplaced()) {
				return;
			}
			BlockHitResult hit = new BlockHitResult(
				faceCenter,
				bridgeDirection,
				bridgeSupport,
				false
			);
			int slot = buildingSlot(client, player);
			if (slot < 0) {
				bridgeAbort(client, "ran out of building blocks while bridging");
				return;
			}
			player.getInventory().selected = slot;
			client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, hit);
			bridgeSubmittedAt = age;
			send.accept(progress(id, "bridging", bridgeBlocks, 4));
		}

		private void bridgeAbort(Minecraft client, String reason) {
			releaseWalkInput(client);
			bridgeClear();
			bridging = false;
			finish(id, "failed", "E_STUCK", reason);
		}

		private void bridgeClear() {
			bridgeDirection = null;
			bridgeSupport = null;
			bridgePlace = null;
			bridgeTarget = null;
			bridgeSubmittedAt = -1;
		}

		/**
		 * A land pathfinder deliberately refuses water, and `safeRouteEnd`
		 * refuses to start while the player is airborne. In water those two
		 * rules combine into a permanent "no safe route": the body bobs at the
		 * surface until the command expires. Swim upward, aim at the nearest
		 * dry standable cell, and let the normal route planner take over once
		 * the body has solid ground again.
		 */
		private void tickSwim(Minecraft client, LocalPlayer player) {
			swimTicks++;
			swimLastPosition = player.position();
			if (swimTarget == null || !standableAt(
				client,
				BlockPos.containing(swimTarget)
			)) {
				Vec3 shore = findShore(client, player, 10);
				/*
				 * A ten-block scan is enough for a river bank or a flooded
				 * shaft, but not for a bay. Scan farther at most once per
				 * second so a body that was carried into open water can pick
				 * the visible island instead of treading until the timeout.
				 */
				if (shore == null && swimTicks % 20 == 1) {
					shore = findShore(client, player, 32);
				}
				if (shore != null) {
					swimTarget = shore;
				} else if (target.y >= player.getY() - 1.0) {
					/*
					 * Open water has no dry cell inside the ten-block shore
					 * scan. Treading water there never reaches land: the old
					 * branch waited twenty seconds and failed with "could not
					 * find a nearby shore", then the planner re-issued the
					 * same command. A human swims across the bay toward the
					 * destination; do the same and let the shore scan take
					 * over as soon as a beach is close. Underground targets
					 * keep the pillar/dig-escape path below.
					 */
					swimTarget = new Vec3(target.x, player.getY(), target.z);
				} else {
					swimTarget = null;
				}
				swimBestDistance = Double.POSITIVE_INFINITY;
			}
			if (swimTarget == null) {
				client.options.keyJump.setDown(true);
				setSwimInput(client, false);
				if (swimTicks % 20 == 0) send.accept(progress(id, "swimming", 0, 1));
				// A flooded cave can be farther than ten blocks from dry land.
				// Treading water until the command deadline only loses air;
				// start a pillar or ceiling cut on the first second and repeat
				// it, so a re-issued goto can still make vertical progress.
				if (!mode.isWalk() && swimTicks >= 20) {
					if (pillarInWater(client, player)) {
						swimStalledTicks = 0;
						send.accept(progress(id, "bridging", 0, 1));
						return;
					}
					if (digSwimOut(client, player)) {
						swimStalledTicks = 0;
						send.accept(progress(id, "unstick", 0, 1));
						return;
					}
				}
				/*
				 * A body floating at the surface of a roofed pond cannot
				 * reach any shore, and waiting twenty seconds only delays the
				 * planner's recovery card. Give up after six surfaced
				 * seconds; a submerged body keeps the full budget because it
				 * may still be rising from the bottom of a lake.
				 */
				boolean surfaced = !player.isEyeInFluid(FluidTags.WATER);
				if (swimTicks > (surfaced ? 20 * 6 : 20 * 20)) {
					finish(
						id,
						"failed",
						mode.isWalk() ? "E_UNREACHABLE" : "E_PRECONDITION",
						"could not find a nearby shore"
					);
				}
				return;
			}
			// Bobbing at the surface changes the raw position every tick while
			// making no progress at all. Measure the distance that matters:
			// how close the body is to the dry cell it is trying to reach.
			double dx = swimTarget.x - player.getX();
			double dz = swimTarget.z - player.getZ();
			double targetDistance = Math.hypot(dx, dz)
				+ Math.max(0.0, swimTarget.y - player.getY()) * 0.5;
			if (targetDistance + 0.2 < swimBestDistance) {
				swimBestDistance = targetDistance;
				swimStalledTicks = 0;
			} else {
				swimStalledTicks++;
			}
			/*
			 * Ordinary walking may not mine or pillar, so a body pressed
			 * into a flooded wall has nothing useful left to try. Report the
			 * failure after two seconds instead of treading until the
			 * twenty-second budget; the deterministic planner can then hand
			 * the pocket to `recovery.escape`.
			 */
			if (mode.isWalk() && swimStalledTicks >= 40) {
				finish(
					id,
					"failed",
					"E_UNREACHABLE",
					"swimming made no progress toward a shore"
				);
				return;
			}
			if (swimTicks % 20 == 0) {
				CraftMateBodyClient.LOGGER.info(
					"CraftMate swim state pos={} target={} distance={} best={} ticks={} stalled={} delta={} hcoll={} eyeWater={}",
					player.position(),
					swimTarget,
					targetDistance,
					swimBestDistance,
					swimTicks,
					swimStalledTicks,
					player.getDeltaMovement(),
					player.horizontalCollision,
					player.isEyeInFluid(FluidTags.WATER)
				);
			}
			// Being in water is not enough to guarantee a way out. A body can
			// sit in a one-cell flooded shaft with a solid ceiling and walls:
			// swimming presses into the wall forever while the shore search
			// keeps returning a target it cannot reach. A human would mine the
			// wall or ceiling. Do that after one second without displacement,
			// then let the escape-wall branch finish the destroy and swim
			// through the opening.
			if (!mode.isWalk() && swimStalledTicks >= 12) {
				// A flooded shaft has no ledge to swim onto. Jump, then place
				// the block under the feet at the apex; repeat to rise one
				// block at a time. This is the water version of pillaring and
				// is much more reliable than bobbing against a four-block-high
				// bank.
				if (pillarInWater(client, player)) {
					swimStalledTicks = 0;
					swimBestDistance = Double.POSITIVE_INFINITY;
					send.accept(progress(id, "bridging", 0, 1));
					return;
				}
				if (digSwimOut(client, player)) {
					swimStalledTicks = 0;
					swimBestDistance = Double.POSITIVE_INFINITY;
					send.accept(progress(id, "unstick", 0, 1));
					return;
				}
			}
			float heading = (float) Math.toDegrees(Math.atan2(-dx, dz));
			boolean aligned = turnTowards(player, heading);
			CameraController.steerHeading(player, player.getYRot(), 0.0f);
			setSwimInput(client, aligned);
			if (player.onGround() && !player.isInWater()) {
				swimming = false;
				swimTarget = null;
				swimTicks = 0;
				swimLastPosition = null;
				swimStalledTicks = 0;
				swimBestDistance = Double.POSITIVE_INFINITY;
				releaseWalkInput(client);
				// The original route was never installed because the body was
				// already in water when the command arrived. Re-plan from the
				// dry landing cell so the same command continues inland.
				planRoute(client);
				return;
			}
			if (swimTicks % 20 == 0) send.accept(progress(id, "swimming", 0, 1));
		}

		/**
		 * Water pillaring. The target is the replaceable water cell directly
		 * below the feet; clicking the top face of the solid block beneath it
		 * places a floor under the body while it is above the cell. The body
		 * lands on that floor, jumps again, and repeats.
		 */
		private boolean pillarInWater(Minecraft client, LocalPlayer player) {
			if (age - swimPillarAt < 10) return false;
			int slot = buildingSlot(client, player);
			if (slot < 0) return false;
			BlockPos feet = player.blockPosition();
			BlockPos target = feet.below();
			BlockState cell = client.level.getBlockState(target);
			if (!cell.canBeReplaced() && cell.getFluidState().isEmpty()) return false;
			BlockPos support = target.below();
			if (!client.level.getBlockState(support).blocksMotion()) return false;
			if (player.getY() < target.getY() + 1.06) return false;
			player.getInventory().selected = slot;
			Vec3 centre = Vec3.atCenterOf(support);
			CameraController.steerTo(player, centre);
			BlockHitResult hit = BlockInteraction.hit(support, Direction.UP);
			client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, hit);
			swimPillarAt = age;
			CraftMateBodyClient.LOGGER.info(
				"CraftMate swim pillar target={} support={} feet={} y={} slot={}",
				target,
				support,
				feet,
				player.getY(),
				slot
			);
			return true;
		}

		/**
		 * Open one cell out of a flooded pocket. Horizontal walls are tried
		 * first because they preserve the water surface and let the body swim
		 * toward land; the ceiling is the last resort for a vertical shaft.
		 */
		private boolean digSwimOut(Minecraft client, LocalPlayer player) {
			BlockPos feet = player.blockPosition();
			Vec3 toward = target.subtract(player.position());
			double horizontal = Math.hypot(toward.x, toward.z);
			// A flooded shaft often has a dry ledge several blocks above the
			// water. In that geometry mining another side wall just moves the
			// bubble sideways; open the ceiling first and rise toward daylight.
			if (
				swimTarget != null
					&& swimTarget.y - player.getY() > 1.0
					&& mineSwimCeiling(client, player, feet)
			) {
				return true;
			}
			List<Direction> directions = new ArrayList<>();
			for (Direction direction : Direction.Plane.HORIZONTAL) {
				directions.add(direction);
			}
			directions.sort(
				(left, right) -> Double.compare(
					alignment(right, toward, horizontal),
					alignment(left, toward, horizontal)
				)
			);
			for (Direction direction : directions) {
				BlockPos wall = feet.relative(direction);
				BlockPos headWall = wall.above();
				if (
					client.level.getBlockState(wall).blocksMotion()
						&& breakEscapeWall(client, player, wall)
				) {
					CraftMateBodyClient.LOGGER.info(
						"CraftMate swim dig wall={} direction={} state={} player={}",
						wall,
						direction,
						client.level.getBlockState(wall),
						player.position()
					);
					return true;
				}
				if (
					client.level.getBlockState(headWall).blocksMotion()
						&& breakEscapeWall(client, player, headWall)
				) {
					CraftMateBodyClient.LOGGER.info(
						"CraftMate swim dig headWall={} direction={} state={} player={}",
						headWall,
						direction,
						client.level.getBlockState(headWall),
						player.position()
					);
					return true;
				}
			}
			return mineSwimCeiling(client, player, feet);
		}

		private boolean mineSwimCeiling(
			Minecraft client,
			LocalPlayer player,
			BlockPos feet
		) {
			BlockPos ceiling = feet.above(2);
			BlockState state = client.level.getBlockState(ceiling);
			if (state.blocksMotion() && breakEscapeWall(client, player, ceiling)) {
				CraftMateBodyClient.LOGGER.info(
					"CraftMate swim dig ceiling={} state={} player={}",
					ceiling,
					state,
					player.position()
				);
				return true;
			}
			return false;
		}

		private static double alignment(Direction direction, Vec3 toward, double horizontal) {
			if (horizontal < 1.0e-4) return 0.0;
			return (
				direction.getStepX() * toward.x + direction.getStepZ() * toward.z
			) / horizontal;
		}

		/**
		 * The nearest dry block column the body can stand in after surfacing.
		 * Scanning a small horizontal ring keeps the search bounded and gives
		 * a river or pond an obvious exit instead of a random swim direction.
		 */
		private static Vec3 findShore(
			Minecraft client,
			LocalPlayer player,
			int maxRadius
		) {
			BlockPos feet = player.blockPosition();
			Vec3 best = null;
			double bestScore = Double.POSITIVE_INFINITY;
			for (int radius = 1; radius <= maxRadius; radius++) {
				for (int dx = -radius; dx <= radius; dx++) {
					for (int dz = -radius; dz <= radius; dz++) {
						if (Math.max(Math.abs(dx), Math.abs(dz)) != radius) continue;
						for (int dy = 0; dy <= 5; dy++) {
							BlockPos candidate = feet.offset(dx, dy, dz);
							if (!standableAt(client, candidate)) continue;
							double score = Math.hypot(dx, dz) + dy * 0.2;
							if (score < bestScore) {
								bestScore = score;
								best = new Vec3(
									candidate.getX() + 0.5,
									candidate.getY(),
									candidate.getZ() + 0.5
								);
							}
						}
					}
				}
			}
			return best;
		}

		private void followRoute(Minecraft client, LocalPlayer player, Route route) {
			destination = route.destination();
			routeComplete = route.complete();
			waypoints = route.waypoints();
			waypointIndex = waypoints.size() > 1 ? 1 : 0;
			lastWaypointIndex = waypointIndex;
			lastWaypointDistance = playerDistance(player);
			nextReplanAt = 0;
			escapingNoRoute = false;
			send.accept(progress(id, "walking", 0, 1));
		}

		/**
		 * Pick a direction whose floor block can become the next stair step,
		 * and whose two cells above it can be cleared. Prefer the direction
		 * that points at the requested target so the staircase is not a
		 * random spiral.
		 */
		private boolean beginClimbStep(Minecraft client, LocalPlayer player) {
			if (!player.onGround()) return false;
			BlockPos feet = player.blockPosition();
			Vec3 toward = target.subtract(player.position());
			double horizontal = Math.hypot(toward.x, toward.z);
			if (horizontal < 1.0e-4) horizontal = 1.0;
			Direction best = null;
			double bestScore = Double.POSITIVE_INFINITY;
			for (Direction direction : Direction.Plane.HORIZONTAL) {
				BlockPos step = feet.relative(direction);
				BlockState stepState = client.level.getBlockState(step);
				if (!stepState.blocksMotion()) continue;
				if (playerFacility(stepState)) continue;
				if (!stepState.getFluidState().isEmpty()) continue;
				if (stepState.getDestroySpeed(client.level, step) < 0.0f) continue;
				if (removesCurrentSupport(player, step)) continue;
				BlockPos head = step.above();
				BlockPos above = head.above();
				BlockPos headroom = feet.above(2);
				if (!climbCellBreakable(client, player, head)) continue;
				if (!climbCellBreakable(client, player, above)) continue;
				if (!climbCellBreakable(client, player, headroom)) continue;
				if (fluidWithin(client, above, 3)) continue;
				double alignment =
					(direction.getStepX() * toward.x + direction.getStepZ() * toward.z)
						/ horizontal;
				double score = -alignment;
				if (score < bestScore) {
					bestScore = score;
					best = direction;
				}
			}
			if (best == null) return false;
			climbDirection = best;
			climbStep = feet.relative(best);
			climbHead = climbStep.above();
			climbAbove = climbHead.above();
			climbMining = null;
			// A two-block-high tunnel cannot jump onto a one-block step: the
			// body's head hits the ceiling above its *current* column. Clear
			// that headroom first, even though the destination column is open.
			BlockPos currentCeiling = feet.above(2);
			climbObstruction = client.level.getBlockState(currentCeiling).isAir()
				? null
				: currentCeiling;
			climbStartY = feet.getY();
			climbStepAt = age;
			climbLastProgressAt = age;
			climbLastDistance = Math.hypot(
				Vec3.atCenterOf(climbStep).x - player.getX(),
				Vec3.atCenterOf(climbStep).z - player.getZ()
			);
			climbEquipAt = -1;
			CraftMateBodyClient.LOGGER.info(
				"CraftMate stair up from={} step={} direction={}",
				player.position(),
				climbStep,
				best
			);
			return true;
		}

		private boolean climbCellBreakable(
			Minecraft client,
			LocalPlayer player,
			BlockPos pos
		) {
			BlockState state = client.level.getBlockState(pos);
			return state.getFluidState().isEmpty()
				&& !playerFacility(state)
				&& state.getDestroySpeed(client.level, pos) >= 0.0f
				&& (
					!state.requiresCorrectToolForDrops()
						|| hasCorrectToolInInventory(player, state)
				);
		}

		private static boolean fluidWithin(Minecraft client, BlockPos pos, int depth) {
			for (int offset = 1; offset <= depth; offset++) {
				if (!client.level.getBlockState(pos.above(offset)).getFluidState().isEmpty()) {
					return true;
				}
			}
			return false;
		}

		private void tickClimb(Minecraft client, LocalPlayer player) {
			if (age - climbStepAt > 20 * 45) {
				abortClimb(client, "staircase step made no progress");
				return;
			}
			if (climbStep == null) return;
			BlockPos climbFeet = player.blockPosition();
			// The selected step belongs to the feet level at planning time.
			// Falling one block (or losing the support block under it) leaves
			// a target that is now two blocks above the body; jumping at it
			// forever is the observed staircase rubber-band. Re-plan instead.
			if (climbFeet.getY() < climbStartY) {
				if (!StairEscape.canRetryAfterFall(
					climbFeet.getY(),
					climbStartY,
					climbFallbacks
				)) {
					abortClimb(client, "staircase lost its step level");
					return;
				}
				climbFallbacks++;
				releaseMiningInput(client);
				releaseWalkInput(client);
				climbStep = null;
				climbHead = null;
				climbAbove = null;
				climbMining = null;
				climbObstruction = null;
				climbStepAt = age;
				climbLastProgressAt = age;
				CraftMateBodyClient.LOGGER.info(
					"CraftMate stair retry after fall pos={} feet={} startY={} retries={}",
					player.position(),
					climbFeet,
					climbStartY,
					climbFallbacks
				);
				return;
			}
			if (
				player.onGround()
					&& climbFeet.getY() == climbStartY
					&& !client.level.getBlockState(climbStep).blocksMotion()
			) {
				abortClimb(client, "staircase step disappeared");
				return;
			}
			double climbDistance = Math.hypot(
				Vec3.atCenterOf(climbStep).x - player.getX(),
				Vec3.atCenterOf(climbStep).z - player.getZ()
			);
			if (climbDistance + 0.12 < climbLastDistance) {
				climbLastDistance = climbDistance;
				climbLastProgressAt = age;
			}
			// Breaking a stone head cell with a bare hand takes about 7.5
			// seconds, and a step can need two of them. Mining is progress
			// even while the body stands still, so only use the short stall
			// window when no block is actively being destroyed.
			int stallLimit = climbMining == null ? 20 * 6 : 20 * 15;
			if (age - climbLastProgressAt > stallLimit) {
				abortClimb(client, "staircase approach made no progress");
				return;
			}
			if (
				climbMining != null
					&& client.level.getBlockState(climbMining).isAir()
			) {
				if (client.gameMode.isDestroying()) client.gameMode.stopDestroyBlock();
				climbMining = null;
				if (climbObstruction != null && client.level.getBlockState(climbObstruction).isAir()) {
					climbObstruction = null;
				}
				climbStepAt = age;
				climbLastProgressAt = age;
			}
			if (player.blockPosition().getY() > climbStartY && player.onGround()) {
				climbStep = null;
				climbHead = null;
				climbAbove = null;
				climbMining = null;
				climbObstruction = null;
				climbSteps++;
				climbFallbacks = 0;
				releaseWalkInput(client);
				send.accept(progress(id, "climbing", climbSteps, 16));
				return;
			}
			if (
				climbObstruction != null
					&& !StairEscape.obstructionNeedsWork(
						client.level.getBlockState(climbObstruction).isAir()
					)
			) {
				if (client.gameMode.isDestroying()) client.gameMode.stopDestroyBlock();
				climbMining = null;
				climbObstruction = null;
			}
			if (age % 20 == 0) {
				CraftMateBodyClient.LOGGER.info(
					"CraftMate climb state pos={} feet={} y={} startY={} onGround={} step={} head={} above={} obstruction={} mining={}",
					player.position(),
					player.blockPosition(),
					player.getY(),
					climbStartY,
					player.onGround(),
					climbStep,
					climbHead == null ? null : client.level.getBlockState(climbHead),
					climbAbove == null ? null : client.level.getBlockState(climbAbove),
					climbObstruction,
					climbMining
				);
			}
			BlockPos aim = climbObstruction;
			if (aim == null && !client.level.getBlockState(climbHead).isAir()) {
				aim = climbHead;
			} else if (aim == null && !client.level.getBlockState(climbAbove).isAir()) {
				aim = climbAbove;
			}
			if (aim != null) {
				mineClimbBlock(client, player, aim);
				if (age % 20 == 0) {
					send.accept(progress(id, "climbing", climbSteps, 16));
				}
				return;
			}
			// Both head cells are open. Jump and walk onto the one-block step.
			Vec3 center = Vec3.atCenterOf(climbStep);
			double dx = center.x - player.getX();
			double dz = center.z - player.getZ();
			float heading = (float) Math.toDegrees(Math.atan2(-dx, dz));
			boolean aligned = turnTowards(player, heading);
			CameraController.steerHeading(
				player,
				player.getYRot(),
				CameraController.displayPitch(player)
			);
			setWalkInput(client, aligned);
			if (player.onGround()) player.jumpFromGround();
			if (age % 20 == 0) {
				send.accept(progress(id, "climbing", climbSteps, 16));
			}
		}

		private void mineClimbBlock(Minecraft client, LocalPlayer player, BlockPos pos) {
			BlockState state = client.level.getBlockState(pos);
			if (state.isAir()) {
				climbMining = null;
				if (pos.equals(climbObstruction)) climbObstruction = null;
				return;
			}
			if (!state.getFluidState().isEmpty()) {
				abortClimb(client, "staircase exposed fluid");
				return;
			}
			if (playerFacility(state)) {
				abortClimb(client, "staircase target is a player facility");
				return;
			}
			int tool = -1;
			if (state.requiresCorrectToolForDrops()) {
				tool = bestToolSlot(player, state);
				if (tool < 0) {
					if (climbEquipAt < 0) {
						climbEquipAt = age;
						if (!equipClimbToolFromInventory(client, state)) {
							abortClimb(
								client,
								"no carried tool can harvest the staircase block "
									+ state.getBlock()
							);
							return;
						}
						return;
					}
					if (age - climbEquipAt < 20) return;
					climbEquipAt = -1;
					abortClimb(
						client,
						"could not equip a tool for the staircase block "
							+ state.getBlock()
					);
					return;
				}
				if (tool >= 0) {
					climbEquipAt = -1;
					player.getInventory().selected = tool;
				}
			}
			BlockHitResult hit = BlockInteraction.nearestExposedHit(
				client.level,
				player.getEyePosition(),
				pos
			);
			CameraController.steerTo(player, Vec3.atCenterOf(pos));
			if (!hit.getBlockPos().equals(pos)) {
				if (retargetClimbObstruction(client, player, pos, hit)) return;
				abortClimb(
					client,
					"staircase target is obstructed at " + hit.getBlockPos()
				);
				return;
			}
			// Keep a retargeted blocker as the active mining target until it
			// turns into air. Clearing it here made the next tick aim back at
			// the hidden staircase cell, reset destroy progress, and alternate
			// forever without ever breaking the roof block.
			if (pos.equals(climbObstruction)) {
				mineClimbHit(client, player, pos, hit);
				return;
			}
			climbObstruction = null;
			mineClimbHit(client, player, pos, hit);
		}

		/**
		 * The eye ray is the authority on what the body can actually destroy.
		 * If it hits a breakable neighbour instead of the intended head cell,
		 * clear that neighbour first. This is the same choice a player makes
		 * at a diagonal cave corner and avoids a terminal failure caused only
		 * by the shape of the terrain.
		 */
		private boolean retargetClimbObstruction(
			Minecraft client,
			LocalPlayer player,
			BlockPos intended,
			BlockHitResult hit
		) {
			if (hit.getType() != HitResult.Type.BLOCK) return false;
			BlockPos blocker = hit.getBlockPos();
			if (blocker.equals(intended)) return false;
			BlockState blockerState = client.level.getBlockState(blocker);
			if (!withinInteractionRange(player, blocker)) return false;
			boolean correctTool =
				!blockerState.requiresCorrectToolForDrops()
					|| hasCorrectToolInInventory(player, blockerState);
			if (
				!StairEscape.canClearSightBlocker(
					blockerState.blocksMotion(),
					!blockerState.getFluidState().isEmpty(),
					blockerState.getDestroySpeed(client.level, blocker),
					blockerState.requiresCorrectToolForDrops(),
					correctTool
				)
			) return false;
			if (!blocker.equals(climbObstruction)) {
				if (client.gameMode.isDestroying()) client.gameMode.stopDestroyBlock();
				climbMining = null;
				CraftMateBodyClient.LOGGER.info(
					"CraftMate stair obstruction target={} blocker={} state={} face={} eye={}",
					intended,
					blocker,
					blockerState,
					hit.getDirection(),
					player.getEyePosition()
				);
			}
			climbObstruction = blocker;
			mineClimbHit(client, player, blocker, hit);
			return true;
		}

		private void mineClimbHit(
			Minecraft client,
			LocalPlayer player,
			BlockPos pos,
			BlockHitResult hit
		) {
				BlockState state = client.level.getBlockState(pos);
				// Retargeting a sight blocker bypasses mineClimbBlock's equip
				// step. Without this guard a pickaxe still in the main
				// inventory is "available" to the planner while the fist is
				// what actually grinds the stone.
				if (state.requiresCorrectToolForDrops()) {
					int tool = bestToolSlot(player, state);
					if (tool < 0) {
						if (client.gameMode.isDestroying()) client.gameMode.stopDestroyBlock();
						climbMining = null;
						if (climbEquipAt < 0) {
							climbEquipAt = age;
							if (equipClimbToolFromInventory(client, state)) {
								CraftMateBodyClient.LOGGER.info(
									"CraftMate climb obstruction lift tool target={} state={}",
									pos,
									state
								);
							} else {
								climbEquipAt = -1;
								abortClimb(
									client,
									"no carried tool can harvest the staircase obstruction "
										+ state.getBlock()
								);
							}
							return;
						}
						if (age - climbEquipAt < 20) return;
						climbEquipAt = -1;
						abortClimb(
							client,
							"could not equip a tool for the staircase obstruction "
								+ state.getBlock()
						);
						return;
					}
					climbEquipAt = -1;
					player.getInventory().selected = tool;
				}
			aimBodyAt(player, hit.getLocation());
			if (climbMining == null || !climbMining.equals(pos)) {
				if (client.gameMode.isDestroying()) client.gameMode.stopDestroyBlock();
				client.gameMode.startDestroyBlock(pos, hit.getDirection());
				climbMining = pos;
				climbLastProgressAt = age;
			} else {
				client.gameMode.continueDestroyBlock(pos, hit.getDirection());
			}
			CameraController.steerTo(player, Vec3.atCenterOf(pos));
			client.hitResult = hit;
			holdMiningInput(client);
		}

		/**
		 * A respawn can leave the only pickaxe in the main inventory. Swapping
		 * it into the hotbar is the same ordinary action a player performs;
		 * failing the whole escape because the hotbar is empty is not.
		 */
		private boolean equipClimbToolFromInventory(Minecraft client, BlockState state) {
			return equipEscapeToolFromInventory(client, state);
		}

		private void abortClimb(Minecraft client, String reason) {
			releaseMiningInput(client);
			releaseWalkInput(client);
			climbStep = null;
			climbHead = null;
			climbAbove = null;
			climbMining = null;
			climbObstruction = null;
			escapingNoRoute = false;
			CraftMateBodyClient.LOGGER.info(
				"CraftMate stair abort reason={} pos={}",
				reason,
				client.player.position()
			);
			finish(id, "failed", "E_STUCK", reason);
		}

		private int buildingSlot(Minecraft client, LocalPlayer player) {
			int best = -1;
			int bestScore = Integer.MIN_VALUE;
			// A mining trip leaves spare dirt and planks in the main inventory,
			// while the hotbar is often full of cobblestone. Refusing to look
			// past the hotbar made an otherwise safe dirt pillar fail with
			// "tool=false" and trapped the body under a stone ceiling.
			for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (stack.isEmpty()) continue;
				if (!(stack.getItem() instanceof BlockItem item)) continue;
				Block block = item.getBlock();
				BlockState state = block.defaultBlockState();
				if (!state.isSolid()) continue;
				// Never turn the workbench, furnace, chest or bed into a
				// disposable pillar block. Those are the stations the next
				// survival step needs, and a retreat must not destroy them.
				if (playerFacility(state)) continue;
				if (block instanceof FallingBlock) continue;
				boolean recoverable =
					!state.requiresCorrectToolForDrops()
						|| hasCorrectToolInInventory(player, state);
				int score = Math.min(64, stack.getCount());
				if (block == Blocks.COBBLESTONE || block == Blocks.STONE) score += 100;
				else if (block == Blocks.DIRT || block == Blocks.GRASS_BLOCK) score += 80;
				else if (block == Blocks.DEEPSLATE || block == Blocks.ANDESITE) score += 60;
				// A pillar is only safe if the body can take it apart again.
				// Without a pickaxe, dirt is worth more than a stack of
				// cobblestone that would trap the body on top of it.
				score += recoverable ? 40 : -400;
				if (score > bestScore) {
					bestScore = score;
					best = slot;
				}
			}
			if (best < 9) return best;
			int hotbar = MineTask.toolHotbarSlot(player);
			player.getInventory().selected = hotbar;
			player.connection.send(new ServerboundSetCarriedItemPacket(hotbar));
			client.gameMode.handleInventoryMouseClick(
				player.inventoryMenu.containerId,
				best,
				hotbar,
				ClickType.SWAP,
				player
			);
			return hotbar;
		}

		private boolean beginCeilingPillar(Minecraft client, LocalPlayer player) {
			if (!mode.mayBuild()) return false;
			if (!player.onGround()) return false;
			int slot = buildingSlot(client, player);
			if (slot < 0) return false;
			BlockPos feet = player.blockPosition();
			BlockState ceilingState = client.level.getBlockState(feet.above(2));
			ItemStack building = player.getInventory().getItem(slot);
			BlockState buildingState = building.getItem() instanceof BlockItem item
				? item.getBlock().defaultBlockState()
				: null;
			boolean skyAbove = client.level.canSeeSky(feet.above(2));
			boolean canBreakBuilding =
				buildingState != null
					&& ToolSelection.canHarvest(
						buildingState.requiresCorrectToolForDrops(),
						hasCorrectToolInInventory(player, buildingState)
					);
			if (!ShaftEscape.canRecoverFromPillar(skyAbove, canBreakBuilding)) {
				CraftMateBodyClient.LOGGER.info(
					"CraftMate ceiling pillar refused feet={} ceiling={} building={} tool={}",
					feet,
					ceilingState,
					buildingState,
					buildingState != null && hasCorrectToolInInventory(player, buildingState)
				);
				return false;
			}
			CraftMateBodyClient.LOGGER.info(
				"CraftMate ceiling probe feet={} ceiling={} state={} slot={}",
				player.blockPosition(),
				player.blockPosition().above(2),
				ceilingState,
				slot
			);
			ceilingActive = true;
			ceilingPlacing = false;
			ceilingMine = null;
			ceilingCenter = Vec3.atCenterOf(player.blockPosition());
			ceilingCenterSince = -1;
			pillarPlacedAt = null;
			pillarRetreat = false;
			pillarRetreatMining = false;
			climbMining = null;
			if (!pillarHasEscapeHeadroom(client, player, feet)) {
				CraftMateBodyClient.LOGGER.info(
					"CraftMate ceiling no headroom feet={} third={} fourth={}",
					feet,
					client.level.getBlockState(feet.above(2)),
					client.level.getBlockState(feet.above(3))
				);
				ceilingActive = false;
				ceilingPlacing = false;
				return false;
			}
			if (!prepareCeiling(client, player)) {
				ceilingActive = false;
				return false;
			}
			int walls = 0;
			for (Direction direction : Direction.Plane.HORIZONTAL) {
				if (
					isRecoveryBarrier(client.level.getBlockState(feet.relative(direction)))
						|| isRecoveryBarrier(
							client.level.getBlockState(feet.above().relative(direction))
						)
				) {
					walls++;
				}
			}
			boolean solidCeiling =
				ceilingMine != null &&
				isRecoveryBarrier(client.level.getBlockState(ceilingMine));
			if (!ShaftEscape.shouldStartPillar(solidCeiling, walls)) {
				ceilingActive = false;
				ceilingPlacing = false;
				return false;
			}
			CraftMateBodyClient.LOGGER.info(
				"CraftMate ceiling pillar from={} ceiling={}",
				player.position(),
				ceilingMine
			);
			return true;
		}

		/**
		 * One jump-place step needs four clear blocks: the current feet and
		 * head, the cell that becomes the new floor, and the cell above the
		 * new head. A three-block pocket lets the body place one block and
		 * then traps it under the stone ceiling, so do not start there.
		 */
		private boolean pillarHasEscapeHeadroom(
			Minecraft client,
			LocalPlayer player,
			BlockPos feet
		) {
			BlockPos fourthPos = feet.above(3);
			BlockState fourth = client.level.getBlockState(fourthPos);
			if (!fourth.getFluidState().isEmpty()) return false;
			if (!fourth.blocksMotion()) return true;
			// The emergency-shelter cap sits exactly at head plus three. It
			// used to make every pillar attempt refuse to start, trapping the
			// body in its own sealed shaft until dawn and then forever. A cap
			// the body can mine is headroom, because prepareCeiling will open
			// it before the first jump.
			return ceilingMineable(client, player, fourthPos, fourth);
		}

		/**
		 * The next block above the head. Air means the body can jump-place
		 * immediately; solid means it must be mined first.
		 */
		private boolean prepareCeiling(Minecraft client, LocalPlayer player) {
			BlockPos feet = player.blockPosition();
			ceilingBase = feet.getY();
			ceilingStepAt = age;
			ceilingMine = null;
			ceilingPlacing = false;
			// Always clear the lowest blocking cell first. A two-block-thick
			// ceiling has no exposed face on the upper block, so aiming at it
			// made `nearestExposedHit` return the lower block while
			// `startDestroyBlock` targeted the hidden upper cell; vanilla then
			// rejected every packet and the body stood still until the 12s
			// timeout. Mining head+2 first exposes head+3 for the next step.
			BlockState lower = client.level.getBlockState(feet.above(2));
			BlockState upper = client.level.getBlockState(feet.above(3));
			int offset = ShaftEscape.firstCeilingOffset(!lower.isAir(), !upper.isAir());
			if (offset < 0) {
				ceilingPlacing = true;
				return true;
			}
			BlockPos target = feet.above(offset);
			BlockState state = client.level.getBlockState(target);
			if (!ceilingMineable(client, player, target, state)) return false;
			ceilingMine = target;
			return true;
		}

		private boolean ceilingMineable(
			Minecraft client,
			LocalPlayer player,
			BlockPos pos,
			BlockState state
		) {
			if (!state.getFluidState().isEmpty()) return false;
			if (playerFacility(state)) return false;
			if (state.getDestroySpeed(client.level, pos) < 0.0f) return false;
			if (state.requiresCorrectToolForDrops() && !hasCorrectTool(player, state)) {
				return false;
			}
			return !fluidWithin(client, pos, 3);
		}

		private static boolean hasCorrectTool(LocalPlayer player, BlockState state) {
			return hasCorrectToolInInventory(player, state);
		}

		private static boolean hasCorrectToolInInventory(
			LocalPlayer player,
			BlockState state
		) {
			for (int slot = 0; slot < 9; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (!stack.isEmpty() && stack.isCorrectToolForDrops(state)) return true;
			}
			for (int slot = 9; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (!stack.isEmpty() && stack.isCorrectToolForDrops(state)) return true;
			}
			return false;
		}

		/**
		 * Pick the fastest valid tool in the hotbar. The old scan kept the
		 * last matching slot, so a body carrying both a wooden and a stone
		 * pickaxe mined every escape wall with the wooden one even though it
		 * had already upgraded.
		 */
		private static int bestToolSlot(LocalPlayer player, BlockState state) {
			int best = -1;
			float bestSpeed = -1.0f;
			for (int slot = 0; slot < 9; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (stack.isEmpty() || !stack.isCorrectToolForDrops(state)) continue;
				float speed = stack.getDestroySpeed(state);
				if (speed > bestSpeed) {
					bestSpeed = speed;
					best = slot;
				}
			}
			return best;
		}

		private void tickCeilingPillar(Minecraft client, LocalPlayer player) {
			if (age - ceilingStepAt > 20 * 12) {
				CraftMateBodyClient.LOGGER.info(
					"CraftMate ceiling timeout pos={} baseY={} mine={} placing={} onGround={} delta={}",
					player.position(),
					ceilingBase,
					ceilingMine,
					ceilingPlacing,
					player.onGround(),
					player.getDeltaMovement()
				);
				abortCeiling(client, "could not pillar through the ceiling");
				return;
			}
			if (!ShaftEscape.withinRecoveryPillarBudget(climbSteps)) {
				abortCeiling(client, "recovery pillar exceeded its 12-block budget");
				return;
			}
			if (age % 20 == 0) {
				CraftMateBodyClient.LOGGER.info(
					"CraftMate ceiling state pos={} baseY={} mine={} mineState={} placing={} onGround={} delta={}",
					player.position(),
					ceilingBase,
					ceilingMine,
					ceilingMine == null ? null : client.level.getBlockState(ceilingMine),
					ceilingPlacing,
					player.onGround(),
					player.getDeltaMovement()
				);
			}
			if (
				ShaftEscape.shouldRebasePillar(
					player.onGround(),
					player.blockPosition().getY(),
					ceilingBase
				)
			) {
				CraftMateBodyClient.LOGGER.info(
					"CraftMate ceiling rebase from={} feet={} pos={}",
					ceilingBase,
					player.blockPosition(),
					player.position()
				);
				ceilingMine = null;
				ceilingPlacing = false;
				ceilingStepAt = age;
				if (!pillarHasEscapeHeadroom(client, player, player.blockPosition())) {
					abortCeiling(client, "dropped into a pocket without pillar headroom");
					return;
				}
				if (!prepareCeiling(client, player)) {
					abortCeiling(client, "ceiling is not safely mineable after dropping");
					return;
				}
				send.accept(progress(id, "climbing", climbSteps, 16));
				return;
			}
			if (ceilingMine != null) {
				if (client.level.getBlockState(ceilingMine).isAir()) {
					ceilingMine = null;
					ceilingPlacing = false;
					ceilingStepAt = age;
					// A capped shaft has two blocking cells (the cap and the
					// one below it). Keep clearing until prepareCeiling finds
					// real headroom, otherwise the first jump places a block
					// and then stalls under the remaining solid cell.
					if (!prepareCeiling(client, player)) {
						abortCeiling(client, "ceiling is not safely mineable");
					}
					return;
				}
				if (!mineCeilingBlock(client, player, ceilingMine)) return;
				if (age % 20 == 0) send.accept(progress(id, "climbing", climbSteps, 16));
				return;
			}
			if (!ceilingPlacing) {
				if (!prepareCeiling(client, player)) {
					abortCeiling(client, "ceiling is not safely mineable");
				}
				return;
			}
			if (player.onGround()) {
				// A player centred on the block can jump a full block even when
				// a neighbouring column is only two blocks high. Standing on
				// the boundary lets that neighbour clip the head at 0.2 blocks,
				// which made every pillar attempt look like a dead jump.
				if (centerForPillarJump(client, player)) return;
				if (player.blockPosition().getY() > ceilingBase) {
					ceilingPlacing = false;
					climbSteps++;
					ceilingStepAt = age;
					releaseWalkInput(client);
					if (!ShaftEscape.withinRecoveryPillarBudget(climbSteps)) {
						abortCeiling(client, "recovery pillar exceeded its 12-block budget");
						return;
					}
					if (
						ShaftEscape.pillarReachedTarget(
							player.blockPosition().getY(),
							ceilingBase,
							target.y
						)
					) {
						ceilingActive = false;
						ceilingMine = null;
						ceilingCenter = null;
						ceilingCenterSince = -1;
						if (onCanopy(client)) {
							escapingCanopy = true;
							canopyEscapeStartedAge = age;
							send.accept(progress(id, "unstick", 1, 2));
						} else {
							tickEscape(client, player);
						}
						return;
					}
					Route route = firstSafeRoute(client, player);
					if (route != null) {
						ceilingActive = false;
						followRoute(client, player, route);
						return;
					}
					if (!prepareCeiling(client, player)) {
						if (!beginPillarRetreat(client, player)) {
							abortCeiling(client, "ran out of a safe ceiling route");
						}
					}
					return;
				}
				player.jumpFromGround();
				return;
			}
			if (player.getDeltaMovement().y < -0.15) return;
			if (player.getY() < ceilingBase + 1.05) return;
			BlockPos target = new BlockPos(
				player.blockPosition().getX(),
				ceilingBase,
				player.blockPosition().getZ()
			);
			if (!client.level.getBlockState(target).canBeReplaced()) return;
			BlockPos support = target.below();
			if (!client.level.getBlockState(support).blocksMotion()) return;
			int slot = buildingSlot(client, player);
			if (slot < 0) {
				abortCeiling(client, "ran out of building blocks while pillaring");
				return;
			}
			player.getInventory().selected = slot;
			Vec3 center = Vec3.atCenterOf(support);
			CameraController.steerTo(player, center);
			BlockHitResult hit = BlockInteraction.hit(support, Direction.UP);
			client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, hit);
			pillarPlacedAt = target;
			lastEscapePillar = target;
				rememberEscapePillar(target);
			saveHomeMemory();
		}

		/**
		 * A pillar can end on a one-block island with a stone ceiling: the
		 * next jump is impossible and every horizontal ledge is blocked.
		 * Backtracking is the human move, so break the block this escape
		 * placed and drop back onto the cave floor instead of re-planning the
		 * same unreachable surface target forever.
		 */
		private boolean beginPillarRetreat(
			Minecraft client,
			LocalPlayer player
		) {
			BlockPos placed = pillarPlacedAt == null ? lastEscapePillar : pillarPlacedAt;
			if (placed == null || !player.onGround()) return false;
			BlockPos support = supportBlock(client, player).pos();
			if (!support.equals(placed)) return false;
			BlockState supportState = client.level.getBlockState(support);
			if (!supportState.blocksMotion()) return false;
			if (
				!ToolSelection.canHarvest(
					supportState.requiresCorrectToolForDrops(),
					hasCorrectToolInInventory(player, supportState)
				)
			) return false;
			BlockPos floor = support.below();
			BlockState floorState = client.level.getBlockState(floor);
			BlockState head = client.level.getBlockState(support.above());
			if (
				!floorState.blocksMotion()
					|| !floorState.getFluidState().isEmpty()
					|| !client.level.getBlockState(support).getFluidState().isEmpty()
					|| !head.getFluidState().isEmpty()
					|| head.blocksMotion()
			) return false;
			pillarRetreat = true;
			pillarRetreatMining = false;
			pillarRetreatAt = age;
			pillarPlacedAt = placed;
			ceilingPlacing = false;
			releaseWalkInput(client);
			CraftMateBodyClient.LOGGER.info(
				"CraftMate pillar retreat support={} state={} pos={}",
				support,
				supportState,
				player.position()
			);
			return true;
		}

		private void tickPillarRetreat(
			Minecraft client,
			LocalPlayer player
		) {
			if (pillarPlacedAt == null) {
				pillarRetreat = false;
				return;
			}
			BlockState state = client.level.getBlockState(pillarPlacedAt);
			if (state.isAir()) {
					BlockPos broken = pillarPlacedAt;
				releaseMiningInput(client);
				pillarRetreatMining = false;
				if (!player.onGround()) {
					if (age - pillarRetreatAt > 20 * 5) {
						abortCeiling(client, "did not land after retreating from the pillar");
					}
					return;
				}
				pillarRetreat = false;
				ceilingActive = false;
				pillarPlacedAt = null;
				Route route = firstSafeRoute(client, player);
				if (route != null && routeMovesBody(route, player)) {
					lastEscapePillar = null;
					escapePillarColumn = List.of();
					saveHomeMemory();
					followRoute(client, player, route);
					return;
				}
				BlockPos landed = supportBlock(client, player).pos();
				List<BlockPos> remaining = new ArrayList<>(escapePillarColumn);
				remaining.remove(broken);
				boolean continueRetreat = ShaftEscape.continuesPillarRetreat(
					player.onGround(),
					landed.getX() == broken.getX()
						&& landed.getZ() == broken.getZ(),
					broken.getY(),
					landed.getY(),
					remaining.contains(landed)
				);
				escapePillarColumn = List.copyOf(remaining);
				lastEscapePillar = continueRetreat ? landed : null;
				if (!continueRetreat) escapePillarColumn = List.of();
				saveHomeMemory();
				tickEscape(client, player);
				return;
			}
			BlockPos support = supportBlock(client, player).pos();
			if (!support.equals(pillarPlacedAt)) {
				pillarRetreat = false;
				pillarRetreatMining = false;
				ceilingActive = false;
				releaseMiningInput(client);
				tickEscape(client, player);
				return;
			}
			if (age - pillarRetreatAt > 20 * 10) {
				abortCeiling(client, "could not mine the retreat pillar");
				return;
			}
			BlockHitResult hit = BlockInteraction.nearestExposedHit(
				client.level,
				player.getEyePosition(),
				pillarPlacedAt
			);
			aimBodyAt(player, hit.getLocation());
			CameraController.steerTo(player, Vec3.atCenterOf(pillarPlacedAt));
			// The body placed this pillar while holding a building block, so
			// the selected slot is almost never a pickaxe. Equip the correct
			// tool before touching the support; otherwise the retreat grinds
			// cobblestone with a fist and never breaks it.
			int tool = bestToolSlot(player, state);
			if (state.requiresCorrectToolForDrops() && tool < 0) {
				if (equipEscapeToolFromInventory(client, state)) {
					CraftMateBodyClient.LOGGER.info(
						"CraftMate retreat lift tool target={} state={}",
						pillarPlacedAt,
						state
					);
					return;
				}
				abortCeiling(client, "no carried tool can mine the retreat pillar");
				return;
			}
			if (tool >= 0) player.getInventory().selected = tool;
			if (pillarRetreatMining) {
				client.gameMode.continueDestroyBlock(pillarPlacedAt, hit.getDirection());
			} else {
				client.gameMode.startDestroyBlock(pillarPlacedAt, hit.getDirection());
				pillarRetreatMining = true;
			}
			holdMiningInput(client);
		}

		/**
		 * Walk to the middle of the current block before jumping. The body is
		 * 0.6 blocks wide; at a block edge its bounding box overlaps the
		 * neighbouring column, whose two-block ceiling can cancel the jump
		 * even though the current column has three blocks of headroom.
		 */
		private boolean centerForPillarJump(
			Minecraft client,
			LocalPlayer player
		) {
			Vec3 center = ceilingCenter == null
				? Vec3.atCenterOf(player.blockPosition())
				: ceilingCenter;
			double offset = Math.hypot(center.x - player.getX(), center.z - player.getZ());
			if (offset <= 0.08) {
				ceilingCenterSince = -1;
				releaseWalkInput(client);
				return false;
			}
			if (ceilingCenterSince < 0) {
				ceilingCenterSince = age;
				CraftMateBodyClient.LOGGER.info(
					"CraftMate ceiling center target={} pos={} offset={}",
					center,
					player.position(),
					offset
				);
			}
			if (age - ceilingCenterSince > 20 * 4) {
				abortCeiling(client, "could not centre the body for a safe pillar jump");
				return true;
			}
			float heading = (float) Math.toDegrees(
				Math.atan2(-(center.x - player.getX()), center.z - player.getZ())
			);
			boolean aligned = turnTowards(player, heading);
			CameraController.steerHeading(
				player,
				player.getYRot(),
				CameraController.displayPitch(player)
			);
			setWalkInput(client, aligned);
			return true;
		}

		private boolean mineCeilingBlock(Minecraft client, LocalPlayer player, BlockPos pos) {
			BlockState state = client.level.getBlockState(pos);
			if (state.isAir()) {
				climbMining = null;
				return true;
			}
			if (!state.getFluidState().isEmpty()) {
				abortCeiling(client, "ceiling exposed fluid");
				return false;
			}
			if (playerFacility(state)) {
				abortCeiling(client, "ceiling target is a player facility");
				return false;
			}
			if (state.requiresCorrectToolForDrops()) {
				int tool = bestToolSlot(player, state);
				if (tool < 0) {
					if (equipEscapeToolFromInventory(client, state)) {
						CraftMateBodyClient.LOGGER.info(
							"CraftMate ceiling lift tool target={} state={}",
							pos,
							state
						);
						return true;
					}
					abortCeiling(client, "no carried tool can mine the ceiling");
					return false;
				}
				player.getInventory().selected = tool;
			}
			BlockHitResult hit = BlockInteraction.nearestExposedHit(
				client.level,
				player.getEyePosition(),
				pos
			);
			aimBodyAt(player, hit.getLocation());
			CameraController.steerTo(player, Vec3.atCenterOf(pos));
			if (climbMining == null || !climbMining.equals(pos)) {
				if (client.gameMode.isDestroying()) client.gameMode.stopDestroyBlock();
				client.gameMode.startDestroyBlock(pos, hit.getDirection());
				climbMining = pos;
			} else {
				client.gameMode.continueDestroyBlock(pos, hit.getDirection());
			}
			client.hitResult = hit;
			holdMiningInput(client);
			return true;
		}

		private void abortCeiling(Minecraft client, String reason) {
			CraftMateBodyClient.LOGGER.info(
				"CraftMate ceiling abort reason={} pos={} baseY={} mine={} placing={}",
				reason,
				client.player == null ? null : client.player.position(),
				ceilingBase,
				ceilingMine,
				ceilingPlacing
			);
			releaseMiningInput(client);
			releaseWalkInput(client);
			ceilingActive = false;
			ceilingMine = null;
			ceilingPlacing = false;
			ceilingCenter = null;
			ceilingCenterSince = -1;
			pillarPlacedAt = null;
			pillarRetreat = false;
			pillarRetreatMining = false;
			climbMining = null;
			escapingNoRoute = false;
			finish(id, "failed", "E_STUCK", reason);
		}

		/**
		 * Exploration supplies several headings. Trying only the primary
		 * destination made a coastal or cliff-side choice fail immediately,
		 * even though another direction was a short safe walk, so the scan
		 * stops at the first complete route instead of paying for every
		 * candidate.
		 *
		 * When no candidate has a complete route, the best partial route wins
		 * over standing still. Failing outright left the body frozen, and an
		 * unchanged position makes the planner re-derive byte-identical
		 * exploration coordinates: the same strategy fails again after every
		 * backoff and the run looks like idling forever. A partial route still
		 * ends on a proven standable cell, so walking it buys real
		 * displacement, a new observation area, and different facts for the
		 * next replan. The route whose end is closest to its own request wins;
		 * a partial route that gets nowhere nearer than the current position is
		 * rejected so the body never walks sideways for nothing. Arrival is
		 * still only reported for a complete route, so this cannot fake
		 * evidence.
		 */
		private Route firstSafeRoute(Minecraft client, LocalPlayer player) {
			Route bestPartial = null;
			Vec3 bestPartialTarget = null;
			double bestRemaining = Double.MAX_VALUE;
			Route fallback = null;
			Vec3 fallbackTarget = null;
			Vec3 forward = acceptPartial
				? new Vec3(
					-Math.sin(Math.toRadians(player.getYRot())),
					0.0,
					Math.cos(Math.toRadians(player.getYRot()))
				)
				: null;
			for (int index = 0; index < requests.size(); index++) {
				Vec3 candidate = requests.get(index);
				target = candidate;
				Route found = safeRouteEnd(client, player);
				if (found == null) continue;
				if (found.complete()) {
					if (acceptPartial && returnsToLastExplore(found)) {
						if (fallback == null) {
							fallback = found;
							fallbackTarget = candidate;
						}
						continue;
					}
					return found;
				}
				double remaining = Math.hypot(
					candidate.x - found.destination().x,
					candidate.z - found.destination().z
				);
				// A partial route into the opposite hemisphere is usually a
				// fallback around the same obstacle. Choosing it completes the
				// leg by walking straight back where the body came from, which
				// reads as indecision and undoes the previous observation.
				if (
					forward != null
						&& movesBackward(player, found.destination(), forward)
				) {
					continue;
				}
				if (remaining + 0.5 < bestRemaining
					&& routeMovesBody(found, player)
					&& bestPartialMovesCloser(player, found, candidate)) {
					bestRemaining = remaining;
					bestPartial = found;
					bestPartialTarget = candidate;
				}
			}
			// A complete route that only leads back down the way it came is a
			// loop, not progress. A partial route into new terrain is better:
			// the body still walks a proven-safe leg and observes somewhere
			// new, which is all the explore skill promised.
			if (
				fallback != null
					&& bestPartial != null
					&& Math.hypot(
						bestPartial.destination().x - player.getX(),
						bestPartial.destination().z - player.getZ()
					) >= PARTIAL_PROGRESS
					&& !returnsToLastExplore(bestPartial)
			) {
				target = bestPartialTarget;
				return bestPartial;
			}
			if (fallback != null) {
				target = fallbackTarget;
				return fallback;
			}
			target = requests.get(0);
			return bestPartial;
		}

		private static boolean movesBackward(
			LocalPlayer player,
			Vec3 destination,
			Vec3 forward
		) {
			double dx = destination.x - player.getX();
			double dz = destination.z - player.getZ();
			double length = Math.hypot(dx, dz);
			if (length < 1.0e-4) return false;
			return (dx * forward.x + dz * forward.z) / length < -0.25;
		}

		private static boolean returnsToLastExplore(Route route) {
			// The newest entry is where this leg starts, so it cannot be a
			// return. Older entries are the places a ping-pong would revisit.
			boolean newest = true;
			for (Vec3 seen : exploreTrail) {
				if (newest) {
					newest = false;
					continue;
				}
				if (
					Math.hypot(
						route.destination().x - seen.x,
						route.destination().z - seen.z
					) < OSCILLATION_RADIUS
				) {
					return true;
				}
			}
			return false;
		}

		private static void rememberExplore(LocalPlayer player) {
			exploreTrail.addFirst(
				new Vec3(player.getX(), player.getY(), player.getZ())
			);
			while (exploreTrail.size() > EXPLORE_TRAIL) exploreTrail.removeLast();
		}

		private static boolean bestPartialMovesCloser(
			LocalPlayer player,
			Route route,
			Vec3 candidate
		) {
			double fromBody = Math.hypot(
				candidate.x - player.getX(),
				candidate.z - player.getZ()
			);
			double fromEnd = Math.hypot(
				candidate.x - route.destination().x,
				candidate.z - route.destination().z
			);
			return fromEnd < fromBody;
		}

		@Override
		void tick(Minecraft client) {
			LocalPlayer player = client.player;
			// Every sub-state below can return before the normal walk budget
			// check runs. A stuck escape wall therefore used to report progress
			// forever while the coordinate never changed. Bound the whole goto
			// command here, before any branch can take ownership.
			if (age > 20 * 60) {
				stop(client);
				finish(id, "timeout", "E_TIMEOUT", "bounded walk did not reach target");
				return;
			}
			if (swimming) {
				tickSwim(client, player);
				return;
			}
			/*
			 * A route can also end with the body stepping off a bank. If the
			 * eyes go under water, stop following the land route and surface
			 * immediately; waiting for the stuck timer meant several seconds
			 * of sinking before the swim branch noticed.
			 */
			if (
				!escapingNoRoute &&
				player.isEyeInFluid(FluidTags.WATER)
			) {
				beginSwim(client);
				return;
			}
			if (ledgeTarget != null) {
				tickLedge(client, player);
				return;
			}
			if (escapingCanopy) {
				if (CanopyEscape.timedOut(canopyEscapeStartedAge, age)) {
					stop(client);
					finish(id, "timeout", "E_TIMEOUT", "could not leave the tree canopy in time");
					return;
				}
				if (descendCanopyStep(client)) {
					if (age % 20 == 0) send.accept(progress(id, "unstick", 1, 2));
					return;
				}
				escapingCanopy = false;
				canopyEscapeStartedAge = -1;
				Route route = firstSafeRoute(client, player);
				if (route == null) {
					finish(
						id,
						"failed",
						"E_STUCK",
						"no safe route after leaving the canopy"
					);
					return;
				}
				destination = route.destination();
				routeComplete = route.complete();
				waypoints = route.waypoints();
				waypointIndex = waypoints.size() > 1 ? 1 : 0;
				lastWaypointIndex = waypointIndex;
				lastWaypointDistance = playerDistance(client.player);
				nextReplanAt = 0;
				send.accept(progress(id, "walking", 0, 1));
				return;
			}
			if (escapeWall != null) {
				if (escapeWallSince >= 0 && age - escapeWallSince > 20 * 15) {
					releaseMiningInput(client);
					escapeWall = null;
					escapeWallSince = -1;
					stop(client);
					finish(id, "timeout", "E_TIMEOUT", "escape wall did not break in time");
					return;
				}
				BlockState wall = client.level.getBlockState(escapeWall);
				if (wall.isAir()) {
					escapeWall = null;
					escapeWallSince = -1;
					Route route = firstSafeRoute(client, player);
					if (route != null && routeMovesBody(route, player)) {
						destination = route.destination();
						routeComplete = route.complete();
						waypoints = route.waypoints();
						waypointIndex = waypoints.size() > 1 ? 1 : 0;
						escapingNoRoute = false;
						return;
					}
					tickEscape(client, player);
					return;
				}
				if (wall.requiresCorrectToolForDrops()) {
					int tool = bestMiningSlot(player, wall);
					if (tool < 0) {
						releaseMiningInput(client);
						escapeWall = null;
						escapeWallSince = -1;
						tickEscape(client, player);
						return;
					}
					if (tool >= 0) player.getInventory().selected = tool;
				}
				Vec3 centre = Vec3.atCenterOf(escapeWall);
				BlockHitResult hit = BlockInteraction.nearestExposedHit(
					client.level,
					player.getEyePosition(),
					escapeWall
				);
				aimBodyAt(player, hit.getLocation());
				CameraController.steerTo(player, centre);
				client.hitResult = hit;
				client.gameMode.continueDestroyBlock(escapeWall, hit.getDirection());
				holdMiningInput(client);
				if (age % 20 == 0) send.accept(progress(id, "unstick", 1, 2));
				return;
			}
			if (escapingNoRoute) {
				tickEscape(client, player);
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
			// A waypoint can share the target's horizontal cell but sit at a
			// different Y. Requiring both the final destination height and the
			// waypoint height rejected a valid route whose last safe cell was
			// one block below the requested column.
			boolean waypointReached = Math.hypot(waypoint.x - player.getX(), waypoint.z - player.getZ())
					< ARRIVE_DISTANCE
				&& Math.abs(waypoint.y - player.getY()) <= arrivalHeight();
			if (
				waypointIndex < waypoints.size() - 1
					&& waypointReached
			) {
				waypointIndex++;
				return;
			}
			// Walking to a cell centre can stop on its boundary (x=37.0 still
			// belongs to block 37, not 36). The planner compares the body's
			// block position, so a geometric near-miss must not count as
			// arrival or the same goto is reissued forever.
			boolean inDestinationCell =
				player.blockPosition().equals(BlockPos.containing(destination));
			boolean arrived = horizontal < ARRIVE_DISTANCE
				&& Math.abs(player.getY() - destination.y) <= arrivalHeight()
				&& inDestinationCell
				// A fall through the target's block column can satisfy the
				// height check for one tick. Completing there made the task
				// verifier see the body land back on the upper ledge, so the
				// same "walk here" command was reissued every two seconds.
				&& (player.onGround() || player.isInWater());
			// An explore target is a column, not a precise terrain height.
			// The old height check rejected a perfectly good sweep endpoint
			// whenever the chosen candidate's Y came from a neighbouring
			// slope, which is why most "night keep moving" legs ended in
			// E_PRECONDITION instead of a new observation area.
			boolean reachedExploreColumn = acceptPartial
				&& routeComplete
				// Standing still is not an observation. Without this, a target
				// in the same column but a different Y completed instantly,
				// and the planner reissued it before the body could climb.
				&& movedFromStart(player) >= 1.0
				&& Math.hypot(target.x - player.getX(), target.z - player.getZ()) <= 2.5;
			boolean finalWaypoint = waypointIndex >= waypoints.size() - 1;
			if (finalWaypoint && (arrived || reachedExploreColumn)) {
				stop(client);
				if (
					reachedExploreColumn
						// A complete non-explore route ends at the nearest
						// standable cell inside the requested one-block goal
						// window. Requiring `atTarget` here rejected that
						// verified endpoint and sent the walker back into the
						// same unreachable column on every attempt.
						|| (arrived && routeComplete)
				) {
					JsonObject evidence = new JsonObject();
					evidence.addProperty("summary", "arrived at the requested position");
					JsonArray changes = new JsonArray();
					JsonObject change = new JsonObject();
					change.addProperty("kind", "position_reached");
					change.addProperty("detail", "goto");
					JsonObject position = new JsonObject();
					position.addProperty("x", round(client.player.getX()));
					position.addProperty("y", round(client.player.getY()));
					position.addProperty("z", round(client.player.getZ()));
					change.add("position", position);
					changes.add(change);
					evidence.add("changes", changes);
					if (acceptPartial) rememberExplore(client.player);
					finish(id, "completed", null, null, evidence);
				} else if (
					arrived
						&& !routeComplete
						&& acceptPartial
						&& movedFromStart(client.player) >= PARTIAL_PROGRESS
				) {
					// The explore skill asked for a new observation area, not
					// the exact column. The world refused the last stretch
					// (ravine, water, cliff) but the body did walk a proven
					// safe leg; reporting that as a failure sent the runtime
					// into the same backoff and the same heading again.
					if (continueExplore(client, player)) {
						send.accept(progress(id, "walking", 0, 1));
						return;
					}
					JsonObject evidence = partialRoute(horizontal);
					JsonObject outcome = new JsonObject();
					outcome.addProperty(
						"summary",
						"到达安全路线的可用终点，已完成一次新的区域观察"
					);
					outcome.addProperty("problem", "请求的坐标本身仍不可达");
					evidence.add("outcome", outcome);
					evidence.addProperty("partial", true);
					JsonArray changes = new JsonArray();
					JsonObject change = new JsonObject();
					change.addProperty("kind", "position_reached");
					change.addProperty("detail", "explore");
					JsonObject position = new JsonObject();
					position.addProperty("x", round(client.player.getX()));
					position.addProperty("y", round(client.player.getY()));
					position.addProperty("z", round(client.player.getZ()));
					change.add("position", position);
					changes.add(change);
					evidence.add("changes", changes);
					if (acceptPartial) rememberExplore(client.player);
					finish(id, "completed", null, null, evidence);
				} else {
					if (!routeComplete && !acceptPartial) {
						double endDistance = Math.hypot(
							destination.x - player.getX(),
							destination.z - player.getZ()
						);
						if (endDistance < 2.0) {
							if (mode.isWalk()) {
								failUnreachable(client, player, "safe route stopped at a blocked endpoint");
							} else {
								startEscape(client, player);
							}
							return;
						}
						double targetDistance = Math.hypot(
							target.x - player.getX(),
							target.z - player.getZ()
						);
						if (
							replans < MAX_REPLANS
							&& targetDistance + 0.75 < bestPartialTargetDistance
						) {
							bestPartialTargetDistance = targetDistance;
							replans++;
							Route replanned = firstSafeRoute(client, player);
							if (replanned != null && routeMovesBody(replanned, player)) {
								destination = replanned.destination();
								routeComplete = replanned.complete();
								waypoints = replanned.waypoints();
								waypointIndex = waypoints.size() > 1 ? 1 : 0;
								lastWaypointIndex = waypointIndex;
								lastWaypointDistance = playerDistance(player);
								send.accept(progress(id, "replanning", replans, MAX_REPLANS));
								return;
							}
						}
						if (mode.isWalk()) {
							failUnreachable(client, player, "safe route stopped short of the requested target");
						} else {
							startEscape(client, player);
						}
						return;
					}
					JsonObject evidence = partialRoute(horizontal);
					finish(
						id,
						"failed",
						mode.isWalk() ? "E_UNREACHABLE" : "E_STUCK",
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
					if (mode.isWalk()) {
						failUnreachable(client, player, "walk budget expired before reaching the target");
					} else {
						finish(
							id,
							"failed",
							"E_STUCK",
							"safe route stopped short of the requested target",
							partialRoute(horizontal)
						);
					}
				} else {
					finish(id, "timeout", "E_TIMEOUT", "bounded walk did not reach target");
				}
				return;
			}
			Vec3 step = nextDistinctWaypoint(player);
			if (player.onGround() && step != null && unsafeNextStep(client, step)) {
				stop(client);
				finish(
					id,
					"failed",
					mode.isWalk() ? "E_UNREACHABLE" : "E_STUCK",
					"dangerous drop or water ahead"
				);
				return;
			}
			if (detour != null) {
				Vec3 toSide = new Vec3(detour.x - player.getX(), 0.0, detour.z - player.getZ());
				if (Math.hypot(toSide.x, toSide.z) < ARRIVE_DISTANCE || detourTicks > 20) {
					detour = null;
					detourTicks = 0;
				} else {
					detourTicks++;
					step = detour;
					waypoint = detour;
					offset = waypoint.subtract(player.position());
				}
			}
			float heading = (float) Math.toDegrees(
				Math.atan2(-(step == null ? offset.x : step.x - player.getX()),
					step == null ? offset.z : step.z - player.getZ())
			);
			boolean aligned = turnTowards(player, heading);
			CameraController.steerHeading(
				player,
				player.getYRot(),
				CameraController.displayPitch(player)
			);
			// A single collision tick is normal on a slope. Jumping on every
			// one of them, however, is what wedged the body against a wall for
			// minutes: it never turned and never left the lip. Jump when the
			// next path cell is one block above the feet and the body is
			// already facing it; otherwise keep the old short collision hop
			// and let the stall branch choose another cell when jumping does
			// not help.
			boolean stepUp = step != null
				&& step.y - player.getY() >= 0.45
				&& step.y - player.getY() <= 1.6
				&& Math.hypot(step.x - player.getX(), step.z - player.getZ()) <= 2.2;
			if (player.horizontalCollision && player.onGround()) {
				if (stepUp && aligned) {
					// A step can be geometrically valid and still unjumpable
					// under a low cave roof: the body's head hits the ceiling
					// before its feet clear the lip. A player mines that
					// ceiling instead of hopping forever, so clear the head
					// cell above the destination or above the current body.
					if (
						mode.mayDig()
							&& stuckTicks >= 12
							&& clearStepHeadroom(client, player, step)
					) {
						send.accept(progress(id, "unstick", replans, MAX_REPLANS));
						return;
					}
					if (age - lastStepJumpAt >= 8) {
						player.jumpFromGround();
						lastStepJumpAt = age;
					}
				} else if (stuckTicks < 4) {
					player.jumpFromGround();
				}
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
				if (mode.mayDig() && digOut(client)) {
					send.accept(progress(id, "unstick", replans, MAX_REPLANS));
					replans = 0;
					nextReplanAt = age + 20;
					Route replanned = firstSafeRoute(client, player);
					if (replanned != null) {
						destination = replanned.destination();
						routeComplete = replanned.complete();
						waypoints = replanned.waypoints();
						waypointIndex = waypoints.size() > 1 ? 1 : 0;
					}
					return;
				}
				Vec3 sideStep = openSideStep(client, player, step);
				if (sideStep != null) {
					detour = sideStep;
					detourTicks = 0;
					lastWaypointDistance = playerDistance(player);
					send.accept(progress(id, "unstick", replans, MAX_REPLANS));
					return;
				}
				// A terraced camp can have a valid-but-unsafe partial route:
				// the bed sits two blocks below the chest shelf, so A* finds
				// a path to the lip and then no walkable step down. Step off
				// a proven safe ledge before declaring the route impossible.
				Vec3 ledge = safeLedge(client, player);
				if (ledge != null) {
					beginLedge(client, player, ledge);
					return;
				}
				if (age < nextReplanAt || replans >= MAX_REPLANS) {
					stop(client);
					if (!routeComplete) {
						if (mode.isWalk()) {
							failUnreachable(
								client,
								player,
								"safe route stopped short after bounded replanning"
							);
						} else {
							finish(
								id,
								"failed",
								"E_STUCK",
								"safe route stopped short of the requested target",
								partialRoute(horizontal)
							);
						}
						return;
					}
					finish(
						id,
						"failed",
						mode.isWalk() ? "E_UNREACHABLE" : "E_STUCK",
						"walk made no progress after bounded replanning"
					);
					return;
				}
				Route replanned = firstSafeRoute(client, player);
				if (replanned == null) {
					stop(client);
					if (mode.isWalk()) {
						failUnreachable(client, player, "no natural route after replanning");
					} else {
						finish(id, "failed", "E_STUCK", "no safe route after replanning");
					}
					return;
				}
				replans++;
				detour = null;
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
			CameraController.steerHeading(
				player,
				player.getYRot(),
				CameraController.displayPitch(player)
			);
			boolean sprint = safeToSprint(client, player, step, aligned, stepUp);
			if (age % 20 == 0) {
				CraftMateBodyClient.LOGGER.info(
					"CraftMate goto walk pos={} waypoint={} index={}/{} destination={} distance={} aligned={} sprint={} onGround={} hcoll={} stuck={} replans={}",
					player.position(),
					step,
					waypointIndex,
					waypoints.size(),
					destination,
					horizontal,
					aligned,
					sprint,
					player.onGround(),
					player.horizontalCollision,
					stuckTicks,
					replans
				);
			}
			if (player.input != null) {
				setWalkInput(
					client,
					aligned,
					sprint
				);
			}
			if (age - lastProgressTick >= 20) {
				lastProgressTick = age;
				send.accept(progress(id, "walking", (int) Math.round(horizontal), (int) Math.round(age)));
			}
		}

		/**
		 * The destination cell can be clear while its head cell is not, and a
		 * cave roof above the current body can cap the jump arc. Pick the
		 * blocking cell the body would actually hit and start destroying it
		 * through the normal escape-wall state machine.
		 */
		private boolean clearStepHeadroom(Minecraft client, LocalPlayer player, Vec3 step) {
			BlockPos stepFeet = BlockPos.containing(step);
			BlockPos target = null;
			if (client.level.getBlockState(stepFeet.above()).blocksMotion()) {
				target = stepFeet.above();
			} else {
				BlockPos roof = player.blockPosition().above(2);
				if (client.level.getBlockState(roof).blocksMotion()) target = roof;
			}
			if (target == null) return false;
			BlockState state = client.level.getBlockState(target);
			if (state.getDestroySpeed(client.level, target) < 0.0f) return false;
			return breakEscapeWall(client, player, target);
		}

		private static int bestMiningSlot(LocalPlayer player, BlockState state) {
			int best = -1;
			float bestSpeed = -1.0f;
			for (int slot = 0; slot < 9; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (stack.isEmpty()) continue;
				boolean correct = stack.isCorrectToolForDrops(state);
				if (!correct && state.requiresCorrectToolForDrops()) continue;
				float speed = stack.getDestroySpeed(state) + (correct ? 100.0f : 0.0f);
				if (speed > bestSpeed) {
					bestSpeed = speed;
					best = slot;
				}
			}
			return best;
		}

		private double horizontalDistance(LocalPlayer player) {
			return Math.hypot(destination.x - player.getX(), destination.z - player.getZ());
		}

		/**
		 * When the body is pressed against a lip, the useful move is sideways
		 * along the obstacle, not another jump straight into it. Prefer a
		 * perpendicular cell that is standable and clear for the body, and do
		 * not step onto water or a drop.
		 */
		private Vec3 openSideStep(Minecraft client, LocalPlayer player, Vec3 forward) {
			Vec3 heading = forward == null
				? new Vec3(destination.x - player.getX(), 0.0, destination.z - player.getZ())
				: new Vec3(forward.x - player.getX(), 0.0, forward.z - player.getZ());
			double length = Math.hypot(heading.x, heading.z);
			if (length < 1.0e-4) return null;
			double fx = heading.x / length;
			double fz = heading.z / length;
			BlockPos feet = player.blockPosition();
			Vec3[] options = {
				new Vec3(Math.round(player.getX()) + 0.5 - fz, 0.0, Math.round(player.getZ()) + 0.5 + fx),
				new Vec3(Math.round(player.getX()) + 0.5 + fz, 0.0, Math.round(player.getZ()) + 0.5 - fx),
			};
			for (Vec3 option : options) {
				BlockPos cell = BlockPos.containing(option.x, feet.getY(), option.z);
				if (!standableAt(client, cell)) continue;
				if (new BlockPos(cell.getX(), feet.getY(), cell.getZ()).equals(feet)) continue;
				if (!bodySpaceAt(client, cell)) continue;
				if (unsafeNextStep(client, new Vec3(cell.getX() + 0.5, cell.getY(), cell.getZ() + 0.5))) {
					continue;
				}
				return new Vec3(cell.getX() + 0.5, cell.getY(), cell.getZ() + 0.5);
			}
			return null;
		}

		/**
		 * The first route point can be the cell the body already occupies.
		 * Heading at it makes the walk direction collapse to zero, and the
		 * danger probe then skips a real drop. Return the next cell that is
		 * actually different so steering and the probe share one direction.
		 */
		private Vec3 nextDistinctWaypoint(LocalPlayer player) {
			for (int index = waypointIndex; index < waypoints.size(); index++) {
				Vec3 point = waypoints.get(index);
				if (Math.hypot(point.x - player.getX(), point.z - player.getZ()) >= 0.5) {
					return point;
				}
			}
			return null;
		}

		/**
		 * Sprint only on a straight, grounded, already-proven run. Vanilla
		 * sprinting ignores small ledges and tight corners much less
		 * forgivingly than walking, so keep it off during stepping, bridging,
		 * escape/detour states, water, collisions, low food, or the last few
		 * blocks before a waypoint. This is the same route the A* search
		 * proved safe; sprinting only changes speed, not the destination.
		 */
		private boolean safeToSprint(
			Minecraft client,
			LocalPlayer player,
			Vec3 step,
			boolean aligned,
			boolean stepUp
		) {
			if (!aligned || step == null || stepUp || !player.onGround()) return false;
			if (
				player.horizontalCollision
					|| player.isInWater()
					|| player.isInLava()
					|| player.isPassenger()
					|| player.isFallFlying()
					|| player.isSpectator()
					|| player.getAbilities().flying
			) {
				return false;
			}
			// Sprinting drains hunger. Below six points the body needs to keep
			// the reserve for regeneration and normal walking.
			if (player.getFoodData().getFoodLevel() <= 6) return false;
			if (detour != null || bridging || escapingNoRoute || escapingCanopy) return false;
			if (horizontalDistance(player) < 4.0) return false;
			Vec3 toward = new Vec3(step.x - player.getX(), 0.0, step.z - player.getZ());
			if (Math.hypot(toward.x, toward.z) < 1.5) {
				toward = new Vec3(destination.x - player.getX(), 0.0, destination.z - player.getZ());
			}
			if (Math.hypot(toward.x, toward.z) < 2.0) return false;
			// The waypoint is compressed and can be thirty blocks away, so its
			// Y says nothing about the next second of movement. Probe the
			// actual lane in front of the body instead. This preserves the
			// safety rule while allowing a sprint on a long flat run toward a
			// hillside waypoint.
			if (!sprintLaneClear(client, player, toward)) return false;

			// If the next compressed waypoint is a hard turn, the current
			// segment is still safe until its corner. Do not sprint through
			// the corner itself; the first pass at the new heading will pick
			// the next proven segment.
			Vec3 next = waypointIndex + 1 < waypoints.size()
				? waypoints.get(waypointIndex + 1)
				: null;
			if (next != null) {
				double firstLength = Math.hypot(toward.x, toward.z);
				double secondX = next.x - step.x;
				double secondZ = next.z - step.z;
				double secondLength = Math.hypot(secondX, secondZ);
				if (secondLength > 0.01 && firstLength > 0.01) {
					double alignment =
						(toward.x * secondX + toward.z * secondZ)
							/ (firstLength * secondLength);
					if (alignment < 0.55 && Math.hypot(step.x - player.getX(), step.z - player.getZ()) < 3.5) {
						return false;
					}
				}
			}
			return true;
		}

		/**
		 * Sprint only while the next few blocks are a continuous standable
		 * lane at the body's current level. A floor change or a closed cell
		 * ends the sprint for this tick; normal walking then handles the
		 * step-up without the extra momentum.
		 */
		private boolean sprintLaneClear(
			Minecraft client,
			LocalPlayer player,
			Vec3 toward
		) {
			double length = Math.hypot(toward.x, toward.z);
			if (length < 0.01) return false;
			double unitX = toward.x / length;
			double unitZ = toward.z / length;
			double probeDistance = Math.min(5.0, length);
			for (double distance = 1.0; distance <= probeDistance + 0.01; distance += 1.0) {
				BlockPos feet = BlockPos.containing(
					player.getX() + unitX * distance,
					player.getY(),
					player.getZ() + unitZ * distance
				);
				if (!standableAt(client, feet)) return false;
				if (!bodySpaceAt(client, feet)) return false;
			}
			return true;
		}

		/**
		 * Progress is measured against the current waypoint, not the final
		 * target: a valid U-shaped detour initially walks away from the
		 * target and must not look like a stall.
		 */
		private double movedFromStart(LocalPlayer player) {
			return startedAt == null ? 0.0 : player.position().distanceTo(startedAt);
		}

		private double playerDistance(LocalPlayer player) {
			Vec3 waypoint = waypoints.get(waypointIndex);
			return player.position().distanceTo(waypoint);
		}

		private double arrivalHeight() {
			return ShaftEscape.arrivalHeight(acceptPartial);
		}

		/** An explore heading names a column; its floor height is terrain. */
		private boolean atTargetColumn(Vec3 reached) {
			return Math.hypot(target.x - reached.x, target.z - reached.z)
				<= 1.5;
		}

		/**
		 * Keep an exploration leg alive across a safe partial path. The body
		 * still plans only to the same target column, so this is continuity,
		 * not a licence to wander to a newly invented coordinate.
		 */
		private boolean continueExplore(Minecraft client, LocalPlayer player) {
			if (!acceptPartial || exploreContinuations >= MAX_EXPLORE_CONTINUATIONS) {
				return false;
			}
			double remaining = Math.hypot(
				target.x - player.getX(),
				target.z - player.getZ()
			);
			if (remaining <= 3.0) return false;
			Route next = safeRouteEnd(client, player);
			if (next == null || !routeMovesBody(next, player)) return false;
			double leg = Math.hypot(
				next.destination().x - player.getX(),
				next.destination().z - player.getZ()
			);
			if (leg < 4.0) return false;
			exploreContinuations++;
			destination = next.destination();
			routeComplete = next.complete();
			waypoints = next.waypoints();
			waypointIndex = waypoints.size() > 1 ? 1 : 0;
			lastWaypointIndex = waypointIndex;
			lastWaypointDistance = playerDistance(player);
			nextReplanAt = 0;
			CraftMateBodyClient.LOGGER.info(
				"CraftMate goto explore continue {}/{} position={} destination={} remaining={}",
				exploreContinuations,
				MAX_EXPLORE_CONTINUATIONS,
				player.position(),
				destination,
				round(remaining)
			);
			return true;
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
		private boolean unsafeNextStep(Minecraft client, Vec3 waypoint) {
			BlockPos next = BlockPos.containing(waypoint);
			BlockPos feet = new BlockPos(next.getX(), next.getY(), next.getZ());
			if (
				standingY(
				client,
				feet
				) != Integer.MIN_VALUE
			) {
				return false;
			}
			// One block of water over a solid floor is a normal walk, not an
			// unsafe drop. Rejecting it made every shoreline look impassable.
			return !shallowWaterAt(client, feet);
		}

		private static boolean shallowWaterAt(Minecraft client, BlockPos feet) {
			BlockState foot = client.level.getBlockState(feet);
			BlockState head = client.level.getBlockState(feet.above());
			BlockState floor = client.level.getBlockState(feet.below());
			return foot.getFluidState().is(FluidTags.WATER)
				&& head.getFluidState().isEmpty()
				&& head.isAir()
				&& floor.blocksMotion();
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
			if (mode.isWalk()) {
				BoundedPathfinder.Result quick = findRoute(
					client,
					start,
					goal,
					QUICK_PATH_NODES,
					QUICK_PATH_RADIUS,
					QUICK_PATH_VERTICAL
				);
				if (quick != null && quick.complete()) {
					return routeFrom(client, goal, quick);
				}
				BoundedPathfinder.Result extended = findRoute(
					client,
					start,
					goal,
					EXTENDED_PATH_NODES,
					EXTENDED_PATH_RADIUS,
					EXTENDED_PATH_VERTICAL
				);
				return routeFrom(
					client,
					goal,
					extended != null ? extended : quick
				);
			}
			int verticalSpan = Math.abs(goal.y() - start.y());
			int maxVertical = Math.min(
				MAX_RETURN_VERTICAL,
				Math.max(BoundedPathfinder.DEFAULT_MAX_VERTICAL, verticalSpan + 4)
			);
			int maxNodes = verticalSpan <= BoundedPathfinder.DEFAULT_MAX_VERTICAL
				? QUICK_PATH_NODES
				: Math.min(
					MAX_RETURN_PATH_NODES,
					Math.max(QUICK_PATH_NODES, verticalSpan * 250)
				);
			double maxRadius = verticalSpan <= BoundedPathfinder.DEFAULT_MAX_VERTICAL
				? QUICK_PATH_RADIUS
				: Math.min(
					MAX_RETURN_RADIUS,
					Math.max(QUICK_PATH_RADIUS, verticalSpan + 32.0)
				);
			BoundedPathfinder.Result found = findRoute(
				client,
				start,
				goal,
				maxNodes,
				maxRadius,
				maxVertical
			);
			return routeFrom(client, goal, found);
		}

		private BoundedPathfinder.Result findRoute(
			Minecraft client,
			BoundedPathfinder.Cell start,
			BoundedPathfinder.Cell goal,
			int maxNodes,
			double maxRadius,
			int maxVertical
		) {
			return BoundedPathfinder.find(
				start,
				goal,
				acceptPartial
					? (cell) -> isNearExploreGoal(cell, goal)
					: (cell) -> isNearGoal(cell, goal),
				(x, y, z) -> standableAt(client, new BlockPos(x, y, z)),
				traversal(client),
				maxNodes,
				maxRadius,
				maxVertical
			);
		}

		private Route routeFrom(
			Minecraft client,
			BoundedPathfinder.Cell goal,
			BoundedPathfinder.Result found
		) {
			if (found == null) return null;
			List<Vec3> points = new ArrayList<>();
			for (BoundedPathfinder.Cell cell : BoundedPathfinder.compress(found.path())) {
				points.add(new Vec3(cell.x() + 0.5, cell.y(), cell.z() + 0.5));
			}
			// The requested height is the body's height when the heading was
			// chosen, not the terrain height thirty blocks away. An explore
			// goal is a column, so never append a synthetic point at the old
			// height: that made the walker stand next to the target column
			// while the completion check still called it "wrong height".
			// Exact navigation still gets the requested point when the route
			// proved that level.
			Vec3 last = points.get(points.size() - 1);
			// `isNearGoal` accepts a standable cell within one block of the
			// request. Appending the literal requested point afterwards used
			// to create a waypoint inside a solid block whenever the goal was
			// a station cell or a terraced floor: the walker circled at the
			// right column until the 60-second deadline. Only add the exact
			// point when the body can actually stand there.
			if (
				!acceptPartial
					&& found.complete()
					&& Math.abs(goal.y() - Math.floor(last.y)) <= 1
					&& standableAt(client, new BlockPos(goal.x(), goal.y(), goal.z()))
			) {
				points.add(target);
			}
			Vec3 end = points.get(points.size() - 1);
			return new Route(end, found.complete(), points);
		}

		private record Route(Vec3 destination, boolean complete, List<Vec3> waypoints) {
		}

		/**
		 * The exact target column can be a wall, a ledge or slightly outside
		 * this step's four-block reach. A nearby standable cell still makes the
		 * exploration step useful instead of failing and re-sending the same
		 * unreachable goto every cooldown.
		 */
		private static boolean isNearGoal(BoundedPathfinder.Cell cell, BoundedPathfinder.Cell goal) {
			return Math.abs(cell.x() - goal.x()) <= 1
				&& Math.abs(cell.z() - goal.z()) <= 1
				&& Math.abs(cell.y() - goal.y()) <= 1;
		}

		/**
		 * An explore heading names a column, not a floor: the terrain there
		 * can be a hill, a beach or a ravine. Requiring the original feet
		 * height made every leg end in a partial route as soon as the ground
		 * sloped by more than one block, and the closest partial cell flipped
		 * between two hillsides on every retry.
		 */
		private static boolean isNearExploreGoal(BoundedPathfinder.Cell cell, BoundedPathfinder.Cell goal) {
			return Math.abs(cell.x() - goal.x()) <= 1
				&& Math.abs(cell.z() - goal.z()) <= 1;
		}

		@Override
		void stop(Minecraft client) {
			releaseMiningInput(client);
			releaseWalkInput(client);
			CameraController.release();
			escapeWall = null;
			escapeWallSince = -1;
			ledgeTarget = null;
			escapingNoRoute = false;
			climbStep = null;
			climbHead = null;
			climbAbove = null;
			climbMining = null;
			climbObstruction = null;
			climbEquipAt = -1;
			tunneling = false;
			tunnelDirection = null;
			tunnelFeet = null;
			tunnelHead = null;
			ceilingActive = false;
			ceilingMine = null;
			ceilingPlacing = false;
			ceilingCenter = null;
			ceilingCenterSince = -1;
			pillarPlacedAt = null;
			pillarRetreat = false;
			pillarRetreatMining = false;
			bridging = false;
			bridgeClear();
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
		/**
		 * Leaves have no guaranteed drop. Wait briefly for an apple or
		 * sapling, but count the broken block even when the loot roll was
		 * empty. Without this grace the food stage failed every leaf sweep
		 * with "pickup was not confirmed" and retried forever.
		 */
		private static final int OPTIONAL_PICKUP_TICKS = 12;
		private static final int EQUIP_WAIT_TICKS = 20;
		/** A bounded search is enough for a nearby tree; never scan the render space. */
		private static final int APPROACH_PATH_NODES = 4_000;
		private static final double APPROACH_PATH_RADIUS = 56.0;
		/**
		 * A forest can contain dozens of logs in the 48-block search volume.
		 * Running a fresh A* for every candidate on a slow client turned one
		 * tick into minutes of block lookups, so the action deadline expired
		 * before the body ever started walking. Probe only the nearest few:
		 * the walk loop still replans when the chosen trunk becomes blocked.
		 */
		private static final int APPROACH_ROUTE_PROBES = 6;
		/** Diagnostics must stay bounded; never pathfind every log under a canopy. */
		private static final int DIAGNOSTIC_ROUTE_PROBES = 4;
		private final String blockId;
		private final boolean anyLog;
		private final int count;
		/** Exact cell for a reusable mine/camp blueprint, never a broad search. */
		private final BlockPos fixedTarget;
		private int mined;
		private BlockPos target;
		private BlockPos desiredTarget;
		/**
		 * The trunk this task is actually harvesting. Canopy cleanup replaces
		 * `target` with a leaf; without remembering the original log the next
		 * scan measures "canopy relevance" against a leaf and keeps choosing
		 * leaves around it instead of returning to the tree.
		 */
		private BlockPos trunkOrigin;
		private Direction side;
		private int miningAge;
		private int equipSubmittedAt = -1;
		private boolean walking;
		private int walkingAge;
		private int lastWalkProgressAge;
		private int approachTicks;
		private double lastApproachDistance = Double.POSITIVE_INFINITY;
		private List<Vec3> approachWaypoints = List.of();
		private int approachWaypoint;
		private BlockPos approachTarget;
		private int nextApproachPlanAt;
		/** Diagnostics only fire when the route state actually changes. */
		private String lastRouteLog = "";
		private BlockPos lastRouteLogTarget;
		private boolean destroying;
		private int lastReportedPercent = -1;
		private BlockState blockBeforeDestroy;
		private boolean breaking = false;
		private boolean breakingLeaves = false;
		private int replans;
		private final JsonArray minedBlocks = new JsonArray();
		private Map<String, Integer> inventoryBeforeBreak = Map.of();
		private Map<String, Integer> inventoryAfterPickup = Map.of();
		private Set<String> expectedPickupItems = Set.of();
		private int pickupStartedAt = -1;
		private BlockPos pickupBlock;
		private boolean collectingPickup;
		private ItemEntity pickupTarget;
		private int pickupLastProgressAt;
		private Vec3 pickupLastPosition;
		private boolean pickupStepDownLogged;
		/** A canopy has no standable neighbour, so descend before mining. */
		private boolean escapingCanopy;
		private int canopyEscapeStartedAge = -1;

		MineTask(String id, JsonObject args) {
			this(id, args, false);
		}

		MineTask(String id, JsonObject args, boolean anyLog) {
			super(id);
			this.anyLog = anyLog;
			this.blockId = anyLog ? null : required(args, "block");
			this.count = integer(args, "count", 1);
			this.fixedTarget = anyLog ? null : optionalBlockPos(args, "at");
			this.emergencyAction = !anyLog && flag(args, "emergency");
		}

		@Override
		boolean validate(Minecraft client) {
			if (!super.validate(client)) return false;
			if (anyLog) return true;
            ResourceLocation id = ResourceLocation.tryParse(blockId);
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
				if (equipToolFromInventory(client)) {
					equipSubmittedAt = age;
					send.accept(progress(id, "equipping", 0, count));
					return;
				}
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"no hotbar tool can harvest " + targetName()
				);
				return;
			}
			beginMining(client);
		}

		private void beginMining(Minecraft client) {
			target = fixedTarget == null ? selectTarget(client) : fixedTarget.immutable();
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
			if (fixedTarget != null && client.level.getBlockState(target).isAir()) {
				finish(
					id,
					"completed",
					null,
					null,
					alreadyOpenEvidence(target)
				);
				return;
			}
			walking = !canReach(client, client.player, target);
			lastApproachDistance = Double.POSITIVE_INFINITY;
			send.accept(progress(id, "target", 0, count));
		}

		private JsonObject alreadyOpenEvidence(BlockPos cell) {
			JsonObject outcome = new JsonObject();
			outcome.addProperty("summary", "the requested mining cell is already open");
			JsonArray changes = new JsonArray();
			JsonObject change = new JsonObject();
			change.addProperty("kind", "block_broken");
			change.addProperty(
				"detail",
				cell.getX() + "," + cell.getY() + "," + cell.getZ() + " (already air)"
			);
			changes.add(change);
			outcome.add("changes", changes);
			return outcome;
		}

		private boolean equipToolFromInventory(Minecraft client) {
			LocalPlayer player = client.player;
			Block requested = anyLog
				? null
				: BuiltInRegistries.BLOCK.get(ResourceLocation.tryParse(blockId));
			BlockState sample = requested == null
				? null
				: requested.defaultBlockState();
			if (sample == null || !sample.requiresCorrectToolForDrops() || anyLog) {
				return false;
			}
			int source = -1;
			for (int slot = 9; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (!stack.isEmpty() && stack.isCorrectToolForDrops(sample)) {
					source = slot;
					break;
				}
			}
			if (source < 0) return false;
			int hotbar = toolHotbarSlot(player);
			player.getInventory().selected = hotbar;
			player.connection.send(new ServerboundSetCarriedItemPacket(hotbar));
			client.gameMode.handleInventoryMouseClick(
				player.inventoryMenu.containerId,
				source,
				hotbar,
				ClickType.SWAP,
				player
			);
			return true;
		}

		/**
		 * Prefer an empty slot, then the least valuable non-tool stack. A hotbar
		 * full of construction blocks is common after a mining trip; swapping
		 * the pickaxe in is the human action, not a failed precondition.
		 */
		private static int toolHotbarSlot(LocalPlayer player) {
			int best = 0;
			int bestScore = Integer.MIN_VALUE;
			for (int slot = 0; slot < 9; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				int score = 0;
				if (stack.isEmpty()) score += 1_000;
				if (!stack.isEmpty() && stack.isDamageableItem()) score -= 500;
				if (!stack.isEmpty() && stack.getItem() instanceof BlockItem) score += 100;
				if (!stack.isEmpty() && stack.getItem().isEdible()) score -= 200;
				if (!stack.isEmpty()) score += Math.max(0, 20 - stack.getCount());
				if (score > bestScore) {
					bestScore = score;
					best = slot;
				}
			}
			return best;
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
				: BuiltInRegistries.BLOCK.get(ResourceLocation.tryParse(blockId));
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
				inventory.selected,
				inventory.selected
			);
			if (chosen < 0) return false;
			inventory.selected = chosen;
			return true;
		}

		/**
		 * The requested block and the next actionable block can differ after
		 * canopy retargeting. Re-check the real target every tick so a fist
		 * can never slowly grind stone.
		 */
		private static boolean ensureToolForBlock(LocalPlayer player, BlockState state) {
			if (!state.requiresCorrectToolForDrops()) return true;
			Inventory inventory = player.getInventory();
			int current = inventory.selected;
			ItemStack held = inventory.getItem(current);
			if (!held.isEmpty() && held.isCorrectToolForDrops(state)) return true;
			for (int slot = 0; slot < 9; slot++) {
				ItemStack stack = inventory.getItem(slot);
				if (!stack.isEmpty() && stack.isCorrectToolForDrops(state)) {
					inventory.selected = slot;
					return true;
				}
			}
			return false;
		}

		/** Loose ground that is always worth opening when it blocks the target. */
		private static boolean softObstruction(BlockState state) {
			return state.is(Blocks.DIRT)
				|| state.is(Blocks.GRASS_BLOCK)
				|| state.is(Blocks.SAND)
				|| state.is(Blocks.GRAVEL)
				|| state.is(Blocks.CLAY)
				|| state.is(Blocks.SNOW_BLOCK)
				|| state.is(Blocks.COARSE_DIRT)
				|| state.is(Blocks.ROOTED_DIRT);
		}

		@Override
		void tick(Minecraft client) {
			if (equipSubmittedAt >= 0) {
				if (selectTool(client)) {
					equipSubmittedAt = -1;
					beginMining(client);
					return;
				}
				if (age - equipSubmittedAt > EQUIP_WAIT_TICKS) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"could not equip a mining tool into the hotbar"
					);
				}
				return;
			}
			if (target == null) {
				finish(id, "failed", "E_PRECONDITION", "mining target is not selected");
				return;
			}
			if (escapingCanopy || onCanopy(client)) {
				if (!escapingCanopy) {
					escapingCanopy = true;
					canopyEscapeStartedAge = age;
				}
				if (CanopyEscape.timedOut(canopyEscapeStartedAge, age)) {
					stop(client);
					finish(id, "timeout", "E_TIMEOUT", "could not leave the tree canopy in time");
					return;
				}
				if (descendCanopyStep(client)) {
					if (age % 20 == 0) send.accept(progress(id, "unstick", 0, 1));
					return;
				}
				escapingCanopy = false;
				canopyEscapeStartedAge = -1;
				// A blueprint cell must survive the detour. Retargeting the
				// nearest matching block after falling out of a canopy made
				// the exact stair/branch step silently move somewhere else.
				target = fixedTarget == null ? selectTarget(client) : fixedTarget.immutable();
				if (target == null) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"no " + targetName() + " after leaving the canopy"
					);
					return;
				}
				walking = !canReach(client, client.player, target);
				lastApproachDistance = Double.POSITIVE_INFINITY;
				lastWalkProgressAge = walkingAge;
				lastReportedPercent = -1;
				return;
			}
			BlockState state = client.level.getBlockState(target);
			if (!state.isAir() && !ensureToolForBlock(client.player, state)) {
				releaseMiningInput(client);
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"no held tool can harvest " + state.getBlock()
				);
				return;
			}
			if (destroying && state.isAir()) {
				boolean wasClearingCanopy = breakingLeaves;
				stopMining(client);
				if (wasClearingCanopy) {
					// Clearing one leaf should not repeat the full 48-block
					// target search. Return to the trunk this task started
					// with and only look around if that trunk is gone.
					BlockPos anchor = cleanupAnchor();
					if (
						anchor != null
							&& matchesTarget(client.level.getBlockState(anchor))
					) {
						target = anchor;
						desiredTarget = null;
						side = Direction.UP;
						miningAge = 0;
						lastApproachDistance = Double.POSITIVE_INFINITY;
						lastWalkProgressAge = walkingAge;
						lastReportedPercent = -1;
						walking = !canReach(client, client.player, anchor);
						return;
					}
					target = selectTarget(client);
					if (target == null) {
						finish(id, "failed", "E_PRECONDITION", "no " + targetName() + " left after clearing the canopy");
						return;
					}
					walking = !canReach(client, client.player, target);
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
					walking = !canReach(client, client.player, target);
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
				pickupStepDownLogged = false;
				blockBeforeDestroy = null;
				return;
			}
			if (collectingPickup) {
				continuePickup(client);
				return;
			}
			LocalPlayer player = client.player;
			Vec3 center = Vec3.atCenterOf(target);
			if (!walking && !canReach(client, player, target)) {
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
			}
			if (!walking) {
				// The action is already selected by coordinates and reach. Keep
				// the viewer camera pointed at it, but never use the rendered
				// crosshair as a precondition for mining.
				CameraController.steerTo(player, center);
			}
			if (walking) {
				if (canReach(client, player, target)) {
					walking = false;
					walkingAge = 0;
					return;
				}
				// A tall trunk's own centre can stay outside the 4.5-block
				// eye reach even when a cell at its base can hit a lower log.
				// Treat that base cell as the approach target instead of
				// orbiting a target that can never be reached from the ground.
				// A fixed blueprint cell already names its own tunnel stand;
				// treating any nearby cell as "arrived" skipped the real
				// line-of-sight check and turned one blocked face into an
				// immediate, repeating "target is obstructed" failure.
				if (fixedTarget == null) {
					BlockPos base = ApproachRoute.interactionCells(client, target)
						.stream()
						.min(java.util.Comparator.comparingDouble(
							cell -> Math.hypot(
								cell.x() - player.getX(),
								cell.z() - player.getZ()
							)
						))
						.map(cell -> new BlockPos(cell.x(), cell.y(), cell.z()))
						.orElse(null);
					if (base != null && player.position().distanceTo(Vec3.atCenterOf(base)) < 1.5) {
						walking = false;
						walkingAge = 0;
						return;
					}
				}
				approachTicks++;
				if (approachTicks % 20 == 0) {
					// The coordinator's default command window is 30 seconds.
					// A legitimate approach can spend that long walking across
					// terrain before the first block is hit; without progress
					// frames the bridge cancels a healthy route as "deadline
					// passed" and the planner repeats it forever.
					send.accept(
						progress(
							id,
							"walking",
							approachWaypoint,
							Math.max(1, approachWaypoints.size())
						)
					);
				}
				double distance = player.position().distanceTo(center);
				if (fixedTarget == null && approachTicks % 20 == 0) {
					BlockPos visible = findBlock(client, this::matchesTarget);
					if (visible != null && canReach(client, player, visible)) {
						target = visible;
						center = Vec3.atCenterOf(target);
						distance = player.position().distanceTo(center);
						lastApproachDistance = Double.POSITIVE_INFINITY;
						walkingAge = 0;
					}
				}
				if (!target.equals(approachTarget) || approachTicks >= nextApproachPlanAt) {
					long routeStartedAt = System.nanoTime();
					ApproachRoute.Route route = ApproachRoute.to(client, target);
					// A failed search is still a completed plan. Without
					// moving the cooldown forward here, `route == null`
					// replans every tick, resets the walk state and never
					// gives the body a chance to make a single step.
					approachTarget = target;
					nextApproachPlanAt = approachTicks + 20;
					String routeState =
						route == null ? "none" : route.complete() ? "complete" : "partial";
					if (
						!routeState.equals(lastRouteLog)
							|| !target.equals(lastRouteLogTarget)
					) {
						lastRouteLog = routeState;
						lastRouteLogTarget = target;
						CraftMateBodyClient.LOGGER.info(
							"CraftMate approach route target={} route={} waypoints={} elapsedMs={} candidates={}",
							target,
							routeState,
							route == null ? 0 : route.waypoints().size(),
							(System.nanoTime() - routeStartedAt) / 1_000_000L,
							ApproachRoute.openInteractionCells(client, target).size()
						);
					}
					if (route != null && route.waypoints().size() > 1) {
						approachWaypoints = route.waypoints();
						approachWaypoint = approachWaypoints.size() > 1 ? 1 : 0;
					} else {
						approachWaypoints = List.of();
						approachWaypoint = 0;
					}
					if (route == null && fixedTarget == null) {
						BlockPos canopy = canopyNear(client, cleanupAnchor());
						boolean stalled =
							walkingAge - lastWalkProgressAge >= APPROACH_RETARGET_TICKS;
						if (
							MiningApproach.next(false, canopy != null, stalled)
								== MiningApproach.Mode.CLEAR_CANOPY
						) {
							// No standable interaction cell exists yet. Clearing
							// the trunk's own canopy is the only truthful way
							// forward once a direct approach has genuinely
							// stalled. Doing it immediately made the selected
							// leaf a new target on every tick.
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
				boolean aligned = turnTowards(player, (float) Math.toDegrees(heading));
				CameraController.steerHeading(
					player,
					player.getYRot(),
					CameraController.displayPitch(player)
				);
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
					if (canReach(client, player, leaf)) {
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
						BlockPos alternative = fixedTarget == null
							? findApproachTarget(client, target)
							: null;
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
					setWalkInput(client, aligned);
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
					BlockPos canopy = fixedTarget == null
						? canopyNear(client, cleanupAnchor())
						: null;
					if (canopy != null) {
						// A direct approach can stall on the trunk's own
						// leaves even when no path exists yet. Open that cell
						// before hopping to a different tree in the forest.
						startCanopyCleanup(client, canopy);
						return;
					}
					// The nearest log may be behind leaves or across a gap.
					// Give the agent another visible candidate instead of
					// reporting the same unreachable target every four seconds.
					BlockPos alternative = fixedTarget == null
						? findApproachTarget(client, target)
						: null;
					if (alternative != null) {
						target = alternative;
						center = Vec3.atCenterOf(target);
						lastApproachDistance = Double.POSITIVE_INFINITY;
						lastWalkProgressAge = walkingAge;
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
			BlockHitResult hit = BlockInteraction.nearestExposedHit(
				client.level,
				player.getEyePosition(),
				target
			);
			aimBodyAt(player, hit.getLocation());
			CameraController.steerTo(player, center);
			if (!breaking) {
				inventoryBeforeBreak = inventoryCounts(client.player);
				blockBeforeDestroy = client.level.getBlockState(target);
				expectedPickupItems = MiningDrops.expectedFor(blockBeforeDestroy);
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
				client.hitResult = hit;
				if (!client.gameMode.isDestroying()) {
					// Prediction can roll back a completed break when the
					// server has not reached the same progress yet. A player
					// holding attack simply starts the next swing; without
					// this restart, `breaking` stayed true while no destroy
					// was active and the task looked frozen for 25 seconds.
					client.gameMode.startDestroyBlock(
						target,
						hit.getDirection()
					);
				}
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
			Map<String, Integer> gained = MiningPickupEvidence.expectedGains(
				MiningPickupEvidence.gains(inventoryBeforeBreak, inventory),
				expectedPickupItems
			);
			if (!gained.isEmpty()) {
				advanceAfterPickup(client, inventory, true);
				return;
			}
			if (MiningPickupEvidence.optionalPickupSettled(
				expectedPickupItems,
				age - pickupStartedAt,
				OPTIONAL_PICKUP_TICKS
			) && nearestDrop(client, pickupBlock) == null) {
				advanceAfterPickup(client, inventory, false);
				return;
			}
			if (age - pickupStartedAt > PICKUP_TIMEOUT_TICKS) {
				if (MiningPickupEvidence.pickupOptional(expectedPickupItems)) {
					advanceAfterPickup(client, inventory, false);
					return;
				}
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
				if (MiningPickupEvidence.pickupOptional(expectedPickupItems)) {
					advanceAfterPickup(client, inventory, false);
					return;
				}
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
				evidence.addProperty("expectedPickup", expectedPickupItems.toString());
				finish(id, "failed", "E_PRECONDITION", "drop is not reachable", evidence);
				return;
			}
			Vec3 direction = position.subtract(client.player.position());
			double horizontal = Math.hypot(direction.x, direction.z);
			boolean aligned = true;
			if (horizontal > 0.01) {
				aligned = turnTowards(
					client.player,
					(float) Math.toDegrees(Math.atan2(-direction.x, direction.z))
				);
				CameraController.steerHeading(
					client.player,
					client.player.getYRot(),
					CameraController.displayPitch(client.player)
				);
			}
			boolean dropBelow = PickupApproach.shouldJumpDown(
				client.player.getY(),
				position.y,
				client.player.onGround(),
				client.level
					.getBlockState(BlockPos.containing(position.x, position.y - 0.4, position.z))
					.getFluidState()
					.is(FluidTags.LAVA)
			);
			if (dropBelow) {
				// A mined block often leaves a one-cell pit at the body's
				// feet. Walking into the lip does not enter it, so the drop
				// stays visible but can never be collected. A small jump is
				// how a player drops into their own shaft; lava is excluded.
				client.player.jumpFromGround();
				if (!pickupStepDownLogged) {
					pickupStepDownLogged = true;
					CraftMateBodyClient.LOGGER.info(
						"CraftMate pickup step down target={} player={} drop={}",
						pickupBlock,
						client.player.position(),
						position
					);
				}
			} else if (client.player.horizontalCollision && client.player.onGround()) {
				client.player.jumpFromGround();
			}
			if (client.player.input != null) setWalkInput(client, aligned);
			if (age % 20 == 0) send.accept(progress(id, "collecting", mined, count));
		}

		private void advanceAfterPickup(
			Minecraft client,
			Map<String, Integer> inventory,
			boolean pickupConfirmed
		) {
			inventoryAfterPickup = inventory;
			mined = Math.max(mined, minedBlocks.size());
			if (mined >= count) {
				completeMining(client, pickupConfirmed);
				return;
			}
			collectingPickup = false;
			pickupTarget = null;
			releaseWalkInput(client);
			desiredTarget = null;
			target = selectTarget(client);
			if (target == null) {
				failPartialMining(client, "附近找不到更多");
				return;
			}
			side = Direction.UP;
			miningAge = 0;
			walking = !canReach(client, client.player, target);
			lastApproachDistance = Double.POSITIVE_INFINITY;
			lastReportedPercent = -1;
		}

		private void completeMining(Minecraft client, boolean pickupConfirmed) {
			stopMining(client);
			releaseWalkInput(client);
			boolean pickupRequired = !MiningPickupEvidence.pickupOptional(expectedPickupItems);
			JsonObject evidence = outcome(
				(anyLog ? "砍下并拾取 " : "挖掉") +
					(pickupConfirmed ? "并拾取 " : pickupRequired ? "，但 " : "，不必掉落 ") +
					mined +
					" 个" +
					targetName(),
				minedBlocks,
				null
			);
			evidence.add("mined", minedBlocks);
			JsonObject pickup = new JsonObject();
			pickup.addProperty("required", pickupRequired);
			pickup.addProperty("confirmed", pickupConfirmed);
			JsonArray gained = new JsonArray();
			Map<String, Integer> confirmed = MiningPickupEvidence.expectedGains(
				MiningPickupEvidence.gains(inventoryBeforeBreak, inventoryAfterPickup),
				expectedPickupItems
			);
			for (var entry : confirmed.entrySet()) {
				JsonObject change = new JsonObject();
				change.addProperty("item", entry.getKey());
				change.addProperty("count", entry.getValue());
				gained.add(change);
			}
			pickup.add("gained", gained);
			evidence.add("pickup", pickup);
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
			Vec3 originCenter = Vec3.atCenterOf(origin);
			double maxDistanceSqr = 12.0 * 12.0;
			return client.level
				.getEntitiesOfClass(
					ItemEntity.class,
					client.player.getBoundingBox().inflate(COLLECT_SEARCH_RADIUS)
				)
				.stream()
				.filter(ItemEntity::isAlive)
				.filter(entity -> MiningDrops.matches(entity.getItem(), expectedPickupItems))
				.filter(entity -> entity.position().distanceToSqr(originCenter) <= maxDistanceSqr)
				.min(Comparator.comparingDouble(entity -> entity.position().distanceToSqr(originCenter)))
				.orElse(null);
		}

		private JsonObject miningResult(LocalPlayer player, BlockPos position, BlockState state) {
			JsonObject evidence = new JsonObject();
			evidence.addProperty("block", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
			ItemStack tool = player.getInventory().getSelected();
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
			Block block = BuiltInRegistries.BLOCK.get(ResourceLocation.tryParse(blockId));
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
			return findApproachTarget(client, excluded, true);
		}

		private BlockPos findApproachTarget(
			Minecraft client,
			BlockPos excluded,
			boolean allowUnreachableFallback
		) {
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
			int probes = 0;
			for (BlockPos candidate : candidates) {
				if (probes++ >= APPROACH_ROUTE_PROBES) break;
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
			if (candidates.isEmpty() || !allowUnreachableFallback) return null;
			// Prefer a log the body can already reach or see. It is both the
			// cheapest first chop and avoids an immediate obstruction failure.
			for (BlockPos candidate : candidates) {
				if (canReach(client, client.player, candidate)) {
					return candidate;
				}
			}
			return candidates.get(0);
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
					4.5
				)) continue;
				if (!canInteract(client, client.player, candidate)) continue;
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
					4.5
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
			walking = !canReach(client, client.player, canopy);
			breaking = false;
			breakingLeaves = true;
			approachWaypoints = List.of();
			approachWaypoint = 0;
			approachTarget = null;
			approachTicks = 0;
			nextApproachPlanAt = 0;
			lastApproachDistance = Double.POSITIVE_INFINITY;
			lastWalkProgressAge = walkingAge;
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
			evidence.addProperty("canReach", canReach(client, client.player, attempted));
			evidence.addProperty("canInteract", canInteract(client, client.player, attempted));
			return evidence;
		}

		/** Canopy relevance is measured from the trunk, never from a leaf. */
		private BlockPos cleanupAnchor() {
			return trunkOrigin != null ? trunkOrigin : target;
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
					trunkOrigin = reachable;
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
					trunkOrigin = visible;
					return visible;
				}
				BlockPos nearby = findBlockUnclipped(client, state -> state.is(BlockTags.LOGS));
				desiredTarget = null;
				trunkOrigin = nearby;
				return nearby;
			}
			// Generic gathering is not a blueprint cell. Prefer a block with a
			// real walking route; a stone five blocks below a pit can be
			// visible through the hole yet have no way to stand beside it,
			// and pinning it produced an approach-retry loop every tick.
			BlockPos approachable = findApproachTarget(client, null, false);
			if (approachable != null) {
				desiredTarget = null;
				return approachable;
			}
			BlockPos direct = findTarget(client);
			if (
				direct != null &&
				plausibleLocalTarget(client.player.blockPosition(), direct)
			) {
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
			Vec3 eye = client.player.getEyePosition();
			List<BlockPos> candidates = new ArrayList<>();
			for (BlockPos pos : BlockPos.betweenClosed(
				origin.offset(-16, -16, -16),
				origin.offset(16, 16, 16)
			)) {
				BlockPos candidate = pos.immutable();
				if (!matchesTarget(client.level.getBlockState(candidate))) continue;
				double distance = candidate.distSqr(origin);
				if (distance > 16 * 16) continue;
				if (removesCurrentSupport(client.player, candidate)) continue;
				if (!plausibleLocalTarget(origin, candidate)) continue;
				candidates.add(candidate);
			}
			candidates.sort(
				Comparator.comparingDouble(candidate -> eye.distanceToSqr(Vec3.atCenterOf(candidate)))
			);
			for (BlockPos candidate : candidates) {
				if (BlockInteraction.hasExposedFace(client.level, candidate)) return candidate;
			}
			return null;
		}

		/**
		 * A block five floors below an open pit is visible but not a surface
		 * gathering target. Real underground work uses the planned stair or an
		 * ore-specific cave search, never the opportunistic nearest-block scan.
		 */
		private static boolean plausibleLocalTarget(BlockPos origin, BlockPos candidate) {
			int dy = candidate.getY() - origin.getY();
			return dy >= -3 && dy <= 4;
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
			if (best == null && isOreRequest()) {
				// A cave wall can hide an entire iron vein while the count-only
				// survey still reports it. Mine out the first block between the
				// eye and the nearest ore; the next tick advances the same ray
				// until the vein itself is exposed.
				BlockPos ore = nearestHiddenOre(client);
				if (ore != null) {
					BlockPos blocker = firstTunnelBlocker(client, ore);
					if (blocker != null) {
						desiredTarget = ore;
						best = blocker;
					}
				}
			}
			return best;
		}

		private boolean isOreRequest() {
			return blockId != null && isOreId(blockId);
		}

		private BlockPos nearestHiddenOre(Minecraft client) {
			BlockPos origin = client.player.blockPosition();
			BlockPos best = null;
			double bestDistance = 12.0 * 12.0;
			for (BlockPos pos : BlockPos.betweenClosed(
				origin.offset(-12, -5, -12),
				origin.offset(12, 5, 12)
			)) {
				BlockPos candidate = pos.immutable();
				if (!matchesTarget(client.level.getBlockState(candidate))) continue;
				if (removesCurrentSupport(client.player, candidate)) continue;
				double distance = candidate.distSqr(origin);
				if (distance >= bestDistance) continue;
				bestDistance = distance;
				best = candidate;
			}
			return best;
		}

		/**
		 * First solid block between the body and an ore. This is a geometric
		 * voxel walk, not the rendered crosshair ray, so the camera can point
		 * anywhere while the body opens a route to the ore.
		 */
		private BlockPos firstTunnelBlocker(Minecraft client, BlockPos desired) {
			Vec3 from = client.player.position().add(0, client.player.getEyeHeight() * 0.5, 0);
			Vec3 to = Vec3.atCenterOf(desired);
			Vec3 delta = to.subtract(from);
			double length = delta.length();
			if (length < 1.0e-6) return desired;
			int samples = Math.max(1, (int) Math.ceil(length * 8.0));
			BlockPos previous = null;
			for (int step = 1; step <= samples; step++) {
				Vec3 point = from.add(delta.scale(step / (double) samples));
				BlockPos cell = BlockPos.containing(point);
				if (cell.equals(previous)) continue;
				previous = cell;
				if (cell.equals(client.player.blockPosition()) || cell.equals(client.player.blockPosition().above())) {
					continue;
				}
				BlockState state = client.level.getBlockState(cell);
				if (state.isAir()) continue;
				if (!state.getFluidState().isEmpty()) return null;
				if (cell.equals(desired)) return desired;
				if (removesCurrentSupport(client.player, cell)) return null;
				if (!tunnelCellMineable(client, cell, state)) return null;
				if (!BlockInteraction.hasExposedFace(client.level, cell)) continue;
				return cell;
			}
			return desired;
		}

		private boolean tunnelCellMineable(
			Minecraft client,
			BlockPos pos,
			BlockState state
		) {
			if (state.isAir() || !state.getFluidState().isEmpty()) return false;
			if (state.getDestroySpeed(client.level, pos) < 0.0f) return false;
			if (
				state.is(Blocks.CRAFTING_TABLE)
					|| state.is(Blocks.FURNACE)
					|| state.is(Blocks.BLAST_FURNACE)
					|| state.is(Blocks.SMOKER)
					|| state.is(Blocks.CHEST)
					|| state.is(Blocks.TRAPPED_CHEST)
					|| state.is(Blocks.BARREL)
					|| state.getBlock() instanceof BedBlock
			) {
				return false;
			}
			if (!state.requiresCorrectToolForDrops()) return true;
			Inventory inventory = client.player.getInventory();
			for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = inventory.getItem(slot);
				if (!stack.isEmpty() && stack.isCorrectToolForDrops(state)) return true;
			}
			return false;
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
			ItemStack tool = client.player.getInventory().getSelected();
			return state.is(BlockTags.DIRT)
				|| state.is(BlockTags.SAND)
				|| state.is(BlockTags.SNOW)
				|| state.is(BlockTags.LEAVES)
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
			return state.is(BuiltInRegistries.BLOCK.get(ResourceLocation.tryParse(blockId)));
		}

		/**
		 * Returns the topmost natural cover above the desired block, or the
		 * desired block when nothing covers it. Only soil-like blocks are
		 * removed, so this never digs through a player-made wall or a tree.
		 */
		private BlockPos nextCoverOrTarget(Minecraft client, BlockPos desired) {
			if (isOreRequest()) {
				return firstTunnelBlocker(client, desired);
			}
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
			// Leaves are just as common a roof over a shallow stone outcrop as
			// soil. Treating them as opaque made the body report "no stone"
			// while the diagnostic counted hundreds of stone blocks under the
			// canopy; the covered-target state machine can remove them safely.
			return state.is(BlockTags.DIRT)
				|| state.is(BlockTags.SAND)
				|| state.is(BlockTags.SNOW)
				|| state.is(BlockTags.LEAVES);
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
				standableAt(client, origin)
			);
			evidence.addProperty("blockInteractionRange", 4.5);
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
						entry.addProperty("standable", standableAt(client, spot));
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

		private static boolean canReach(Minecraft client, LocalPlayer player, BlockPos target) {
			return canTouchBlock(client, player.getEyePosition(), target);
		}

		private static boolean canInteract(Minecraft client, LocalPlayer player, BlockPos target) {
			// Interaction packets carry a block coordinate and face. The
			// server validates reach; it never asks the rendered camera to be
			// centred on the target.
			return canTouchBlock(client, player.getEyePosition(), target);
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
			if (itemId != null && ResourceLocation.tryParse(itemId) == null) {
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
			boolean aligned = turnTowards(
				client.player,
				(float) Math.toDegrees(Math.atan2(-direction.x, direction.z))
			);
			CameraController.steerHeading(
				client.player,
				client.player.getYRot(),
				CameraController.displayPitch(client.player)
			);
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
			boolean dropBelow = PickupApproach.shouldJumpDown(
				client.player.getY(),
				target.position().y,
				client.player.onGround(),
				client.level
					.getBlockState(
						BlockPos.containing(
							target.position().x,
							target.position().y - 0.4,
							target.position().z
						)
					)
					.getFluidState()
					.is(FluidTags.LAVA)
			);
			if (dropBelow) {
				client.player.jumpFromGround();
			} else if (client.player.horizontalCollision && client.player.onGround()) {
				client.player.jumpFromGround();
			}
			if (client.player.input != null) setWalkInput(client, aligned);
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
			Item item = itemId == null ? null : BuiltInRegistries.ITEM.get(ResourceLocation.tryParse(itemId));
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
		private RecipeBookMenu<?> menu;
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
		private ManualPlacement manualPlacement;
		private int manualSlot;
		private int manualPhase;
		private int manualSourceIndex = -1;
		private int manualTargetIndex = -1;
		private List<Integer> manualTargets = List.of();
		private int roomDrops;
		private RecipeChoice submittedChoice;

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
			ResourceLocation id = ResourceLocation.tryParse(itemId);
			if (id == null || !BuiltInRegistries.ITEM.containsKey(id)) {
				validationError = "unknown item " + itemId;
				return false;
			}
			item = BuiltInRegistries.ITEM.get(id);
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
					if (playerToTable(player) > 6.0) {
						stop(client);
						finish(
							id,
							"failed",
							"E_PRECONDITION",
							"no safe route to the crafting table",
							approachEvidence(client, "the station is visible but unreachable")
						);
						return;
					}
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
			boolean aligned = turnTowards(player, (float) Math.toDegrees(heading));
			CameraController.steerHeading(
				player,
				player.getYRot(),
				CameraController.displayPitch(player)
			);
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
			if (player.input != null) setWalkInput(client, aligned);
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
				RecipeBookMenu<?> opened = client.screen instanceof AbstractContainerScreen<?> screen
					&& screen.getMenu() instanceof RecipeBookMenu<?> craftMenu
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
				CameraController.steerTo(client.player, Vec3.atCenterOf(tablePos));
				BlockHitResult hit = stationHit(client.player, tablePos);
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
							"crafting table is outside interaction reach",
							evidence("could not reach the table")
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
			RecipeBookMenu<?> current = client.screen instanceof AbstractContainerScreen<?> screen
				&& screen.getMenu() instanceof RecipeBookMenu<?> value
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
				Slot existing = resultSlot(current);
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
					saveHomeMemory();
				}
				if ("minecraft:chest".equals(itemId)) {
					chestCrafted = true;
					saveHomeMemory();
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
				Slot result = resultSlot(current);
				boolean resultReady = result != null
					&& !result.getItem().isEmpty()
					&& result.getItem().getItem() == item;
				if (!inputs.equals(inputsBefore) || resultReady) {
					gridReadyAt = age;
					gridSubmitAt = -1;
					submittedChoice = null;
					send.accept(progress(id, "crafting", made, requested));
				} else if (age - gridSubmitAt > CRAFT_GRID_TIMEOUT) {
					RecipeChoice fallback = submittedChoice;
					gridSubmitAt = -1;
					submittedChoice = null;
					CraftMateBodyClient.LOGGER.info(
						"craft grid timeout recipe={} fallback={} craftable={}",
						itemId,
						fallback != null,
						fallback != null && fallback.craftable()
					);
					// The recipe-book packet can be accepted by the client but
					// silently ignored by the server when the backpack is
					// completely full. Lay out the same known-craftable recipe
					// by hand instead of backing the whole goal off.
					if (
						fallback != null
						&& fallback.craftable()
						&& startManualPlacement(client, current, fallback)
					) return;
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
				Slot result = resultSlot(current);
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
					if (dropBulkForRoom(client, current)) return;
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
			if (!recipeBookContains(client, choice.recipe())) {
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
					if (dropBulkForRoom(client, current)) return;
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
				if (!startManualPlacement(client, current, choice)) {
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
				if (dropBulkForRoom(client, current)) return;
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
			inputsBefore = gridCounts(current);
			gridSubmitAt = age;
			submittedChoice = choice;
			client.gameMode.handlePlaceRecipe(current.containerId, choice.recipe(), false);
			send.accept(progress(id, "placing_ingredients", made, requested));
		}

		/**
		 * A long mining trip can leave every slot occupied by stone and dirt.
		 * Vanilla refuses to move the craft result into a full backpack, so a
		 * human throws away the least useful bulk stack and continues. Keep
		 * the action bounded and never drop tools, food or ores.
		 */
		private boolean dropBulkForRoom(Minecraft client, AbstractContainerMenu current) {
			if (roomDrops >= 2) return false;
			Map<String, Integer> inventory = inventoryCounts(client.player);
			String[] candidates = {
				"minecraft:dirt",
				"minecraft:gravel",
				"minecraft:andesite",
				"minecraft:diorite",
				"minecraft:granite",
				"minecraft:tuff",
				"minecraft:cobblestone",
			};
			for (String candidate : candidates) {
				int total = inventory.getOrDefault(candidate, 0);
				if (candidate.equals("minecraft:cobblestone") && total <= 96) continue;
				if (!candidate.equals("minecraft:cobblestone") && total < 16) continue;
				int slotIndex = findDroppableSlot(current, candidate);
				if (slotIndex < 0) continue;
				roomDrops++;
				client.gameMode.handleInventoryMouseClick(
					current.containerId,
					slotIndex,
					1,
					ClickType.THROW,
					client.player
				);
				send.accept(progress(id, "making_room", made, requested));
				return true;
			}
			return false;
		}

		private int findDroppableSlot(AbstractContainerMenu current, String itemId) {
			for (int index = 0; index < current.slots.size(); index++) {
				Slot slot = current.getSlot(index);
				if (!(slot.container instanceof Inventory)) continue;
				if (slot.getContainerSlot() >= Inventory.INVENTORY_SIZE) continue;
				ItemStack stack = slot.getItem();
				if (stack.isEmpty() || stack.getCount() < 16) continue;
				if (
					BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(itemId)
				) {
					return index;
				}
			}
			return -1;
		}

		private boolean startManualPlacement(
			Minecraft client,
			RecipeBookMenu<?> current,
			RecipeChoice choice
		) {
			CraftMateBodyClient.LOGGER.info(
				"craft manual begin recipe={} grid={}x{} choiceGrid={}x{}",
				choice.recipe().getId(),
				current.getGridWidth(),
				current.getGridHeight(),
				choice.width(),
				choice.height()
			);
			List<Ingredient> recipeIngredients = choice.recipe().getIngredients();
			List<Slot> grid = inputGridSlots(current);
			List<Integer> targetCells;
			if (choice.recipe() instanceof ShapedRecipe) {
				List<Integer> allCells = CraftGridLayout.centeredTargets(
					recipeIngredients.size(), choice.width(), choice.height(),
					current.getGridWidth(), current.getGridHeight()
				);
				if (allCells.size() != recipeIngredients.size()) {
					CraftMateBodyClient.LOGGER.info(
						"craft manual layout mismatch cells={} ingredients={} recipe={} size={}x{}",
						allCells.size(),
						recipeIngredients.size(),
						choice.recipe().getId(),
						choice.width(),
						choice.height()
					);
					return false;
				}
				targetCells = new ArrayList<>();
				List<Ingredient> activeIngredients = new ArrayList<>();
				for (int index = 0; index < recipeIngredients.size(); index++) {
					Ingredient ingredient = recipeIngredients.get(index);
					if (ingredient.isEmpty()) continue;
					activeIngredients.add(ingredient);
					targetCells.add(allCells.get(index));
				}
				recipeIngredients = activeIngredients;
			} else {
				targetCells = new ArrayList<>();
				for (int index = 0; index < recipeIngredients.size(); index++) targetCells.add(index);
			}
			if (recipeIngredients.isEmpty() || targetCells.size() != recipeIngredients.size()) {
				CraftMateBodyClient.LOGGER.info(
					"craft manual targets invalid ingredients={} targets={} recipe={}",
					recipeIngredients.size(),
					targetCells.size(),
					choice.recipe().getId()
				);
				return false;
			}
			manualTargets = targetCells;
			// Refuse to start unless every demanded cell has a matching stack
			// somewhere in the player's inventory. This keeps a half-placed
			// grid from looking like a server rejection.
			for (int index = 0; index < recipeIngredients.size(); index++) {
				Ingredient ingredient = recipeIngredients.get(index);
				int gridIndex = manualTargets.get(index);
				if (gridIndex < 0 || gridIndex >= grid.size()) {
					CraftMateBodyClient.LOGGER.info(
						"craft manual grid index invalid index={} slot={} grid={}",
						index,
						gridIndex,
						grid.size()
					);
					return false;
				}
				final Slot gridSlot = grid.get(gridIndex);
				boolean available = current.slots.stream().anyMatch(slot ->
					!slot.getItem().isEmpty()
						&& slot != gridSlot
						&& ingredient.test(slot.getItem())
				);
				if (!available) {
					CraftMateBodyClient.LOGGER.info(
						"craft manual ingredient unavailable index={} recipe={} inventory={}",
						index,
						choice.recipe().getId(),
						inventoryCounts(client.player)
					);
					return false;
				}
			}
			manualPlacement = new ManualPlacement(List.copyOf(recipeIngredients));
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

		private void manualPlace(Minecraft client, RecipeBookMenu<?> current) {
			List<Slot> grid = inputGridSlots(current);
			if (manualSlot >= manualPlacement.ingredients().size()) {
				manualPlacement = null;
				gridReadyAt = age;
				send.accept(progress(id, "crafting", made, requested));
				return;
			}
			Ingredient ingredient = manualPlacement.ingredients().get(manualSlot);
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
					if (!ingredient.test(target.getItem())) {
						failManualPlacement(client, "the crafting grid contains an incompatible ingredient");
						return;
					}
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
				resultSlot(current).getItem()
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

		private int findIngredientSlot(RecipeBookMenu<?> current, Ingredient ingredient, Slot target) {
			for (int index = 0; index < current.slots.size(); index++) {
				Slot slot = current.getSlot(index);
				if (slot == target || slot == resultSlot(current)) continue;
				if (inputGridSlots(current).contains(slot)) continue;
				if (!slot.getItem().isEmpty() && ingredient.test(slot.getItem())) return index;
			}
			return -1;
		}

		private int slotIndex(RecipeBookMenu<?> current, Slot slot) {
			for (int index = 0; index < current.slots.size(); index++) {
				if (current.getSlot(index) == slot) return index;
			}
			return -1;
		}

		private boolean recipeBookContains(Minecraft client, Recipe<?> recipe) {
			return client.player.getRecipeBook().contains(recipe);
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
				if (ItemStack.isSameItemSameTags(stack, result)) {
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
			StackedContents contents = new StackedContents();
			client.player.getInventory().fillStackedContents(contents);
			RecipeChoice fallback = null;
			for (RecipeCollection collection : client.player.getRecipeBook().getCollections()) {
				for (Recipe<?> recipe : collection.getRecipes()) {
					if (!(recipe instanceof CraftingRecipe craftingRecipe) || !produces(recipe, client)) continue;
					if (!fits(craftingRecipe, width, height)) continue;
					int output = outputCount(recipe, client);
					if (output <= 0) continue;
					boolean craftable = contents.canCraft(recipe, new it.unimi.dsi.fastutil.ints.IntArrayList());
					RecipeChoice choice = recipeChoice(craftingRecipe, output, craftable, width, height);
					if (craftable && made + output >= requested) {
						return choice;
					}
					if (fallback == null || (craftable && !fallback.craftable())) fallback = choice;
				}
			}
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
			StackedContents contents,
			int width,
			int height
		) {
			MinecraftServer server = client.getSingleplayerServer();
			if (server == null) return null;
			RecipeManager manager = server.getRecipeManager();
			RecipeChoice fallback = null;
			for (Recipe<?> recipe : manager.getRecipes()) {
				if (!(recipe instanceof CraftingRecipe craftingRecipe) || !produces(recipe, client)) continue;
				if (!fits(craftingRecipe, width, height)) continue;
				int output = outputCount(recipe, client);
				if (output <= 0) continue;
				boolean craftable = contents.canCraft(recipe, new it.unimi.dsi.fastutil.ints.IntArrayList());
				RecipeChoice choice = recipeChoice(craftingRecipe, output, craftable, width, height);
				if (choice.craftable() && made + choice.output() >= requested) return choice;
				if (fallback == null || (choice.craftable() && !fallback.craftable())) fallback = choice;
			}
			return fallback;
		}

		private boolean hasInventoryRecipe(Minecraft client) {
			for (RecipeCollection collection : client.player.getRecipeBook().getCollections()) {
				for (Recipe<?> recipe : collection.getRecipes()) {
					if (recipe instanceof CraftingRecipe craftingRecipe && fits(craftingRecipe, 2, 2) && produces(recipe, client)) return true;
				}
			}
			return false;
		}

		private boolean fits(CraftingRecipe recipe, int width, int height) {
			return recipe.canCraftInDimensions(width, height);
		}

		private boolean produces(Recipe<?> recipe, Minecraft client) {
			ItemStack result = recipe.getResultItem(client.level.registryAccess());
			return !result.isEmpty() && result.getItem() == item;
		}

		private int outputCount(Recipe<?> recipe, Minecraft client) {
			ItemStack result = recipe.getResultItem(client.level.registryAccess());
			return !result.isEmpty() && result.getItem() == item ? result.getCount() : 0;
		}

		private RecipeChoice recipeChoice(CraftingRecipe recipe, int output, boolean craftable, int gridWidth, int gridHeight) {
			int width = recipe instanceof ShapedRecipe shaped ? shaped.getWidth() : Math.min(gridWidth, Math.max(1, recipe.getIngredients().size()));
			int height = recipe instanceof ShapedRecipe shaped ? shaped.getHeight() : Math.max(1, (recipe.getIngredients().size() + width - 1) / width);
			return new RecipeChoice(recipe, output, craftable, width, height);
		}

		private Slot resultSlot(RecipeBookMenu<?> current) {
			return current.getSlot(current.getResultSlotIndex());
		}

		private List<Slot> inputGridSlots(RecipeBookMenu<?> current) {
			int count = current.getGridWidth() * current.getGridHeight();
			List<Slot> grid = new ArrayList<>(count);
			for (int index = 1; index <= count; index++) grid.add(current.getSlot(index));
			return grid;
		}

		private Map<String, Integer> gridCounts(RecipeBookMenu<?> current) {
			Map<String, Integer> counts = new LinkedHashMap<>();
			for (Slot slot : inputGridSlots(current)) {
				ItemStack stack = slot.getItem();
				if (stack.isEmpty()) continue;
				String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				counts.merge(id, stack.getCount(), Integer::sum);
			}
			return counts;
		}

		private int resultSlotIndex(RecipeBookMenu<?> current, Slot result) {
			return result == resultSlot(current) ? current.getResultSlotIndex() : -1;
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
			return stationReachable(player, target);
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

		private record RecipeChoice(CraftingRecipe recipe, int output, boolean craftable, int width, int height) {
		}

		private record ManualPlacement(List<Ingredient> ingredients) {
		}
	}

	private static final class DepositTask extends Task {
		private static final int WALK_BUDGET_TICKS = 20 * 15;
		private static final int APPROACH_STALL_TICKS = 20 * 3;
		private static final int MENU_TIMEOUT_TICKS = 20;
		private final String itemId;
		private final BlockPos requestedContainer;
		private final int maxStacks;
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
		private int transferredStacks;
		private final Map<String, Integer> deposited = new java.util.LinkedHashMap<>();

		DepositTask(
			String id,
			String itemId,
			BlockPos requestedContainer,
			int maxStacks
		) {
			super(id);
			this.itemId = itemId;
			this.requestedContainer = requestedContainer;
			this.maxStacks = Math.max(1, maxStacks);
		}

		@Override
		boolean validate(Minecraft client) {
			if (!super.validate(client)) return false;
			if (itemId != null) {
				ResourceLocation id = ResourceLocation.tryParse(itemId);
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
			boolean aligned = turnTowards(player, (float) Math.toDegrees(heading));
			CameraController.steerHeading(
				player,
				player.getYRot(),
				CameraController.displayPitch(player)
			);
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
			if (player.input != null) setWalkInput(client, aligned);
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
					rememberChestCapacity(menu);
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
			CameraController.steerTo(client.player, Vec3.atCenterOf(current));
			BlockHitResult hit = stationHit(client.player, current);
			if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(current)) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
						"container is outside interaction reach",
						evidence("could not reach the container")
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
			rememberChestCapacity(currentMenu);
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
					transferredStacks++;
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
				if (transferredStacks >= maxStacks) {
					complete(client, null);
					return;
				}
				if (!hasEligibleItems(client)) {
					complete(client, null);
					return;
				}
				return;
			}
			if (transferredStacks >= maxStacks) {
				complete(client, null);
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
				if (!slot.mayPickup(player)) continue;
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
					ItemStack.isSameItemSameTags(existing, stack)
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

		private void rememberChestCapacity(AbstractContainerMenu current) {
			if (containerPos == null) return;
			int containerSlots = containerSlotCount(current);
			if (containerSlots <= 0) return;
			int empty = 0;
			for (int index = 0; index < containerSlots; index++) {
				if (current.getSlot(index).getItem().isEmpty()) empty++;
			}
			noteObservedChestCapacity(containerPos, empty);
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
			return withinInteractionRange(player, target);
		}

		private boolean canInteract(Minecraft client, LocalPlayer player, BlockPos target) {
			return reachesContainer(player, target);
		}

		@Override
		void stop(Minecraft client) {
			releaseWalkInput(client);
			closeOwnMenu(client);
		}
	}

	/**
	 * A human-safe mining trip: cut a one-block staircase down to the requested
	 * layer, then drive a two-high branch tunnel so the body actually exposes
	 * new stone instead of wandering across the surface looking for an ore.
	 * Every descent removes the front pair and the step below it, while the
	 * block under the next stance must stay solid. That preserves a walkable
	 * route back out and refuses lava, water and unbreakable targets.
	 */
	private static final class DescendTask extends Task {
		private static final int MAX_TICKS = 20 * 240;
		private static final int BREAK_TIMEOUT_TICKS = 20 * 20;
		private static final int STEP_TIMEOUT_TICKS = 20 * 5;
		private static final int PICKUP_SETTLE_TICKS = 12;
		private static final int EQUIP_WAIT_TICKS = 20;
		private static final Direction[] HORIZONTAL = {
			Direction.NORTH,
			Direction.EAST,
			Direction.SOUTH,
			Direction.WEST,
		};
		private final int targetY;
		private final int branchLength;
		private final boolean rememberMine;
		private final Map<String, Integer> inventoryBefore = new LinkedHashMap<>();
		private final JsonArray brokenBlocks = new JsonArray();
		private int directionIndex;
		private List<BlockPos> pendingBlocks = List.of();
		private Direction pendingDirection;
		private int pendingDestinationY;
		private int stepStartedAt = -1;
		private int stepOriginY;
		private int stepStartX;
		private int stepStartZ;
		private BlockPos breakingBlock;
		private BlockState breakingState;
		private int breakingStartedAt = -1;
		private int descended;
		private int branchTravelled;
		private int branchOpened;
		private boolean pendingOpensBranch;
		private int progressTotal = 1;
		private int lastProgressAt;
		private int finishedAt = -1;
		private int equipSubmittedAt = -1;
		private int toolSwapAt = -1;

		DescendTask(String id, int targetY, int branchLength, boolean rememberMine) {
			super(id);
			this.targetY = Math.max(-58, Math.min(300, targetY));
			this.branchLength = Math.max(0, Math.min(64, branchLength));
			this.rememberMine = rememberMine;
		}

		@Override
		void start(Minecraft client) {
			prepareDescent(client, true);
		}

		/**
		 * A backup pickaxe in the backpack is part of the current tool budget.
		 * Selecting only from the hotbar made the body reject a descent while a
		 * full pickaxe sat one swap away, then fail again on the same worn tool.
		 */
		private boolean prepareDescent(Minecraft client, boolean allowSwap) {
			LocalPlayer player = client.player;
			int depth = player.blockPosition().getY() - targetY;
			int required = PickaxeBudget.requiredUses(depth, branchLength);
			boolean needsStone = MiningDepth.requiresStonePickaxe(depth);
			PickaxeBudget.Candidate chosen = bestPickaxe(player, needsStone, required);
			if (chosen == null) {
				PickaxeBudget.Candidate primitive = bestPickaxe(player, false, required);
				String detail = primitive == null
					? "no pickaxe in the backpack for a mining descent"
					: "a wooden pickaxe cannot safely descend " + depth
						+ " blocks; craft a stone pickaxe first";
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					detail,
					evidence("the body would spend the whole tool before it could climb back")
				);
				return false;
			}
			if (chosen.slot() >= 9) {
				if (!allowSwap) return false;
				if (!swapPickaxeIntoHotbar(client, chosen.slot())) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"could not move the available pickaxe into the hotbar",
						evidence("the body cannot use the pickaxe in its backpack")
					);
					return false;
				}
				equipSubmittedAt = age;
				send.accept(progress(id, "equipping", 0, Math.max(1, branchLength)));
				return false;
			}
			player.getInventory().selected = chosen.slot();
			if (chosen.uses() < required) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"the pickaxe has " + chosen.uses() + " uses but the descent needs about "
						+ required + "; restore the tool before digging",
					evidence("a broken pickaxe mid-descent would strand the body")
				);
				return false;
			}
			beginDescent(client);
			return true;
		}

		private void beginDescent(Minecraft client) {
			inventoryBefore.putAll(inventoryCounts(client.player));
			int yawDirection = directionFromYaw(client.player.getYRot());
			if (rememberMine) {
				rememberMineEntrance(client, client.player, yawDirection);
			}
			directionIndex =
				rememberMine && mineDirection != null
					? directionIndex(mineDirection)
					: yawDirection;
			lastProgressAt = age;
			progressTotal = Math.max(
				1,
				client.player.blockPosition().getY() - targetY + branchLength
			);
			send.accept(progress(id, "descending", 0, progressTotal));
		}

		/**
		 * The first mining descent claims a surface entrance and a heading.
		 * Later trips walk back to that exact cell and follow the same stair,
		 * so the tunnel deepens instead of being rebuilt beside the camp.
		 */
		private static void rememberMineEntrance(
			Minecraft client,
			LocalPlayer player,
			int yawDirection
		) {
			if (mineEntrance != null) return;
			int surface = client.level.getHeight(
				Heightmap.Types.MOTION_BLOCKING_NO_LEAVES,
				player.blockPosition().getX(),
				player.blockPosition().getZ()
			);
			if (player.blockPosition().getY() < surface - 4) return;
			if (!nearEstablishedHome(player.blockPosition(), 24)) return;
			mineEntrance = player.blockPosition().immutable();
			mineDirection = HORIZONTAL[yawDirection];
			saveHomeMemory();
		}

		private static int directionIndex(Direction direction) {
			for (int index = 0; index < HORIZONTAL.length; index++) {
				if (HORIZONTAL[index] == direction) return index;
			}
			return 0;
		}

		private static PickaxeBudget.Candidate bestPickaxe(
			LocalPlayer player,
			boolean needsStone,
			int required
		) {
			BlockState stone = Blocks.STONE.defaultBlockState();
			PickaxeBudget.Candidate[] candidates = new PickaxeBudget.Candidate[Inventory.INVENTORY_SIZE];
			for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (stack.isEmpty()) continue;
				String item = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				int tier = PickaxeBudget.tier(item);
				if (tier == 0) continue;
				int uses = stack.isDamageableItem()
					? stack.getMaxDamage() - stack.getDamageValue()
					: Integer.MAX_VALUE;
				float speed = stack.getDestroySpeed(stone);
				candidates[slot] = new PickaxeBudget.Candidate(slot, item, uses, speed, tier);
			}
			return PickaxeBudget.choose(candidates, needsStone, required);
		}

		private boolean swapPickaxeIntoHotbar(Minecraft client, int source) {
			LocalPlayer player = client.player;
			int hotbar = MineTask.toolHotbarSlot(player);
			player.getInventory().selected = hotbar;
			player.connection.send(new ServerboundSetCarriedItemPacket(hotbar));
			client.gameMode.handleInventoryMouseClick(
				player.inventoryMenu.containerId,
				source,
				hotbar,
				ClickType.SWAP,
				player
			);
			return true;
		}

		@Override
		void tick(Minecraft client) {
			if (equipSubmittedAt >= 0) {
				if (prepareDescent(client, false)) {
					equipSubmittedAt = -1;
					return;
				}
				if (age - equipSubmittedAt > EQUIP_WAIT_TICKS) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"could not equip a pickaxe into the hotbar",
						evidence("the body cannot mine the stone around it")
					);
				}
				return;
			}
			if (age > MAX_TICKS) {
				finishPartial(client, "mining descent reached its time limit");
				return;
			}
			if (finishedAt >= 0) {
				if (age - finishedAt >= PICKUP_SETTLE_TICKS) {
					finish(id, "completed", null, null, evidence(null));
				}
				return;
			}
			if (
				breakingBlock == null
					&& stepStartedAt < 0
					&& maintainToolBudget(client)
			) {
				return;
			}
			if (breakingBlock != null) {
				tickBreak(client);
				return;
			}
			if (stepStartedAt >= 0) {
				tickStep(client);
				return;
			}
			LocalPlayer player = client.player;
			if (!player.onGround()) {
				releaseWalkInput(client);
				return;
			}
			for (int attempt = 0; attempt < HORIZONTAL.length; attempt++) {
				if (!pendingBlocks.isEmpty()) {
					BlockPos next = nextPending(client);
					if (next != null) {
						if (!beginBreak(client, next)) {
							pendingBlocks = List.of();
							rotateDirection();
							continue;
						}
						return;
					}
					beginStep(client);
					return;
				}
				Direction direction = HORIZONTAL[(directionIndex + attempt) % HORIZONTAL.length];
				boolean descending = player.blockPosition().getY() > targetY;
				Step step;
				if (descending) {
					step = descentStep(client, player.blockPosition(), direction);
					pendingOpensBranch = false;
				} else {
					/*
					 * A tunnel that is already open is useful for walking back
					 * to its face, but it is not mining progress. Prefer a
					 * heading with a solid face first; when all four headings
					 * are open, walk the selected corridor until it exposes new
					 * stone instead of finishing after twelve free steps.
					 */
					step = branchStep(client, player.blockPosition(), direction);
					if (step != null) {
						pendingOpensBranch = opensFreshFace(client, step);
					}
				}
				if (step == null) continue;
				directionIndex = (directionIndex + attempt) % HORIZONTAL.length;
				pendingDirection = direction;
				pendingDestinationY = step.destinationY();
				pendingBlocks = step.blocks();
				BlockPos next = nextPending(client);
				if (next == null) {
					beginStep(client);
					return;
				}
				if (!beginBreak(client, next)) {
					pendingBlocks = List.of();
					rotateDirection();
					continue;
				}
				return;
			}
			// The current heading is obstructed by a ravine, fluid or an
			// unbreakable block. Turn and let the next tick try another safe
			// staircase rather than holding forward into it.
			rotateDirection();
			finishPartial(client, "no safe mining direction from the current cell");
		}

		private void tickBreak(Minecraft client) {
			if (client.level.getBlockState(breakingBlock).isAir()) {
				recordBroken(client, breakingBlock, breakingState);
				releaseMiningInput(client);
				breakingBlock = null;
				breakingState = null;
				breakingStartedAt = -1;
				return;
			}
			if (age - breakingStartedAt > BREAK_TIMEOUT_TICKS) {
				releaseMiningInput(client);
				breakingBlock = null;
				breakingState = null;
				breakingStartedAt = -1;
				pendingBlocks = List.of();
				rotateDirection();
				finishPartial(client, "a block in the mining path did not break");
				return;
			}
			LocalPlayer player = client.player;
			Vec3 center = Vec3.atCenterOf(breakingBlock);
			CameraController.steerTo(player, center);
			BlockHitResult hit = BlockInteraction.nearestExposedHit(
				client.level,
				player.getEyePosition(),
				breakingBlock
			);
			holdMiningInput(client);
			client.hitResult = hit;
			client.missTime = 0;
		}

		private boolean beginBreak(Minecraft client, BlockPos target) {
			BlockState state = client.level.getBlockState(target);
			if (state.isAir()) return true;
			if (!canBreak(client, target, state)) return false;
			LocalPlayer player = client.player;
			CameraController.steerTo(player, Vec3.atCenterOf(target));
			BlockHitResult hit = BlockInteraction.nearestExposedHit(
				client.level,
				player.getEyePosition(),
				target
			);
			if (!selectToolFor(client, state)) return false;
			breakingBlock = target;
			breakingState = state;
			breakingStartedAt = age;
			holdMiningInput(client);
			client.hitResult = hit;
			client.missTime = 0;
			send.accept(progress(id, "cutting", descended + branchOpened, progressTotal));
			return true;
		}

		private BlockPos nextPending(Minecraft client) {
			for (BlockPos position : pendingBlocks) {
				if (!client.level.getBlockState(position).isAir()) return position;
			}
			pendingBlocks = List.of();
			return null;
		}

		private void beginStep(Minecraft client) {
			releaseMiningInput(client);
			LocalPlayer player = client.player;
			stepStartX = player.blockPosition().getX();
			stepStartZ = player.blockPosition().getZ();
			stepOriginY = player.blockPosition().getY();
			stepStartedAt = age;
			releaseWalkInput(client);
		}

		private void tickStep(Minecraft client) {
			LocalPlayer player = client.player;
			int currentY = player.blockPosition().getY();
			boolean descending = pendingDestinationY < stepOriginY;
			boolean arrived = descending
				? currentY <= pendingDestinationY
				: Math.hypot(
					player.blockPosition().getX() - stepStartX,
					player.blockPosition().getZ() - stepStartZ
				) >= 0.8;
			if (arrived) {
				if (descending) descended++;
				else {
					branchTravelled++;
					if (pendingOpensBranch) branchOpened++;
				}
				stepStartedAt = -1;
				pendingDirection = null;
				pendingOpensBranch = false;
				releaseWalkInput(client);
				if (player.blockPosition().getY() <= targetY && branchOpened >= branchLength) {
					finishedAt = age;
				}
				if (age - lastProgressAt >= 20) {
					lastProgressAt = age;
					send.accept(progress(id, "mining", descended + branchOpened, progressTotal));
				}
				return;
			}
			if (age - stepStartedAt > STEP_TIMEOUT_TICKS) {
				stepStartedAt = -1;
				pendingDirection = null;
				releaseWalkInput(client);
				rotateDirection();
				return;
			}
			if (pendingDirection == null) {
				stepStartedAt = -1;
				return;
			}
			float yaw = pendingDirection.toYRot();
			boolean aligned = turnTowards(player, yaw);
			CameraController.steerHeading(player, player.getYRot(), CameraController.displayPitch(player));
			if (player.horizontalCollision && player.onGround()) player.jumpFromGround();
			if (player.input != null) setWalkInput(client, aligned);
		}

		/**
		 * The landing cell's own floor is {@code y - 2}; the cut cells are the
		 * front pair at the body's level and the front floor one block lower.
		 * Requiring that landing floor to be solid is what turns this from a
		 * dangerous vertical shaft into a climbable staircase.
		 */
		private Step descentStep(Minecraft client, BlockPos feet, Direction direction) {
			BlockPos front = feet.relative(direction);
			BlockPos landingFloor = front.below(2);
			if (!solidFloor(client, landingFloor)) return null;
			List<BlockPos> targets = new ArrayList<>(3);
			if (!safeCell(client, front)) return null;
			targets.add(front);
			if (!safeCell(client, front.above())) return null;
			targets.add(front.above());
			BlockPos stepDown = front.below();
			if (!safeCell(client, stepDown)) return null;
			targets.add(stepDown);
			return new Step(targets, feet.getY() - 1);
		}

		/**
		 * A branch tunnel keeps the same floor and opens only the two cells at
		 * eye/feet height. It is deliberately narrow; wider rooms cost tool
		 * durability and make the body lose track of its route back.
		 */
		private Step branchStep(Minecraft client, BlockPos feet, Direction direction) {
			BlockPos front = feet.relative(direction);
			if (!solidFloor(client, front.below())) return null;
			List<BlockPos> targets = new ArrayList<>(2);
			if (!safeCell(client, front)) return null;
			targets.add(front);
			if (!safeCell(client, front.above())) return null;
			targets.add(front.above());
			return new Step(targets, feet.getY());
		}

		private boolean opensFreshFace(Minecraft client, Step step) {
			for (BlockPos position : step.blocks()) {
				if (!client.level.getBlockState(position).isAir()) return true;
			}
			return false;
		}

		private boolean safeCell(Minecraft client, BlockPos position) {
			BlockState state = client.level.getBlockState(position);
			if (!state.getFluidState().isEmpty()) return false;
			if (!state.blocksMotion()) return true;
			return canBreak(client, position, state);
		}

		private boolean solidFloor(Minecraft client, BlockPos position) {
			BlockState state = client.level.getBlockState(position);
			return state.blocksMotion()
				&& state.getFluidState().isEmpty()
				&& !state.is(BlockTags.LEAVES);
		}

		private boolean canBreak(Minecraft client, BlockPos position, BlockState state) {
			if (state.getDestroySpeed(client.level, position) < 0.0f) return false;
			if (!state.getFluidState().isEmpty()) return false;
			if (state.is(Blocks.BEDROCK) || state.is(Blocks.BARRIER)) return false;
			// A branch tunnel is not allowed to eat the station it just built.
			// Breaking the furnace made the planner craft and place another
			// one on the next replan, which looked like an endless build loop.
			if (playerStation(state)) return false;
			if (!state.requiresCorrectToolForDrops()) return true;
			for (int slot = 0; slot < 9; slot++) {
				ItemStack stack = client.player.getInventory().getItem(slot);
				if (!stack.isEmpty() && stack.isCorrectToolForDrops(state)) return true;
			}
			return false;
		}

		private boolean playerStation(BlockState state) {
			return state.is(Blocks.CRAFTING_TABLE)
				|| state.is(Blocks.FURNACE)
				|| state.is(Blocks.BLAST_FURNACE)
				|| state.is(Blocks.SMOKER)
				|| state.is(BlockTags.BEDS)
				|| state.is(Blocks.CHEST)
				|| state.is(Blocks.TRAPPED_CHEST)
				|| state.is(Blocks.BARREL)
				|| state.is(Blocks.TORCH)
				|| state.is(Blocks.WALL_TORCH)
				|| state.is(Blocks.SOUL_TORCH)
				|| state.is(Blocks.SOUL_WALL_TORCH)
				|| state.is(Blocks.LANTERN)
				|| state.is(Blocks.SOUL_LANTERN);
		}

		private boolean selectToolFor(Minecraft client, BlockState state) {
			if (!state.requiresCorrectToolForDrops()) return true;
			int current = client.player.getInventory().selected;
			ItemStack held = client.player.getInventory().getItem(current);
			if (!held.isEmpty() && held.isCorrectToolForDrops(state)) return true;
			for (int slot = 0; slot < 9; slot++) {
				ItemStack stack = client.player.getInventory().getItem(slot);
				if (!stack.isEmpty() && stack.isCorrectToolForDrops(state)) {
					client.player.getInventory().selected = slot;
					return true;
				}
			}
			return false;
		}

		private void rotateDirection() {
			directionIndex = (directionIndex + 1) % HORIZONTAL.length;
		}

		private int directionFromYaw(float yaw) {
			float normalized = (yaw % 360.0f + 360.0f) % 360.0f;
			if (normalized >= 315.0f || normalized < 45.0f) return 2;
			if (normalized < 135.0f) return 3;
			if (normalized < 225.0f) return 0;
			return 1;
		}

		private void recordBroken(Minecraft client, BlockPos position, BlockState state) {
			if (state == null) return;
			JsonObject mined = new JsonObject();
			mined.addProperty("block", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
			mined.add("position", position(position));
			brokenBlocks.add(mined);
			if (age - lastProgressAt >= 20) {
				lastProgressAt = age;
				send.accept(progress(id, "mining", descended + branchOpened, progressTotal));
			}
		}

		/**
		 * A single descent can outlast the pickaxe that was full at the start.
		 * Keep watching the live durability and switch to a better backup
		 * before the held tool breaks, instead of losing the whole trip.
		 */
		private boolean maintainToolBudget(Minecraft client) {
			LocalPlayer player = client.player;
			if (toolSwapAt >= 0) {
				PickaxeBudget.Candidate current = bestPickaxe(
					player,
					MiningDepth.requiresStonePickaxe(
						player.blockPosition().getY() - targetY
					),
					PickaxeBudget.requiredUses(
						player.blockPosition().getY() - targetY,
						branchLength
					)
				);
				if (current != null && current.slot() == player.getInventory().selected) {
					toolSwapAt = -1;
					return false;
				}
				if (age - toolSwapAt > EQUIP_WAIT_TICKS) {
					finishPartial(client, "could not equip a backup pickaxe");
				}
				return true;
			}
			int depth = player.blockPosition().getY() - targetY;
			int required = PickaxeBudget.requiredUses(depth, branchLength);
			boolean needsStone = MiningDepth.requiresStonePickaxe(depth);
			PickaxeBudget.Candidate best = bestPickaxe(player, needsStone, required);
			if (best == null) return false;
			int selected = player.getInventory().selected;
			ItemStack held = player.getInventory().getItem(selected);
			String heldId = held.isEmpty()
				? ""
				: BuiltInRegistries.ITEM.getKey(held.getItem()).toString();
			int heldTier = PickaxeBudget.tier(heldId);
			int heldUses = held.isEmpty()
				? 0
				: held.isDamageableItem()
					? held.getMaxDamage() - held.getDamageValue()
					: Integer.MAX_VALUE;
			boolean heldUsable = heldTier >= (needsStone ? 2 : 1) && heldUses >= required;
			if (
				heldUsable
					|| (heldTier > 0 && best.uses() <= heldUses)
					|| best.slot() == selected
			) {
				return false;
			}
			if (best.slot() < 9) {
				player.getInventory().selected = best.slot();
				return false;
			}
			if (!swapPickaxeIntoHotbar(client, best.slot())) return false;
			toolSwapAt = age;
			send.accept(progress(id, "equipping", descended + branchOpened, progressTotal));
			return true;
		}

		private void finishPartial(Minecraft client, String reason) {
			releaseMiningInput(client);
			releaseWalkInput(client);
			CameraController.release();
			if (brokenBlocks.size() == 0) {
				finish(id, "failed", "E_PRECONDITION", reason, evidence(reason));
			} else {
				// Breaking a few blocks is progress, not arrival. Reporting
				// "completed" let the planner advance past a layer it never
				// reached, then immediately ask for the same descent again.
				finish(id, "failed", "E_WORLD_CHANGED", reason, evidence(reason));
			}
		}

		private Map<String, Integer> inventoryCounts(LocalPlayer player) {
			Map<String, Integer> counts = new LinkedHashMap<>();
			for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (stack.isEmpty()) continue;
				String item = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				counts.merge(item, stack.getCount(), Integer::sum);
			}
			return counts;
		}

		private JsonObject evidence(String problem) {
			JsonObject outcome = new JsonObject();
			outcome.addProperty(
				"summary",
				"descended " + descended + " steps, opened " + branchOpened
					+ " new branch blocks after walking " + branchTravelled
					+ " steps, y=" + clientY()
			);
			JsonArray changes = new JsonArray();
			for (var block : brokenBlocks) {
				JsonObject change = new JsonObject();
				change.addProperty("kind", "block_broken");
				change.addProperty("detail", block.getAsJsonObject().get("block").getAsString());
				change.add("position", block.getAsJsonObject().get("position"));
				changes.add(change);
			}
			LocalPlayer player = Minecraft.getInstance().player;
			if (player != null) {
				Map<String, Integer> after = inventoryCounts(player);
				for (var entry : after.entrySet()) {
					int gained = entry.getValue() - inventoryBefore.getOrDefault(entry.getKey(), 0);
					if (gained <= 0) continue;
					JsonObject change = new JsonObject();
					change.addProperty("kind", "item_collected");
					change.addProperty("detail", gained + " x " + entry.getKey());
					changes.add(change);
				}
			}
			outcome.add("changes", changes);
			if (problem != null) outcome.addProperty("problem", problem);
			return outcome;
		}

		private int clientY() {
			LocalPlayer player = Minecraft.getInstance().player;
			return player == null ? 0 : player.blockPosition().getY();
		}

		@Override
		void stop(Minecraft client) {
			releaseMiningInput(client);
			releaseWalkInput(client);
			CameraController.release();
			breakingBlock = null;
			stepStartedAt = -1;
		}

		private record Step(List<BlockPos> blocks, int destinationY) {
		}
	}

	/**
	 * Feeds a vanilla furnace and confirms the finished item in the backpack.
	 * Opening a furnace is not evidence of smelting: this task owns the whole
	 * cycle of walking to the block, loading input and fuel, waiting for the
	 * result, and taking it out again.
	 */
	private static final class SmeltTask extends Task {
		private static final int WALK_BUDGET_TICKS = 20 * 45;
		private static final int APPROACH_STALL_TICKS = 20 * 3;
		private static final int MENU_TIMEOUT_TICKS = 20 * 3;
		private static final int LOAD_TIMEOUT_TICKS = 20 * 15;
		private static final int RESULT_TIMEOUT_TICKS = 20 * 150;
		private static final int TRANSFER_SETTLE_TICKS = 3;
		private static final int SEARCH_RADIUS = 48;
		private final String inputId;
		private final String outputId;
		private final String requestedFuel;
		private final int requested;
		private final Item inputItem;
		private final Item outputItem;
		private BlockPos furnacePos;
		private AbstractFurnaceMenu menu;
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
		private int loadStartedAt = -1;
		private int loadTargetSlot = -1;
		private int loadPhase;
		private int loadSourceSlot = -1;
		private String loadItem;
		private int loadDesired;
		private int loadBaseCount;
		private int loadLastCount;
		private boolean inputLoaded;
		private boolean fuelLoaded;
		private int smeltStartedAt = -1;
		private int resultCountBeforeTake;
		private int resultTakeSubmittedAt = -1;
		private int smelted;
		private int lastProgressAt = -1;
		private Map<String, Integer> inventoryAtTake;
		private String fuelId;

		SmeltTask(String id, String inputId, String outputId, int requested, String fuelId) {
			super(id);
			this.inputId = inputId;
			this.outputId = outputId;
			this.requestedFuel = fuelId;
			this.requested = requested;
			this.inputItem = BuiltInRegistries.ITEM.get(ResourceLocation.tryParse(inputId));
			this.outputItem = BuiltInRegistries.ITEM.get(ResourceLocation.tryParse(outputId));
		}

		@Override
		boolean validate(Minecraft client) {
			if (!super.validate(client)) return false;
			if (requested <= 0) {
				validationError = "count must be positive";
				return false;
			}
			ResourceLocation input = ResourceLocation.tryParse(inputId);
			ResourceLocation output = ResourceLocation.tryParse(outputId);
			if (input == null || !BuiltInRegistries.ITEM.containsKey(input)) {
				validationError = "unknown input item " + inputId;
				return false;
			}
			if (output == null || !BuiltInRegistries.ITEM.containsKey(output)) {
				validationError = "unknown output item " + outputId;
				return false;
			}
			String fuel = requestedFuel == null ? fuelChoice(client.player) : requestedFuel;
			if (fuel == null) {
				validationError = "no furnace fuel in the inventory";
				return false;
			}
			ResourceLocation parsedFuel = ResourceLocation.tryParse(fuel);
			if (parsedFuel == null || !BuiltInRegistries.ITEM.containsKey(parsedFuel)) {
				validationError = "unknown fuel item " + fuel;
				return false;
			}
			int inputCount = countItem(client.player, inputItem);
			if (inputCount < requested) {
				validationError = "only " + inputCount + " x " + inputId + " in the inventory";
				return false;
			}
			if (countItem(client.player, BuiltInRegistries.ITEM.get(parsedFuel)) <= 0) {
				validationError = "no " + fuel + " in the inventory";
				return false;
			}
			this.fuelId = parsedFuel.toString();
			return true;
		}

		@Override
		void start(Minecraft client) {
			furnacePos = nearestFurnace(client);
			if (furnacePos == null) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"no furnace within " + SEARCH_RADIUS + " blocks",
					evidence("no furnace was found near the body")
				);
				return;
			}
			walking = !canInteract(client, client.player, furnacePos);
			lastApproachDistance = playerToFurnace(client.player);
			lastWalkProgressAge = 0;
			send.accept(progress(id, walking ? "walking" : "opening", 0, requested));
		}

		@Override
		void tick(Minecraft client) {
			if (age > WALK_BUDGET_TICKS + RESULT_TIMEOUT_TICKS) {
				stop(client);
				finish(
					id,
					"timeout",
					"E_TIMEOUT",
					"smelting did not complete in time",
					evidence("the furnace did not finish the requested batch")
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
			// A previous attempt may have stopped after the furnace consumed
			// the input but before the result was taken. Recover that output
			// first; otherwise the raw iron is invisible to the planner while
			// the furnace silently holds usable ingots.
			if (takeExistingOutput(client)) return;
			if (!inputLoaded || !fuelLoaded) {
				loadFurnace(client);
				return;
			}
			collectResult(client);
		}

		private boolean takeExistingOutput(Minecraft client) {
			if (resultTakeSubmittedAt >= 0) {
				if (age - resultTakeSubmittedAt < TRANSFER_SETTLE_TICKS) return true;
				Map<String, Integer> inventory = inventoryCounts(client.player);
				int before = inventoryAtTake.getOrDefault(outputId, 0);
				int after = inventory.getOrDefault(outputId, 0);
				int gained = Math.max(0, after - before);
				if (gained > 0 || menu.getSlot(2).getItem().isEmpty()) {
					smelted += gained > 0 ? gained : resultCountBeforeTake;
					resultTakeSubmittedAt = -1;
					inventoryAtTake = null;
					send.accept(progress(id, "smelting", Math.min(requested, smelted), requested));
					if (smelted >= requested) complete(client);
				} else {
					resultTakeSubmittedAt = -1;
					inventoryAtTake = null;
				}
				return true;
			}
			Slot result = menu.getSlot(2);
			if (result.getItem().isEmpty() || !matches(result.getItem(), outputId)) return false;
			resultCountBeforeTake = result.getItem().getCount();
			inventoryAtTake = inventoryCounts(client.player);
			resultTakeSubmittedAt = age;
			client.gameMode.handleInventoryMouseClick(
				menu.containerId,
				2,
				0,
				ClickType.QUICK_MOVE,
				client.player
			);
			return true;
		}

		@Override
		boolean keepScreen(Minecraft client) {
			return openedByTask || menuSubmittedAt >= 0;
		}

		private void approach(Minecraft client) {
			LocalPlayer player = client.player;
			if (canInteract(client, player, furnacePos)) {
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
					"could not reach the furnace in time",
					evidence("furnace approach timed out")
				);
				return;
			}
			Vec3 center = Vec3.atCenterOf(furnacePos);
			if (!furnacePos.equals(approachTarget) || walkingAge >= nextApproachPlanAt) {
				ApproachRoute.Route route = ApproachRoute.to(client, furnacePos);
				if (route != null && route.waypoints().size() > 1) {
					approachWaypoints = route.waypoints();
					approachWaypoint = 1;
				} else {
					approachWaypoints = List.of();
					approachWaypoint = 0;
					if (playerToFurnace(player) > 6.0) {
						stop(client);
						finish(
							id,
							"failed",
							"E_PRECONDITION",
							"no safe route to the furnace",
							evidence("the furnace is visible but unreachable")
						);
						return;
					}
				}
				approachTarget = furnacePos;
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
			double progressDistance = playerToFurnace(player);
			if (progressDistance + 0.1 < lastApproachDistance) {
				lastApproachDistance = progressDistance;
				lastWalkProgressAge = walkingAge;
			} else if (walkingAge - lastWalkProgressAge > APPROACH_STALL_TICKS) {
				stop(client);
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"furnace approach made no progress for 3 seconds",
					evidence("could not reach a safe interaction spot beside the furnace")
				);
				return;
			}
			double heading = Math.atan2(-(step.x - player.getX()), step.z - player.getZ());
			boolean aligned = turnTowards(player, (float) Math.toDegrees(heading));
			CameraController.steerHeading(
				player,
				player.getYRot(),
				CameraController.displayPitch(player)
			);
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
					"dangerous drop on the route to the furnace",
					evidence("refused an unsafe furnace approach")
				);
				return;
			}
			if (player.horizontalCollision && player.onGround()) player.jumpFromGround();
			if (player.input != null) setWalkInput(client, aligned);
			if (walkingAge % 20 == 0) {
				send.accept(progress(id, "walking", (int) Math.round(player.position().distanceTo(center)), 0));
			}
		}

		private void open(Minecraft client) {
			if (furnacePos == null || !isFurnace(client.level.getBlockState(furnacePos))) {
				finish(
					id,
					"failed",
					"E_WORLD_CHANGED",
					"the furnace disappeared before it could be used",
					evidence("the furnace was removed")
				);
				return;
			}
			if (!canInteract(client, client.player, furnacePos)) {
				walking = true;
				lastApproachDistance = playerToFurnace(client.player);
				lastWalkProgressAge = walkingAge;
				return;
			}
			if (menuSubmittedAt >= 0) {
				AbstractFurnaceMenu opened = client.screen instanceof AbstractContainerScreen<?> screen
					&& screen.getMenu() instanceof AbstractFurnaceMenu furnaceMenu
					? furnaceMenu
					: null;
				if (opened != null) {
					menu = opened;
					openedByTask = true;
					menuSubmittedAt = -1;
					loadStartedAt = age;
					send.accept(progress(id, "loading", 0, requested));
					return;
				}
				if (age - menuSubmittedAt > MENU_TIMEOUT_TICKS) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"right-click did not open a furnace screen",
						evidence("no furnace menu opened")
					);
				}
				return;
			}
			CameraController.steerTo(client.player, Vec3.atCenterOf(furnacePos));
			BlockHitResult hit = stationHit(client.player, furnacePos);
			if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(furnacePos)) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
						"furnace is outside interaction reach",
						evidence("could not reach the furnace")
				);
				return;
			}
			releaseWalkInput(client);
			menuSubmittedAt = age;
			client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, hit);
		}

		private void loadFurnace(Minecraft client) {
			if (age - loadStartedAt > LOAD_TIMEOUT_TICKS) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"could not move the input and fuel into the furnace",
					evidence("furnace loading timed out")
				);
				closeOwnMenu(client);
				return;
			}
			int remaining = Math.max(1, requested - smelted);
			if (!inputLoaded) {
				inputLoaded = prepareSlot(client, menu, 0, inputId, remaining);
				if (!inputLoaded) return;
			}
			if (!fuelLoaded) {
				fuelLoaded = prepareSlot(
					client,
					menu,
					1,
					fuelId,
					fuelNeeded(fuelId, remaining)
				);
				if (!fuelLoaded) return;
			}
			smeltStartedAt = age;
			lastProgressAt = age;
			send.accept(progress(id, "smelting", 0, requested));
		}

		/**
		 * Move a stack into one exact furnace slot. The first click picks up
		 * the source, the second drops it into the empty slot, and a third
		 * returns anything the slot could not accept. Using exact slot clicks
		 * avoids a wood fuel stack being routed to the smelting input by the
		 * container's generic quick-move rules.
		 */
		private boolean prepareSlot(
			Minecraft client,
			AbstractFurnaceMenu current,
			int targetIndex,
			String itemId,
			int desired
		) {
			Slot target = current.getSlot(targetIndex);
			if (loadPhase != 0 && loadTargetSlot == targetIndex) {
				return advanceLoad(client, current);
			}
			if (!target.getItem().isEmpty()) {
				if (matches(target.getItem(), itemId)) {
					if (target.getItem().getCount() >= desired) return true;
					loadBaseCount = target.getItem().getCount();
					loadDesired = desired;
					loadItem = itemId;
					loadTargetSlot = targetIndex;
					loadLastCount = loadBaseCount;
					loadPhase = 0;
					loadSourceSlot = -1;
					return false;
				}
				client.gameMode.handleInventoryMouseClick(
					current.containerId,
					targetIndex,
					0,
					ClickType.QUICK_MOVE,
					client.player
				);
				loadPhase = 4;
				loadTargetSlot = targetIndex;
				return false;
			}
			if (loadPhase == 4) {
				loadPhase = 0;
				return false;
			}
			if (!current.getCarried().isEmpty()) {
				if (loadSourceSlot >= 0) {
					client.gameMode.handleInventoryMouseClick(
						current.containerId,
						loadSourceSlot,
						0,
						ClickType.PICKUP,
						client.player
					);
					loadSourceSlot = -1;
					loadPhase = 0;
				}
				return false;
			}
			if (loadPhase == 0) {
				loadSourceSlot = findInventorySlot(client, current, itemId);
				if (loadSourceSlot < 0) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"no " + itemId + " in the inventory",
						evidence("the required item disappeared from the inventory")
					);
					closeOwnMenu(client);
					return false;
				}
				loadItem = itemId;
				loadTargetSlot = targetIndex;
				loadDesired = desired;
				loadBaseCount = 0;
				loadLastCount = 0;
				client.gameMode.handleInventoryMouseClick(
					current.containerId,
					loadSourceSlot,
					0,
					ClickType.PICKUP,
					client.player
				);
				loadPhase = 1;
				return false;
			}
			return false;
		}

		private boolean advanceLoad(Minecraft client, AbstractFurnaceMenu current) {
			if (loadPhase == 1) {
				if (current.getCarried().isEmpty() || !matches(current.getCarried(), loadItem)) {
					loadPhase = 0;
					loadSourceSlot = -1;
					return false;
				}
				client.gameMode.handleInventoryMouseClick(
					current.containerId,
					loadTargetSlot,
					1,
					ClickType.PICKUP,
					client.player
				);
				loadPhase = 2;
				return false;
			}
			if (loadPhase == 2) {
				Slot loaded = current.getSlot(loadTargetSlot);
				if (loaded.getItem().isEmpty()) return false;
				int count = loaded.getItem().getCount();
				if (count <= loadLastCount) return false;
				loadLastCount = count;
				if (count < loadDesired && !current.getCarried().isEmpty()) {
					loadPhase = 1;
					return false;
				}
				if (!current.getCarried().isEmpty() && loadSourceSlot >= 0) {
					client.gameMode.handleInventoryMouseClick(
						current.containerId,
						loadSourceSlot,
						0,
						ClickType.PICKUP,
						client.player
					);
				}
				loadPhase = 3;
				return false;
			}
			if (loadPhase == 3) {
				if (!current.getCarried().isEmpty()) return false;
				boolean ready = !current.getSlot(loadTargetSlot).getItem().isEmpty()
					&& matches(current.getSlot(loadTargetSlot).getItem(), loadItem)
					&& current.getSlot(loadTargetSlot).getItem().getCount() >= loadDesired;
				if (!ready) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"the inventory did not contain enough " + loadItem,
						evidence("furnace loading stopped before the requested count was reached")
					);
					closeOwnMenu(client);
				}
				loadPhase = 0;
				loadSourceSlot = -1;
				return ready;
			}
			return false;
		}

		private int fuelNeeded(String itemId, int items) {
			if (itemId.endsWith(":lava_bucket")) return 1;
			if (itemId.endsWith(":coal_block")) return Math.max(1, (items + 79) / 80);
			if (itemId.endsWith(":blaze_rod")) return Math.max(1, (items + 11) / 12);
			if (itemId.endsWith(":dried_kelp_block")) return Math.max(1, (items + 19) / 20);
			if (itemId.endsWith(":coal") || itemId.endsWith(":charcoal")) {
				return Math.max(1, (items + 7) / 8);
			}
			if (itemId.endsWith(":stick")) return Math.max(1, items * 2);
			return Math.max(1, (items * 2 + 2) / 3);
		}

		private void collectResult(Minecraft client) {
			if (smeltStartedAt < 0) smeltStartedAt = age;
			Slot result = menu.getSlot(2);
			if (resultTakeSubmittedAt >= 0) {
				if (age - resultTakeSubmittedAt < TRANSFER_SETTLE_TICKS) return;
				Map<String, Integer> inventory = inventoryCounts(client.player);
				int before = inventoryAtTake.getOrDefault(outputId, 0);
				int after = inventory.getOrDefault(outputId, 0);
				int gained = Math.max(0, after - before);
				if (gained > 0 || result.getItem().isEmpty()) {
					smelted += gained > 0 ? gained : resultCountBeforeTake;
					resultTakeSubmittedAt = -1;
					inventoryAtTake = null;
					send.accept(progress(id, "smelting", Math.min(requested, smelted), requested));
					if (smelted >= requested) {
						complete(client);
					}
					return;
				}
				resultTakeSubmittedAt = -1;
				inventoryAtTake = null;
				return;
			}
			if (!result.getItem().isEmpty() && matches(result.getItem(), outputId)) {
				resultCountBeforeTake = result.getItem().getCount();
				inventoryAtTake = inventoryCounts(client.player);
				resultTakeSubmittedAt = age;
				client.gameMode.handleInventoryMouseClick(
					menu.containerId,
					2,
					0,
					ClickType.QUICK_MOVE,
					client.player
				);
				return;
			}
			if (age - smeltStartedAt > RESULT_TIMEOUT_TICKS) {
				finish(
					id,
					"timeout",
					"E_TIMEOUT",
					smelted > 0
						? "only " + smelted + " of " + requested + " items were smelted before the time limit"
						: "the furnace did not produce the requested item",
					evidence("smelting timed out")
				);
				stop(client);
				return;
			}
			if (age - lastProgressAt >= 20) {
				lastProgressAt = age;
				send.accept(progress(id, "smelting", Math.min(requested, smelted), requested));
			}
		}

		private void complete(Minecraft client) {
			// Put unused input and fuel back before closing. A furnace is a
			// workstation, not a chest; leaving a stack there makes the next
			// trip believe the body has far less material than it really does.
			if (menu != null) {
				for (int index = 0; index <= 1; index++) {
					if (!menu.getSlot(index).getItem().isEmpty()) {
						client.gameMode.handleInventoryMouseClick(
							menu.containerId,
							index,
							0,
							ClickType.QUICK_MOVE,
							client.player
						);
					}
				}
			}
			closeOwnMenu(client);
			finish(id, "completed", null, null, evidence(null));
		}

		private int findInventorySlot(
			Minecraft client,
			AbstractFurnaceMenu current,
			String itemId
		) {
			for (int index = 3; index < current.slots.size(); index++) {
				Slot slot = current.getSlot(index);
				if (!(slot.container instanceof Inventory)) continue;
				if (slot.getContainerSlot() >= Inventory.INVENTORY_SIZE) continue;
				if (!matches(slot.getItem(), itemId)) continue;
				if (!slot.mayPickup(client.player)) continue;
				return index;
			}
			return -1;
		}

		private static boolean matches(ItemStack stack, String itemId) {
			return !stack.isEmpty()
				&& BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(itemId);
		}

		private static int countItem(LocalPlayer player, Item item) {
			int total = 0;
			for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (!stack.isEmpty() && stack.getItem() == item) total += stack.getCount();
			}
			return total;
		}

		private BlockPos nearestFurnace(Minecraft client) {
			BlockPos origin = client.player.blockPosition();
			BlockPos best = null;
			double bestDistance = Double.POSITIVE_INFINITY;
			for (BlockPos pos : BlockPos.betweenClosed(
				origin.offset(-SEARCH_RADIUS, -12, -SEARCH_RADIUS),
				origin.offset(SEARCH_RADIUS, 12, SEARCH_RADIUS)
			)) {
				BlockPos candidate = pos.immutable();
				if (candidate.distSqr(origin) > (double) SEARCH_RADIUS * SEARCH_RADIUS) continue;
				if (!isFurnace(client.level.getBlockState(candidate))) continue;
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

		private static boolean isFurnace(BlockState state) {
			return state.is(Blocks.FURNACE)
				|| state.is(Blocks.BLAST_FURNACE)
				|| state.is(Blocks.SMOKER);
		}

		private boolean canInteract(Minecraft client, LocalPlayer player, BlockPos target) {
			return stationReachable(player, target);
		}

		private double playerToFurnace(LocalPlayer player) {
			return furnacePos == null
				? Double.POSITIVE_INFINITY
				: player.position().distanceTo(Vec3.atCenterOf(furnacePos));
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

		private String fuelChoice(LocalPlayer player) {
			String[] preferred = {
				"minecraft:coal",
				"minecraft:charcoal",
				"minecraft:coal_block",
				"minecraft:blaze_rod",
				"minecraft:oak_planks",
				"minecraft:oak_log",
				"minecraft:stick",
			};
			for (String candidate : preferred) {
				ResourceLocation id = ResourceLocation.tryParse(candidate);
				if (id == null || !BuiltInRegistries.ITEM.containsKey(id)) continue;
				if (countItem(player, BuiltInRegistries.ITEM.get(id)) > 0) return candidate;
			}
			for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (stack.isEmpty()) continue;
				String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				if (id.matches(".*:(coal|charcoal|lava_bucket|blaze_rod|dried_kelp_block|coal_block|.*_planks|.*_log|.*_wood|stick)$")) {
					return id;
				}
			}
			return null;
		}

		private JsonObject evidence(String problem) {
			JsonObject outcome = new JsonObject();
			outcome.addProperty(
				"summary",
				smelted > 0
					? "smelted " + smelted + " x " + outputId
					: "no smelting result was confirmed"
			);
			JsonArray changes = new JsonArray();
			if (smelted > 0) {
				JsonObject change = new JsonObject();
				change.addProperty("kind", "item_smelted");
				change.addProperty("detail", smelted + " x " + outputId);
				if (furnacePos != null) change.add("position", position(furnacePos));
				changes.add(change);
			}
			outcome.add("changes", changes);
			if (problem != null) {
				outcome.addProperty("problem", problem);
				JsonArray unconfirmed = new JsonArray();
				unconfirmed.add("the furnace output was not confirmed by an inventory gain");
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
		private static final int MAX_MISSES_WITHOUT_DAMAGE = 6;
		private static final int MAX_ENGAGEMENT_TICKS = 20 * 120;
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
			this.emergencyAction = true;
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
			if (killedAt < 0 && age > MAX_ENGAGEMENT_TICKS) {
				stop(client);
				finish(
					id,
					"timeout",
					"E_TIMEOUT",
					"could not finish the fight in time",
					attackEvidence("engagement exceeded its bounded time budget", hits)
				);
				return;
			}
			if (collect && killedAt >= 0) {
				collectDrop(client);
				return;
			}
			if (!submitted) {
				if (target == null || !target.isAlive() || target.isRemoved()) {
					target = nearestTarget(client);
					if (target != null) {
						before = snapshot(client, target);
						resetApproach();
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
				resetApproach();
				if (target != null && target.isAlive() && !target.isRemoved()) {
					before = snapshot(client, target);
				} else if (hits < requested) {
					Entity next = nearestTarget(client);
					if (next != null) {
						target = next;
						before = snapshot(client, target);
						resetApproach();
					}
				}
				String blocked = InteractionEvidence.attackBlocked(before);
				if (blocked != null) {
					if (
						"target is no longer visible".equals(blocked) ||
						"target is out of reach".equals(blocked)
					) {
						// A knockback can move the animal outside attack reach
						// between the distance check and the snapshot. That is
						// a reason to chase, not to end the hunt. The old
						// branch failed here and made every animal survive
						// after a handful of hits.
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
				CameraController.steerTo(client.player, target.getBoundingBox().getCenter());
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
				resetApproach();
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
			if (now.alive()) {
				// The animal moved, the server rejected the swing, or the
				// body was knocked back. Re-enter the chase loop with a fresh
				// approach budget instead of reporting a failed hunt after a
				// single unconsumed click.
				misses++;
				submitted = false;
				resetApproach();
				if (misses < MAX_MISSES_WITHOUT_DAMAGE) {
					send.accept(progress(id, "retrying", hits, requested));
					return;
				}
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"attack produced no damage after repeated verified swings",
					attackEvidence("the swing produced no confirmed health change", hits)
				);
				return;
			}
			String blocked = InteractionEvidence.attackBlocked(now);
			finish(
				id,
				"failed",
				"E_PRECONDITION",
				blocked == null ? "attack did not change the target's health" : blocked,
				attackEvidence("the swing produced no confirmed health change", hits)
			);
		}

		private void resetApproach() {
			walkingAge = 0;
			lastProgressAge = 0;
			replans = 0;
			lastDistance = Double.POSITIVE_INFINITY;
			waypoints = List.of();
			waypointIndex = 0;
			waypointTarget = null;
			nextRouteAt = 0;
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
			boolean aligned = turnTowards(client.player, (float) Math.toDegrees(heading));
			CameraController.steerHeading(
				client.player,
				client.player.getYRot(),
				CameraController.displayPitch(client.player)
			);
			if (distance <= 3.0) {
				CameraController.steerTo(client.player, target.getBoundingBox().getCenter());
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
			boolean aligned = true;
			if (horizontal > 0.01) {
				aligned = turnTowards(
					client.player,
					(float) Math.toDegrees(Math.atan2(-direction.x, direction.z))
				);
				CameraController.steerHeading(
					client.player,
					client.player.getYRot(),
					CameraController.displayPitch(client.player)
				);
			}
			if (client.player.horizontalCollision && client.player.onGround()) {
				client.player.jumpFromGround();
			}
			if (client.player.input != null) setWalkInput(client, aligned);
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
			client.player.getInventory().selected = slot;
			ItemStack selected = client.player.getInventory().getSelected();
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
	/**
	 * The same test SleepTask uses to decide it can open the bed right now.
	 * The snapshot reports it so the planner does not send a body that is
	 * already looking at the mattress on a walk to an unreachable floor cell.
	 */
	private static boolean bedInReach(Minecraft client, LocalPlayer player, BlockPos bed) {
		if (!client.level.hasChunkAt(bed)) return false;
		for (BlockPos part : SleepTask.bedParts(client, bed)) {
			if (withinInteractionRange(player, part)) return true;
		}
		return false;
	}

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
			boolean bedWorks = client.level.dimensionType().bedWorks();
			String blocked = SleepEvidence.blockedReason(
				false,
				true,
				occupied(client, bedHead),
				!bedWorks,
				canSleepNow(client)
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
			CameraController.steerTo(player, Vec3.atCenterOf(part));
			BlockHitResult hit = BlockInteraction.nearestExposedHit(client.level, player.getEyePosition(), part);
			if (hit.getType() != HitResult.Type.BLOCK || !isThisBed(client, hit.getBlockPos())) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
						"the bed is outside interaction reach",
						evidence(client, "could not reach the bed")
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
			boolean aligned = turnTowards(player, (float) Math.toDegrees(heading));
			CameraController.steerHeading(
				player,
				player.getYRot(),
				CameraController.displayPitch(player)
			);
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
			if (player.input != null) setWalkInput(client, aligned);
			if (walkingAge % 20 == 0) {
				send.accept(progress(id, "walking", (int) Math.round(player.position().distanceTo(center)), 0));
			}
		}

		private BlockPos interactionPart(Minecraft client) {
			LocalPlayer player = client.player;
			for (BlockPos candidate : bedParts(client, bedHead)) {
				if (withinInteractionRange(player, candidate)) {
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
				if (!client.level.dimensionType().bedWorks() || occupied(client, head)) continue;
				return head;
			}
			return nearestHead;
		}

		private static boolean occupied(Minecraft client, BlockPos head) {
			BlockState state = client.level.getBlockState(head);
			return state.getBlock() instanceof BedBlock && state.getValue(BedBlock.OCCUPIED);
		}

		private static boolean canSleepNow(Minecraft client) {
			long time = timeOfDay(client);
			return client.level.getLevelData().isThundering() || time >= 12_542 && time < 23_460;
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
		private static final int GIVE_UP_TICKS = 20 * 10;
		private static final int SWAP_WAIT_TICKS = 20;
		/**
		 * Vanilla consumes food only after the use input has been held for
		 * roughly 32 ticks. Calling useItem five times with gaps merely
		 * restarts the animation, so the item never changes.
		 */
		private static final int MIN_USE_TICKS = 20 * 3;
		private final String itemId;
		private int ticks;
		private int foodBefore;
		private String itemBefore;
		private int countBefore;
		private boolean useHeld;
		private boolean eatingStarted;
		private int swapSubmittedAt = -1;

		EatTask(String id, String itemId) {
			super(id);
			this.itemId = itemId;
		}

		@Override
		void start(Minecraft client) {
			LocalPlayer player = client.player;
			if (edible(player.getInventory().getSelected())) {
				beginEating(client);
				return;
			}
			for (int slot = 0; slot < 9; slot++) {
				if (!edible(player.getInventory().getItem(slot))) continue;
				player.getInventory().selected = slot;
				beginEating(client);
				return;
			}
			int foodSlot = -1;
			for (int slot = 9; slot < 36; slot++) {
				if (!edible(player.getInventory().getItem(slot))) continue;
				foodSlot = slot;
				break;
			}
			if (foodSlot < 0) {
				finish(id, "failed", "E_PRECONDITION", "no edible food in inventory");
				return;
			}
			int hotbar = foodHotbarSlot(player);
			player.getInventory().selected = hotbar;
			player.connection.send(new ServerboundSetCarriedItemPacket(hotbar));
			client.gameMode.handleInventoryMouseClick(
				player.inventoryMenu.containerId,
				foodSlot,
				hotbar,
				ClickType.SWAP,
				player
			);
			swapSubmittedAt = age;
			send.accept(progress(id, "equipping", 0, 1));
		}

		private boolean edible(ItemStack stack) {
			if (stack.isEmpty() || !stack.getItem().isEdible()) return false;
			return itemId == null || matches(stack, itemId);
		}

		/**
		 * Prefer an empty slot, then a low-value consumable/misc slot. Tools
		 * and construction stacks must stay in the hotbar because the mining
		 * and building state machines only search slots 0-8.
		 */
		private static int foodHotbarSlot(LocalPlayer player) {
			int best = 0;
			int bestScore = Integer.MIN_VALUE;
			for (int slot = 0; slot < 9; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				int score = 0;
				if (stack.isEmpty()) score += 1_000;
				if (!stack.isEmpty() && !stack.getItem().isEdible()) score += 20;
				if (!stack.isEmpty() && !stack.isDamageableItem()) score += 100;
				if (!(stack.getItem() instanceof BlockItem)) score += 40;
				if (!stack.isEmpty()) score += Math.max(0, 20 - stack.getCount());
				if (!stack.isEmpty() && stack.isDamageableItem()) score -= 500;
				if (score > bestScore) {
					bestScore = score;
					best = slot;
				}
			}
			return best;
		}

		private void beginEating(Minecraft client) {
			LocalPlayer player = client.player;
			ItemStack eating = player.getInventory().getSelected();
			foodBefore = player.getFoodData().getFoodLevel();
			itemBefore = BuiltInRegistries.ITEM.getKey(eating.getItem()).toString();
			countBefore = eating.getCount();
			eatingStarted = true;
			swapSubmittedAt = -1;
			holdUse(client, true);
			send.accept(progress(id, "eating", 0, 1));
		}

		@Override
		void tick(Minecraft client) {
			ticks++;
			if (swapSubmittedAt >= 0 && !eatingStarted) {
				if (edible(client.player.getInventory().getSelected())) {
					beginEating(client);
					return;
				}
				if (age - swapSubmittedAt > SWAP_WAIT_TICKS) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"could not equip food into the hotbar"
					);
				}
				return;
			}
			if (!eatingStarted) return;
			int foodAfter = client.player.getFoodData().getFoodLevel();
			ItemStack stack = client.player.getInventory().getSelected();
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
			if (ticks >= MIN_USE_TICKS && !client.player.isUsingItem()) {
				releaseUse(client);
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

		private void holdUse(Minecraft client, boolean held) {
			useHeld = held;
			client.options.keyUse.setDown(held);
		}

		private void releaseUse(Minecraft client) {
			if (!useHeld) return;
			useHeld = false;
			client.options.keyUse.setDown(false);
			if (client.player.isUsingItem()) {
				client.gameMode.releaseUsingItem(client.player);
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

		@Override
		void stop(Minecraft client) {
			if (client.player != null) {
				releaseUse(client);
			}
		}
	}

	/**
	 * Human-style pillaring: jump, look down and place a solid block in the
	 * cell the body just left. The block lands under the feet and raises the
	 * floor one level. This is the escape a player uses when a cave has no
	 * walkable route and the body has blocks but no pickaxe.
	 */
	private static final class PillarTask extends Task {
		private static final int MAX_TICKS = 20 * 20;
		private final String requestedBlock;
		private final int height;
		private int placed;
		private int baseY;
		private int jumpAt = -1;
		private boolean awaitingConfirm;
		private BlockPos targetCell;

		PillarTask(String id, String blockId, int height) {
			super(id);
			this.requestedBlock = blockId;
			this.height = Math.max(1, Math.min(16, height));
			this.emergencyAction = true;
		}

		@Override
		boolean validate(Minecraft client) {
			if (!super.validate(client)) return false;
			if (findBuildingBlock(client.player) < 0) {
				validationError = requestedBlock == null
					? "no solid building block in the hotbar"
					: "requested block is not a solid item in the hotbar: " + requestedBlock;
				return false;
			}
			return true;
		}

		@Override
		void start(Minecraft client) {
			int slot = findBuildingBlock(client.player);
			if (slot < 0) {
				finish(id, "failed", "E_PRECONDITION", "no solid building block in the hotbar");
				return;
			}
			client.player.getInventory().selected = slot;
			releaseWalkInput(client);
			baseY = client.player.blockPosition().getY();
			send.accept(progress(id, "pillar", 0, height));
		}

		@Override
		void tick(Minecraft client) {
			LocalPlayer player = client.player;
			if (placed >= height) {
				complete(client);
				return;
			}
			if (age > MAX_TICKS) {
				if (placed > 0) {
					finish(id, "completed", null, null, evidence());
				} else {
					finish(id, "failed", "E_TIMEOUT", "pillar did not place a block in time");
				}
				return;
			}
			releaseWalkInput(client);
			if (awaitingConfirm) {
				if (targetCell != null && !client.level.getBlockState(targetCell).canBeReplaced()) {
					placed++;
					baseY = targetCell.getY() + 1;
					awaitingConfirm = false;
					targetCell = null;
					send.accept(progress(id, "pillar", placed, height));
					if (placed >= height) complete(client);
					return;
				}
				if (age - jumpAt > 20) {
					awaitingConfirm = false;
					targetCell = null;
				}
				return;
			}
			if (player.onGround()) {
				player.jumpFromGround();
				jumpAt = age;
				return;
			}
			// Wait for the jump apex. Placing while still rising can push the
			// block into the player's own collision box and make the server
			// reject the use.
			if (player.getDeltaMovement().y < -0.15) return;
			if (player.getY() < baseY + 1.05) return;
			int x = player.blockPosition().getX();
			int z = player.blockPosition().getZ();
			BlockPos support = new BlockPos(x, baseY - 1, z);
			BlockPos target = support.above();
			if (!client.level.getBlockState(target).canBeReplaced()) return;
			if (player.getBoundingBox().minY < target.getY() + 1.0) return;
			CameraController.steerTo(player, Vec3.atCenterOf(support));
			BlockHitResult hit = BlockInteraction.hit(support, Direction.UP);
			if (!PlacementTarget.withinReach(
				player.getEyePosition().distanceToSqr(hit.getLocation())
			)) return;
			int slot = findBuildingBlock(player);
			if (slot < 0) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"ran out of building blocks while pillaring",
					evidence()
				);
				return;
			}
			player.getInventory().selected = slot;
			client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, hit);
			targetCell = target;
			awaitingConfirm = true;
			jumpAt = age;
		}

		private int findBuildingBlock(LocalPlayer player) {
			for (int slot = 0; slot < 9; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (stack.isEmpty()) continue;
				if (!(stack.getItem() instanceof BlockItem item)) continue;
				if (
					requestedBlock != null &&
					!BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(requestedBlock)
				) continue;
				if (!item.getBlock().defaultBlockState().isSolid()) continue;
				return slot;
			}
			return -1;
		}

		private void complete(Minecraft client) {
			finish(
				id,
				"completed",
				null,
				null,
				evidence()
			);
		}

		private JsonObject evidence() {
			JsonObject outcome = new JsonObject();
			outcome.addProperty("summary", "pillared up " + placed + " blocks");
			JsonArray changes = new JsonArray();
			for (int index = 0; index < placed; index++) {
				JsonObject change = new JsonObject();
				change.addProperty("kind", "block_placed");
				change.addProperty("detail", "pillar_up");
				changes.add(change);
			}
			outcome.add("changes", changes);
			return outcome;
		}

		@Override
		void stop(Minecraft client) {
			releaseWalkInput(client);
			CameraController.release();
			awaitingConfirm = false;
			targetCell = null;
		}
	}

	private static final class UseBlockTask extends Task {
		private final String blockId;
		private BlockPos targetPos;
		private InteractionEvidence.BlockSnapshot beforeBlock;
		private String beforeItem;
		private int beforeCount;
		private boolean screenBefore;
		private boolean openedScreen;
		private int submittedAt = -1;

		UseBlockTask(String id, String blockId) {
			super(id);
			this.blockId = blockId;
		}

		@Override
		void start(Minecraft client) {
			BlockPos nearby = blockId == null ? null : nearbyBlockPosition(
				client,
				client.player,
				BuiltInRegistries.BLOCK.get(ResourceLocation.tryParse(blockId)),
				8
			);
			BlockHitResult hit = nearby == null
				? null
				: BlockInteraction.nearestExposedHit(
					client.level,
					client.player.getEyePosition(),
					nearby
				);
			if (hit != null && withinInteractionRange(client.player, nearby)) {
				targetPos = nearby.immutable();
				beforeBlock = blockSnapshot(client, targetPos);
				rememberHand(client);
				screenBefore = client.screen != null;
				submittedAt = age;
				CameraController.steerTo(client.player, Vec3.atCenterOf(targetPos));
				client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, hit);
				send.accept(progress(id, "confirming", 0, 1));
			} else if (blockId == null || BuiltInRegistries.BLOCK.get(ResourceLocation.tryParse(blockId)) == Blocks.AIR) {
				rememberHand(client);
				submittedAt = age;
				client.gameMode.useItem(client.player, InteractionHand.MAIN_HAND);
				send.accept(progress(id, "confirming", 0, 1));
			} else {
				finish(id, "failed", "E_PRECONDITION", "target block is outside interaction reach");
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
				openedScreen = true;
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

		@Override
		void stop(Minecraft client) {
			if (!openedScreen) return;
			openedScreen = false;
			// A container opened by this task is our own UI state. Leaving it
			// open blocks every later skill with E_BUSY, which looks like the
			// body freezing at the workbench.
			if (client.player != null && client.screen instanceof AbstractContainerScreen<?>) {
				client.player.closeContainer();
			}
		}

		private void rememberHand(Minecraft client) {
			ItemStack stack = client.player.getInventory().getSelected();
			beforeItem = stack.isEmpty() ? null : BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
			beforeCount = stack.getCount();
		}

		private boolean itemChanged(Minecraft client) {
			ItemStack stack = client.player.getInventory().getSelected();
			String after = stack.isEmpty() ? null : BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
			return InteractionEvidence.itemChanged(beforeItem, beforeCount, after, stack.getCount());
		}

		private int handCount(Minecraft client) {
			return client.player.getInventory().getSelected().getCount();
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

	/**
	 * The first-night house from the shelter guide: a 5x3x5 wall ring plus a
	 * 5x5 roof. The two-block opening on +X is the doorway; the body builds
	 * from inside and can walk out when the roof is finished.
	 */
	static List<BlockPos> starterHutCells(BlockPos origin) {
		List<BlockPos> cells = new ArrayList<>();
		for (int y = 0; y <= 2; y++) {
			for (int x = -2; x <= 2; x++) {
				for (int z = -2; z <= 2; z++) {
					if (Math.abs(x) != 2 && Math.abs(z) != 2) continue;
					if (x == 2 && z == 0 && y <= 1) continue;
					cells.add(origin.offset(x, y, z).immutable());
				}
			}
		}
		for (int x = -2; x <= 2; x++) {
			for (int z = -2; z <= 2; z++) {
				cells.add(origin.offset(x, 3, z).immutable());
			}
		}
		return cells;
	}

	/**
	 * The selected floor-level centre of the hut plus the extra blocks needed
	 * to bring a lower side of the footprint up to that level. The camp chest
	 * usually sits one block above the surrounding ground; using the chest
	 * itself as the origin lifted the walls into the air and left the far
	 * corners without a support face.
	 */
	private record HutSite(
		BlockPos origin,
		List<BlockPos> foundation,
		int spread,
		int clearCost
	) {
	}

	private static final class PlaceTask extends Task {
		private static final int SURFACE_SEARCH_RADIUS = 4;
		private static final int EQUIP_WAIT_TICKS = 20;
		private static final int HUT_SITE_RADIUS = 12;
		private static final int HUT_WALK_BUDGET_TICKS = 20 * 30;
		private static final int HUT_WALK_STALL_TICKS = 20 * 4;
		private String blockId;
		/**
		 * Namespaced form of {@link #blockId}. `findHotbar` accepts "stone" and
		 * resolves it to "minecraft:stone", so the confirmation has to compare
		 * against the same canonical id or a real placement reads as a failure.
		 */
		private String expectedBlock;
		private int count;
		private final BlockPos requestedAt;
		private final String schematic;
		private List<BlockPos> targets = List.of();
		private BlockPos blueprintOrigin;
		private int placed;
		private BlockPos targetPos;
		private InteractionEvidence.BlockSnapshot beforeBlock;
		private int beforeCount;
		private int submittedAt = -1;
		private int equipSubmittedAt = -1;
		private boolean walkingToSite;
		private BlockPos walkTarget;
		private int walkStartedAt = -1;
		private int walkProgressAt = -1;
		private double walkLastDistance = Double.POSITIVE_INFINITY;
		private List<Vec3> siteWaypoints = List.of();
		private int siteWaypoint;
		private int sitePlanAt = -1;
		/** Set when the body turned toward another bed heading this tick. */
		private boolean awaitingRotation;

		PlaceTask(String id, String blockId, int count) {
			this(id, blockId, count, null, false);
		}

		PlaceTask(String id, String blockId, int count, BlockPos requestedAt) {
			this(id, blockId, count, requestedAt, false);
		}

		PlaceTask(
			String id,
			String blockId,
			int count,
			BlockPos requestedAt,
			boolean emergencyAction
		) {
			super(id);
			this.blockId = blockId;
			ResourceLocation parsed = ResourceLocation.tryParse(blockId);
			this.expectedBlock = parsed == null ? blockId : parsed.toString();
			this.count = count;
			this.requestedAt = requestedAt == null ? null : requestedAt.immutable();
			this.schematic = null;
			this.emergencyAction = emergencyAction;
		}

		PlaceTask(String id, String schematic) {
			super(id);
			this.blockId = "";
			this.expectedBlock = "";
			this.count = 0;
			this.requestedAt = null;
			this.schematic = schematic;
		}

		@Override
		boolean validate(Minecraft client) {
			if (!super.validate(client)) return false;
			if (schematic != null) return true;
			if (ResourceLocation.tryParse(blockId) == null) {
				validationError = "invalid block " + blockId;
				return false;
			}
			return true;
		}

		@Override
		void start(Minecraft client) {
			if (schematic != null) {
				if (!prepareSchematic(client)) return;
				if (walkingToSite) {
					send.accept(progress(id, "walking", 0, count));
					return;
				}
			}
			if (
				"minecraft:chest".equals(expectedBlock) &&
				requestedAt == null &&
				outsideEstablishedHome(client.player.blockPosition())
			) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"the chest must be placed at the established camp",
					placeEvidence("refused to move the storage anchor to a field station")
				);
				return;
			}
			beginPlacement(client);
		}

		@Override
		boolean keepScreen(Minecraft client) {
			// A right-click on an interactive support can open its menu before
			// the server processes the placement. Keep ticking so this task can
			// close its own accidental menu and retry on a plain block face.
			return submittedAt >= 0 && client.screen instanceof AbstractContainerScreen<?>;
		}

		private void beginPlacement(Minecraft client) {
			BlockPos exact = requestedTarget();
			if (exact != null) {
				beginTargetedPlacement(client, exact);
				return;
			}
			BlockPos feet = client.player.blockPosition();
			int terrainSurface = client.level.getHeight(
				Heightmap.Types.MOTION_BLOCKING_NO_LEAVES,
				feet.getX(),
				feet.getZ()
			);
			if (
				client.level.dimension() == Level.OVERWORLD &&
				StationPlacement.blockedUnderground(
					expectedBlock,
					feet.getY(),
					terrainSurface
				)
			) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"camp stations cannot be placed deep underground; return to the surface camp",
					placeEvidence("the placement would anchor the body's home in a mine")
				);
				return;
			}
			int slot = findHotbar(client.player, blockId);
			if (slot < 0) {
				int source = findInventorySlot(client.player, blockId);
				if (source >= 0) {
					int hotbar = blockHotbarSlot(client.player);
					client.player.getInventory().selected = hotbar;
					client.player.connection.send(new ServerboundSetCarriedItemPacket(hotbar));
					client.gameMode.handleInventoryMouseClick(
						client.player.inventoryMenu.containerId,
						source,
						hotbar,
						ClickType.SWAP,
						client.player
					);
					equipSubmittedAt = age;
					send.accept(progress(id, "equipping", placed, count));
					return;
				}
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
			equipSubmittedAt = -1;
			client.player.getInventory().selected = slot;
			BlockHitResult hit = findPlacementSurface(client);
			if (hit == null) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					placed > 0
						? "only " + placed + " of " + count + " blocks placed: no reachable placement surface"
						: "no reachable placement surface",
					placeEvidence(placed > 0 ? "no further placement surface" : null)
				);
				return;
			}
			targetPos = hit.getBlockPos().relative(hit.getDirection());
			beforeBlock = blockSnapshot(client, targetPos);
			beforeCount = client.player.getInventory().getSelected().getCount();
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
			if (
				PlacementTarget.overlapsPlayer(
					client.player.getBoundingBox(),
					targetPos.getX(),
					targetPos.getY(),
					targetPos.getZ()
				)
				|| PlacementTarget.overlapsStandingCell(
					client.player.blockPosition(),
					targetPos.getX(),
					targetPos.getY(),
					targetPos.getZ()
				)
			) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"no free placement surface beside the body",
					placeEvidence("the nearest reachable cell would overlap the player")
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
			CameraController.steerTo(client.player, Vec3.atCenterOf(hit.getBlockPos()));
			client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, hit);
			send.accept(progress(id, "confirming", placed, count));
		}

		private BlockPos requestedTarget() {
			if (!targets.isEmpty()) {
				return placed < targets.size() ? targets.get(placed) : null;
			}
			return requestedAt;
		}

		/**
		 * Fixed camp fixtures and the hut blueprint place into specific cells.
		 * The generic path chooses whichever adjacent cell the camera happens
		 * to face, which is how a second chest ended up wherever the body
		 * stopped instead of in the home's storage corner.
		 */
		private void beginTargetedPlacement(Minecraft client, BlockPos target) {
			if (!client.level.hasChunkAt(target)) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"the requested placement cell is not loaded",
					placeEvidence("target chunk is not loaded")
				);
				return;
			}
			BlockState current = client.level.getBlockState(target);
			if (!current.canBeReplaced()) {
				// A completed task and a fresh world snapshot race each other.
				// Replaying the exact same cell from the previous snapshot is
				// not a failure when the requested block is already there.
				ResourceLocation wanted = ResourceLocation.tryParse(blockId);
				if (
					wanted != null
						&& BuiltInRegistries.BLOCK.getKey(current.getBlock()).equals(wanted)
				) {
					finish(
						id,
						"completed",
						null,
						null,
						alreadyPresentEvidence()
					);
					return;
				}
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"the requested placement cell is already occupied",
					placeEvidence("the fixed cell is occupied")
				);
				return;
			}
			int slot = findHotbar(client.player, blockId);
			if (slot < 0) {
				int source = findInventorySlot(client.player, blockId);
				if (source >= 0) {
					int hotbar = blockHotbarSlot(client.player);
					client.player.getInventory().selected = hotbar;
					client.player.connection.send(new ServerboundSetCarriedItemPacket(hotbar));
					client.gameMode.handleInventoryMouseClick(
						client.player.inventoryMenu.containerId,
						source,
						hotbar,
						ClickType.SWAP,
						client.player
					);
					equipSubmittedAt = age;
					send.accept(progress(id, "equipping", placed, count));
					return;
				}
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					placed > 0
						? "only " + placed + " of " + count + " blocks could be placed: item is not in the hotbar"
						: "block item is not in the hotbar",
					placeEvidence(placed > 0 ? "ran out of " + blockId : null)
				);
				return;
			}
			equipSubmittedAt = -1;
			client.player.getInventory().selected = slot;
			if (
				PlacementTarget.overlapsPlayer(
					client.player.getBoundingBox(),
					target.getX(),
					target.getY(),
					target.getZ()
				)
				|| PlacementTarget.overlapsStandingCell(
					client.player.blockPosition(),
					target.getX(),
					target.getY(),
					target.getZ()
				)
			) {
				BlockPos alternative = alternativeStandCell(client, target);
				if (alternative != null) {
					startWalkingTo(alternative);
					send.accept(progress(id, "walking", placed, count));
					return;
				}
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"the fixed placement cell " + target.getX() + "," + target.getY() + "," +
						target.getZ() + " overlaps the body at " +
						client.player.blockPosition().getX() + "," +
						client.player.blockPosition().getY() + "," +
						client.player.blockPosition().getZ() +
						"; step aside first",
					placeEvidence("the fixed cell intersects the player")
				);
				return;
			}
			BlockHitResult support = findSupportForTarget(client, target);
			if (support == null) {
				StringBuilder nearby = new StringBuilder();
				for (Direction direction : Direction.values()) {
					BlockPos neighbor = target.relative(direction);
					BlockState state = client.level.getBlockState(neighbor);
					nearby
						.append(direction)
						.append('=')
						.append(BuiltInRegistries.BLOCK.getKey(state.getBlock()))
						.append(state.isAir() ? "(air)" : state.isSolidRender(client.level, neighbor) ? "(solid)" : "(soft)")
						.append(' ');
				}
				CraftMateBodyClient.LOGGER.info(
					"hut target unreachable target={} placed={}/{} player={} neighbors={}",
					target,
					placed,
					count,
					client.player.blockPosition(),
					nearby
				);
				BlockPos alternative = alternativeStandCell(client, target);
				if (alternative != null) {
					startWalkingTo(alternative);
					releaseWalkInput(client);
					send.accept(progress(id, "walking", placed, count));
					return;
				}
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"no reachable support face for the requested cell " +
						target.getX() + "," + target.getY() + "," + target.getZ(),
					placeEvidence("the fixed cell has no visible support")
				);
				return;
			}
			targetPos = target;
			beforeBlock = blockSnapshot(client, targetPos);
			beforeCount = client.player.getInventory().getSelected().getCount();
			submittedAt = age;
			CameraController.steerTo(client.player, Vec3.atCenterOf(support.getBlockPos()));
			client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, support);
			send.accept(progress(id, "confirming", placed, count));
		}

		/**
		 * A replay of an exact placement is complete when the requested block
		 * is already in the cell. The runtime still requires a block_placed
		 * change entry, so report the confirmed presence instead of an empty
		 * evidence object.
		 */
		private JsonObject alreadyPresentEvidence() {
			JsonObject outcome = new JsonObject();
			outcome.addProperty("summary", blockId + " is already present in the fixed cell");
			JsonArray changes = new JsonArray();
			JsonObject change = new JsonObject();
			change.addProperty("kind", "block_placed");
			change.addProperty("detail", blockId + " (already present)");
			changes.add(change);
			outcome.add("changes", changes);
			return outcome;
		}

		private static BlockHitResult findSupportForTarget(
			Minecraft client,
			BlockPos target
		) {
			LocalPlayer player = client.player;
			BlockHitResult best = null;
			double bestDistance = Double.POSITIVE_INFINITY;
			for (Direction direction : Direction.values()) {
				BlockPos support = target.relative(direction);
				BlockState state = client.level.getBlockState(support);
				if (state.isAir() || !state.isSolidRender(client.level, support)) continue;
				if (state.getMenuProvider(client.level, support) != null) continue;
				BlockHitResult hit = BlockInteraction.hit(support, direction.getOpposite());
				double distance = player.getEyePosition().distanceToSqr(hit.getLocation());
				if (!PlacementTarget.withinReach(distance)) continue;
				if (distance < bestDistance) {
					bestDistance = distance;
					best = hit;
				}
			}
			return best;
		}

		private boolean prepareSchematic(Minecraft client) {
			if (!"starter_hut".equals(schematic)) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"unknown schematic " + schematic,
					placeEvidence("unsupported schematic")
				);
				return false;
			}
			LocalPlayer player = client.player;
			BlockPos anchor =
				placedChest != null
					? placedChest
					: placedBed != null
						? placedBed
						: player.blockPosition();
			HutSite site = chooseHutSite(client, anchor);
			if (site == null) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"no clear 5x5 hut site within " + HUT_SITE_RADIUS +
						" blocks of the camp; clear trees or level a small patch first",
					placeEvidence("the camp terrain has no buildable 5x5 footprint")
				);
				return false;
			}
			List<BlockPos> steps = new ArrayList<>();
			steps.addAll(site.foundation());
			for (BlockPos cell : starterHutCells(site.origin())) {
				addReplaceable(client, steps, cell);
			}
			if (steps.size() < 8) {
				// The camp is already enclosed. Record the successful state so
				// the planner stops asking for a hut it cannot improve.
				placedShelter = site.origin().immutable();
				shelterBuilt = true;
				saveHomeMemory();
				finish(id, "completed", null, null, placeEvidence(null));
				return false;
			}
			String material = chooseHutMaterial(player, steps.size());
			if (material == null) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"need " + steps.size() +
						" planks, cobblestone or dirt for the starter hut and its foundation",
					placeEvidence("not enough building material")
				);
				return false;
			}
			blockId = material;
			expectedBlock = ResourceLocation.tryParse(material).toString();
			blueprintOrigin = site.origin().immutable();
			targets = steps;
			count = steps.size();
			BlockPos stand = standCellForSite(client, site.origin());
			if (stand == null) {
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"the chosen hut interior has no free standing cell",
					placeEvidence("the hut footprint is blocked by terrain or furniture")
				);
				return false;
			}
			CraftMateBodyClient.LOGGER.info(
				"hut site origin={} foundation={} targets={} stand={} player={} material={}",
				site.origin(),
				site.foundation().size(),
				steps.size(),
				stand,
				player.blockPosition(),
				material
			);
			if (!player.blockPosition().equals(stand)) {
				startWalkingTo(stand);
			}
			return true;
		}

		/**
		 * The chest and other furniture may occupy an interior cell, so the
		 * body cannot always stand on the geometric centre. Any free interior
		 * cell is accepted; the per-cell support search moves the body again
		 * when a far corner is out of reach.
		 */
		private static BlockPos standCellForSite(Minecraft client, BlockPos origin) {
			// The centre reaches every corner of the 5x5 ring. Prefer it even
			// when the body is already standing on a nearer interior cell;
			// building from an edge cell made the opposite corner exceed the
			// 4.5-block eye reach after most of the hut was already placed.
			if (canStandAt(client, origin)) return origin;
			BlockPos best = null;
			double bestDistance = Double.POSITIVE_INFINITY;
			LocalPlayer player = client.player;
			for (int dx = -1; dx <= 1; dx++) {
				for (int dz = -1; dz <= 1; dz++) {
					BlockPos cell = origin.offset(dx, 0, dz);
					if (!canStandAt(client, cell)) continue;
					double distance = player.position().distanceToSqr(Vec3.atCenterOf(cell));
					if (distance < bestDistance) {
						bestDistance = distance;
						best = cell;
					}
				}
			}
			return best;
		}

		/**
		 * The best interior cell for placing one blueprint block. The outer
		 * snapshot uses this to tell the planner where to walk before it
		 * issues an ordinary `place_block`; the body does not need a special
		 * build skill to move around the house.
		 */
		static BlockPos standForCell(Minecraft client, BlockPos origin, BlockPos target) {
			BlockPos best = null;
			double bestScore = Double.POSITIVE_INFINITY;
			// Search around the target, not only around the hut centre. The
			// outer 5x5 foundation corners are more than interaction range
			// from the middle of the house, so the centre-only scan fell back
			// to an origin cell that could never see the block it was asked
			// to place.
			// A roof cell sits three blocks above the interior floor, and the
			// only cells that can see it are inside the hut (dy=-3). Stopping
			// at -2 silently skipped every roof cell and left `remaining`
			// stuck after the walls were finished.
			for (int dy = 2; dy >= -4; dy--) {
				for (int dx = -2; dx <= 2; dx++) {
					for (int dz = -2; dz <= 2; dz++) {
						if (dx == 0 && dz == 0) continue;
						BlockPos cell = target.offset(dx, dy, dz);
						// Keep the body near the house. A stand several cells
						// outside the footprint is valid for one block but
						// makes the next wall cell unreachable again.
						if (
							Math.abs(cell.getX() - origin.getX()) > 3
								|| Math.abs(cell.getZ() - origin.getZ()) > 3
						) {
							continue;
						}
						if (!canStandAt(client, cell)) continue;
						if (supportFromStandCell(client, cell, target) == null) continue;
						double score =
							Math.hypot(dx, dz) * 2.0 +
							Math.abs(dy) * 3.0 +
							Math.hypot(
								cell.getX() - origin.getX(),
								cell.getZ() - origin.getZ()
							) * 0.25;
						// Upper wall and roof cells are still inside the
						// body's reach from the interior floor. Scoring a
						// same-height wall top as "closest" made the body
						// climb its own half-built shell, then fall back to
						// the floor and repeat forever. Prefer standing below
						// the target whenever the target is above the base.
						if (target.getY() > origin.getY()) {
							score += dy >= 0 ? 40.0 : 0.0;
						}
						if (score < bestScore) {
							bestScore = score;
							best = cell;
						}
					}
				}
			}
			return best;
		}

		private void startWalkingTo(BlockPos cell) {
			walkTarget = cell.immutable();
			walkingToSite = true;
			walkStartedAt = -1;
			walkProgressAt = -1;
			walkLastDistance = Double.POSITIVE_INFINITY;
			siteWaypoints = List.of();
			siteWaypoint = 0;
			sitePlanAt = -1;
		}

		private void walkToSite(Minecraft client) {
			LocalPlayer player = client.player;
			if (walkTarget == null) {
				walkingToSite = false;
				beginPlacement(client);
				return;
			}
			Vec3 center = Vec3.atCenterOf(walkTarget);
			double horizontal = Math.hypot(center.x - player.getX(), center.z - player.getZ());
			if (
				player.blockPosition().equals(walkTarget)
					&& Math.abs(center.y - player.getY()) <= 0.5
					&& horizontal <= 0.2
			) {
				walkingToSite = false;
				releaseWalkInput(client);
				send.accept(progress(id, "building", placed, count));
				beginPlacement(client);
				return;
			}
			if (walkStartedAt < 0) {
				walkStartedAt = age;
				walkProgressAt = age;
				walkLastDistance = horizontal;
			}
			if (age - walkStartedAt > HUT_WALK_BUDGET_TICKS) {
				releaseWalkInput(client);
				walkingToSite = false;
				finish(
					id,
					"timeout",
					"E_TIMEOUT",
					"could not reach the chosen hut site before the time limit",
					placeEvidence("hut site approach timed out")
				);
				return;
			}
			if (horizontal + 0.1 < walkLastDistance) {
				walkLastDistance = horizontal;
				walkProgressAt = age;
			} else if (
				siteWaypoints.isEmpty()
					&& age - walkProgressAt > HUT_WALK_STALL_TICKS
			) {
				releaseWalkInput(client);
				walkingToSite = false;
				finish(
					id,
					"failed",
					"E_PRECONDITION",
					"the chosen hut site is not reachable from the camp",
					placeEvidence("hut site approach made no progress")
				);
				return;
			}
			if (siteWaypoints.isEmpty() || age >= sitePlanAt + 20) {
				siteWaypoints = planSiteRoute(client, walkTarget);
				sitePlanAt = age;
				if (siteWaypoints.isEmpty() && horizontal > 8.0) {
					releaseWalkInput(client);
					walkingToSite = false;
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"no safe walking route from the camp to the chosen hut site",
						placeEvidence("the hut footprint is visible but unreachable")
					);
					return;
				}
				siteWaypoint = 0;
			}
			Vec3 step = center;
			if (!siteWaypoints.isEmpty()) {
				while (
					siteWaypoint < siteWaypoints.size() - 1
						&& player.position().distanceTo(siteWaypoints.get(siteWaypoint)) < 0.8
				) {
					siteWaypoint++;
				}
				step = siteWaypoints.get(siteWaypoint);
			}
			double stepHorizontal = Math.hypot(step.x - player.getX(), step.z - player.getZ());
			if (siteWaypoints.isEmpty() && stepHorizontal > 0.1) {
				// Fallback for a short, already visible step. The pathfinder
				// handles longer routes; this keeps a one-block sidestep from
				// failing merely because the A* start equals the goal.
				double heading = Math.atan2(-(step.x - player.getX()), step.z - player.getZ());
				Vec3 ahead = player.position().add(
					-Math.sin(heading) * 0.6,
					0,
					Math.cos(heading) * 0.6
				);
				BlockPos foot = BlockPos.containing(ahead.x, player.getY() - 0.5, ahead.z);
				boolean ledge = client.level.getBlockState(foot).isAir()
					&& client.level.getBlockState(foot.below()).isAir();
				if (ledge && player.onGround()) {
					releaseWalkInput(client);
					walkingToSite = false;
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"dangerous drop on the route to the hut site",
						placeEvidence("refused an unsafe hut site approach")
					);
					return;
				}
			}
			double heading = Math.atan2(-(step.x - player.getX()), step.z - player.getZ());
			boolean aligned = turnTowards(player, (float) Math.toDegrees(heading));
			CameraController.steerHeading(
				player,
				player.getYRot(),
				CameraController.displayPitch(player)
			);
			if (player.horizontalCollision && player.onGround()) player.jumpFromGround();
			setWalkInput(client, aligned);
			if (age % 20 == 0) {
				send.accept(progress(id, "walking", placed, count));
			}
		}

		private static List<Vec3> planSiteRoute(Minecraft client, BlockPos target) {
			BlockPos start = client.player.blockPosition();
			BoundedPathfinder.Result found = BoundedPathfinder.find(
				new BoundedPathfinder.Cell(start.getX(), start.getY(), start.getZ()),
				new BoundedPathfinder.Cell(target.getX(), target.getY(), target.getZ()),
				(cell) ->
					cell.x() == target.getX()
						&& cell.y() == target.getY()
						&& cell.z() == target.getZ(),
				(x, y, z) -> standableAt(client, new BlockPos(x, y, z)),
				traversal(client),
				4_000,
				64.0
			);
			if (found == null || !found.complete()) return List.of();
			List<Vec3> points = new ArrayList<>(found.path().size());
			for (BoundedPathfinder.Cell cell : found.path()) {
				points.add(new Vec3(cell.x() + 0.5, cell.y(), cell.z() + 0.5));
			}
			return points;
		}

		private static boolean canStandAt(Minecraft client, BlockPos cell) {
			BlockState feet = client.level.getBlockState(cell);
			BlockState head = client.level.getBlockState(cell.above());
			BlockState floor = client.level.getBlockState(cell.below());
			return feet.canBeReplaced()
				&& head.canBeReplaced()
				&& floor.isSolidRender(client.level, cell.below());
		}

		/**
		 * The 5x5 ring's far corner is outside the 4.5-block eye reach from an
		 * interior corner. Rather than failing the whole blueprint, find a
		 * free interior cell that can actually see and touch the next target.
		 */
		private BlockPos alternativeStandCell(Minecraft client, BlockPos target) {
			LocalPlayer player = client.player;
			// A plain `place_block at` is not a schematic, so blueprintOrigin
			// is null. Using the target as the search centre still lets the
			// body step aside when it is standing inside the cell it wants to
			// fill; returning null here deadlocked every such replay.
			BlockPos origin = blueprintOrigin != null ? blueprintOrigin : target;
			BlockPos best = standForCell(client, origin, target);
			// Even when the body's block position is already the stand cell,
			// standing at its edge can overlap the neighbouring target with
			// the player's bounding box. Returning that same cell is correct:
			// walkToSite re-centres the body before the next placement attempt,
			// and only begins building within 0.2 blocks of the cell centre.
			if (best != null) return best;
			// No support-visible cell is available yet. The immediate problem
			// is that the body occupies the cell it wants to fill, so any
			// adjacent standable cell is enough to break the deadlock. The
			// next snapshot re-plans from the new position.
			for (Direction direction : Direction.Plane.HORIZONTAL) {
				BlockPos cell = target.relative(direction);
				if (cell.equals(player.blockPosition())) continue;
				if (canStandAt(client, cell)) return cell;
			}
			return null;
		}

		private static BlockHitResult supportFromStandCell(
			Minecraft client,
			BlockPos stand,
			BlockPos target
		) {
			Vec3 eye = new Vec3(stand.getX() + 0.5, stand.getY() + 1.62, stand.getZ() + 0.5);
			BlockHitResult best = null;
			double bestDistance = Double.POSITIVE_INFINITY;
			for (Direction direction : Direction.values()) {
				BlockPos support = target.relative(direction);
				BlockState state = client.level.getBlockState(support);
				if (state.isAir() || !state.isSolidRender(client.level, support)) continue;
				if (state.getMenuProvider(client.level, support) != null) continue;
				BlockHitResult hit = BlockInteraction.hit(support, direction.getOpposite());
				double distance = eye.distanceToSqr(hit.getLocation());
				if (!PlacementTarget.withinReach(distance)) continue;
				if (distance < bestDistance) {
					bestDistance = distance;
					best = hit;
				}
			}
			return best;
		}

		/**
		 * Choose a clear 5x5 footprint near the camp. Ground height ignores
		 * trunks, leaves and furniture so a canopy camp is measured by the
		 * terrain rather than by the tree above it. A lower side is brought up
		 * to the centre floor with foundation blocks.
		 */
		private static HutSite chooseHutSite(Minecraft client, BlockPos anchor) {
			if (plannedHutSite != null) {
				List<BlockPos> foundation = plannedHutFoundation;
				if (foundation.isEmpty()) {
					HutSite remembered = hutSiteAt(
						client,
						plannedHutSite.getX(),
						plannedHutSite.getZ(),
						plannedHutSite.getY(),
						false
					);
					if (remembered != null) foundation = remembered.foundation();
				}
				// Re-running reachability from the body's current cell is not
				// a site check: a body standing inside its half-built walls
				// often has no A* route to the origin and the house moved to
				// a new place every few seconds. The site was proven when it
				// was chosen; only an explicit obstruction reset should move
				// it.
				return new HutSite(plannedHutSite, List.copyOf(foundation), 0, 0);
			}
			record Scored(HutSite site, double score) {}
			List<Scored> ranked = new ArrayList<>();
			for (int dx = -HUT_SITE_RADIUS; dx <= HUT_SITE_RADIUS; dx++) {
				for (int dz = -HUT_SITE_RADIUS; dz <= HUT_SITE_RADIUS; dz++) {
					BlockPos center = anchor.offset(dx, 0, dz);
					if (!client.level.hasChunkAt(center)) continue;
					HutSite candidate = hutSiteAt(
						client,
						center.getX(),
						center.getZ(),
						anchor.getY(),
						true
					);
					if (candidate == null) continue;
					double distance = Math.hypot(dx, dz);
					boolean chestInside = Math.abs(dx) <= 2 && Math.abs(dz) <= 2;
					double score =
						candidate.spread() * 3.0 +
						candidate.foundation().size() * 2.0 +
						candidate.clearCost() * 0.75 +
						distance +
						(chestInside ? 0.0 : 8.0) +
						Math.abs(candidate.origin().getY() - anchor.getY()) * 2.0;
					ranked.add(new Scored(candidate, score));
				}
			}
			ranked.sort(Comparator.comparingDouble(Scored::score));
			HutSite best = null;
			// A footprint across a ravine or behind a wall is not a house
			// site. Probe the few best-looking candidates instead of running
			// an A* search for every cell in the 21x21 window.
			for (int index = 0; index < Math.min(6, ranked.size()); index++) {
				HutSite candidate = ranked.get(index).site();
				if (!siteReachable(client, anchor, candidate.origin())) continue;
				best = candidate;
				break;
			}
			if (best != null) {
				plannedHutSite = best.origin();
				plannedHutFoundation = best.foundation();
				saveHomeMemory();
			} else {
				int logNow = GameActions.tick(client);
				if (logNow >= nextHutStepLogTick) {
					nextHutStepLogTick = logNow + 100;
					CraftMateBodyClient.LOGGER.info(
						"hut site none anchor={} player={} ranked={}",
						anchor,
						client.player.blockPosition(),
						ranked.size()
					);
				}
			}
			return best;
		}

		private static boolean siteReachable(
			Minecraft client,
			BlockPos anchor,
			BlockPos origin
		) {
			if (anchor.equals(origin)) return true;
			BlockPos start = client.player.blockPosition();
			BoundedPathfinder.Result found = BoundedPathfinder.find(
				new BoundedPathfinder.Cell(start.getX(), start.getY(), start.getZ()),
				new BoundedPathfinder.Cell(origin.getX(), origin.getY(), origin.getZ()),
				(cell) ->
					cell.x() == origin.getX()
						&& cell.y() == origin.getY()
						&& cell.z() == origin.getZ(),
				(x, y, z) -> canStandAt(client, new BlockPos(x, y, z)),
				traversal(client),
				2_000,
				32.0
			);
			return found != null && found.complete();
		}

		/**
		 * Validate one footprint. A column whose lowest foundation cell has no
		 * solid floor is a cliff or an overhang: the first block would float
		 * and the wall above it could never be placed. Those columns were the
		 * source of the "no reachable support face" retries at the old camp.
		 */
		private static HutSite hutSiteAt(
			Minecraft client,
			int centerX,
			int centerZ,
			int anchorY,
			boolean requireTargetsClear
		) {
			if (!client.level.hasChunkAt(new BlockPos(centerX, anchorY, centerZ))) return null;
			int baseY = hutGroundY(client.level, centerX, centerZ, anchorY);
			if (Math.abs(baseY - anchorY) > 3) return null;
			if (!canStandAt(client, new BlockPos(centerX, baseY, centerZ))) return null;
			List<Integer> heights = new ArrayList<>(25);
			int spread = 0;
			for (int x = -2; x <= 2; x++) {
				for (int z = -2; z <= 2; z++) {
					int ground = hutGroundY(
						client.level,
						centerX + x,
						centerZ + z,
						baseY
					);
					if (ground > baseY || baseY - ground > 2) return null;
					BlockPos support = new BlockPos(centerX + x, ground - 1, centerZ + z);
					if (!client.level.getBlockState(support).isSolidRender(client.level, support)) {
						return null;
					}
					heights.add(ground);
					spread += baseY - ground;
				}
			}
			int clearCost = hutClearCost(
				client,
				new BlockPos(centerX, baseY, centerZ),
				heights,
				baseY
			);
			if (clearCost < 0 || clearCost > 28) return null;
			List<BlockPos> foundation = new ArrayList<>();
			int index = 0;
			for (int x = -2; x <= 2; x++) {
				for (int z = -2; z <= 2; z++) {
					int ground = heights.get(index++);
					for (int y = ground; y < baseY; y++) {
						BlockPos cell = new BlockPos(centerX + x, y, centerZ + z);
						if (client.level.getBlockState(cell).canBeReplaced()) {
							foundation.add(cell.immutable());
						}
					}
				}
			}
			if (foundation.size() > 16) return null;
			return new HutSite(
				new BlockPos(centerX, baseY, centerZ),
				foundation,
				spread,
				clearCost
			);
		}

		private static int hutClearCost(
			Minecraft client,
			BlockPos origin,
			List<Integer> heights,
			int baseY
		) {
			int cost = 0;
			for (BlockPos cell : starterHutCells(origin)) {
				BlockState state = client.level.getBlockState(cell);
				if (state.canBeReplaced()) continue;
				if (!canClearHutObstruction(client, cell, state)) return -1;
				cost++;
			}
			int index = 0;
			for (int x = -2; x <= 2; x++) {
				for (int z = -2; z <= 2; z++) {
					int ground = heights.get(index++);
					for (int y = ground; y < baseY; y++) {
						BlockPos cell = new BlockPos(origin.getX() + x, y, origin.getZ() + z);
						BlockState state = client.level.getBlockState(cell);
						if (state.canBeReplaced()) continue;
						if (!canClearHutObstruction(client, cell, state)) return -1;
						cost++;
					}
				}
			}
			return cost;
		}

		private static boolean canClearHutObstruction(
			Minecraft client,
			BlockPos cell,
			BlockState state
		) {
			if (!state.getFluidState().isEmpty()) return false;
			if (state.getDestroySpeed(client.level, cell) < 0.0f) return false;
			if (state.is(Blocks.BEDROCK) || state.is(Blocks.BARRIER)) return false;
			if (state.getMenuProvider(client.level, cell) != null) return false;
			return !(state.getBlock() instanceof BedBlock);
		}

		/**
		 * The first air above the terrain. Trees and camp furniture are not
		 * ground: skipping them keeps a canopy camp at its real surface level
		 * instead of lifting the hut onto a trunk or a chest.
		 */
		private static int hutGroundY(Level level, int x, int z, int fromY) {
			int minY = Math.max(level.getMinBuildHeight(), fromY - 12);
			int startY = Math.min(fromY + 8, level.getMaxBuildHeight() - 1);
			for (int y = startY; y >= minY; y--) {
				BlockPos pos = new BlockPos(x, y, z);
				BlockState state = level.getBlockState(pos);
				if (state.isAir()) continue;
				if (state.is(BlockTags.LEAVES) || state.is(BlockTags.LOGS)) continue;
				if (state.getMenuProvider(level, pos) != null) continue;
				if (state.getBlock() instanceof BedBlock) continue;
				if (state.getFluidState().isEmpty() && state.blocksMotion()) return y + 1;
			}
			return fromY;
		}

		private static void addReplaceable(
			Minecraft client,
			List<BlockPos> steps,
			BlockPos pos
		) {
			if (client.level.getBlockState(pos).canBeReplaced()) {
				steps.add(pos.immutable());
			}
		}

		private static String chooseHutMaterial(LocalPlayer player, int needed) {
			Map<String, Integer> counts = new LinkedHashMap<>();
			for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (stack.isEmpty() || !(stack.getItem() instanceof BlockItem)) continue;
				String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				if (
					!id.endsWith("_planks")
						&& !"minecraft:cobblestone".equals(id)
						&& !"minecraft:dirt".equals(id)
				) {
					continue;
				}
				counts.merge(id, stack.getCount(), Integer::sum);
			}
			for (var entry : counts.entrySet()) {
				if (entry.getKey().endsWith("_planks") && entry.getValue() >= needed) {
					return entry.getKey();
				}
			}
			if (counts.getOrDefault("minecraft:cobblestone", 0) >= needed) {
				return "minecraft:cobblestone";
			}
			if (counts.getOrDefault("minecraft:dirt", 0) >= needed) {
				return "minecraft:dirt";
			}
			return null;
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
				if (state.isAir() || !state.isSolidRender(client.level, support)) continue;
				boolean opensMenu = state.getMenuProvider(client.level, support) != null;
				for (Direction face : Direction.values()) {
					BlockPos destination = support.relative(face);
					if (!client.level.getBlockState(destination).canBeReplaced()) continue;
					// A client ray can point into the player's own hitbox, but
					// the server rejects a full block there. Never submit a
					// placement that would trap the body.
					if (PlacementTarget.overlapsPlayer(
						player.getBoundingBox(),
						destination.getX(),
						destination.getY(),
						destination.getZ()
					)) continue;
					if (PlacementTarget.overlapsStandingCell(
						origin,
						destination.getX(),
						destination.getY(),
						destination.getZ()
					)) continue;
					BlockHitResult hit = BlockInteraction.hit(support, face);
					double distance = player.getEyePosition().distanceToSqr(hit.getLocation());
					candidates.add(new SurfaceCandidate(hit, distance, true, opensMenu));
				}
			}
			SurfaceCandidate best = PlacementTarget.choose(candidates);
			return best == null ? null : best.hit;
		}

		private static boolean surfaceAccepts(Minecraft client, BlockHitResult hit) {
			BlockPos support = hit.getBlockPos();
			BlockState state = client.level.getBlockState(support);
			if (state.isAir() || !state.isSolidRender(client.level, hit.getBlockPos())) return false;
			if (state.getMenuProvider(client.level, support) != null) return false;
			return client.level.getBlockState(hit.getBlockPos().relative(hit.getDirection())).canBeReplaced();
		}

		private record SurfaceCandidate(
			BlockHitResult hit,
			double distanceSqr,
			boolean destinationFree,
			boolean opensMenu
		)
			implements PlacementTarget.Surface {}

		private static boolean isBedItem(String itemId) {
			ResourceLocation id = ResourceLocation.tryParse(itemId);
			return id != null && BuiltInRegistries.ITEM.get(id) instanceof BedItem;
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
				client.player.setYRot(candidate.toYRot());
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
			if (walkingToSite) {
				walkToSite(client);
				return;
			}
			if (submittedAt >= 0 && client.screen instanceof AbstractContainerScreen<?>) {
				// The support was interactive despite the surface filter (for
				// example, a server-side block state changed between turns).
				// Reclaim the body and retry instead of waiting for the task
				// timeout while the GUI blocks every tick.
				client.player.closeContainer();
				submittedAt = -1;
				send.accept(progress(id, "turning", placed, count));
				return;
			}
			if (equipSubmittedAt >= 0) {
				if (findHotbar(client.player, blockId) >= 0) {
					equipSubmittedAt = -1;
					beginPlacement(client);
					return;
				}
				if (age - equipSubmittedAt > EQUIP_WAIT_TICKS) {
					finish(
						id,
						"failed",
						"E_PRECONDITION",
						"could not equip " + blockId + " into the hotbar"
					);
				}
				return;
			}
			if (awaitingRotation) {
				awaitingRotation = false;
				beginPlacement(client);
				return;
			}
			if (submittedAt < 0) return;
			int afterCount = client.player.getInventory().getSelected().getCount();
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
					saveHomeMemory();
				}
				if ("minecraft:chest".equals(expectedBlock) && targetPos != null) {
					if (!outsideEstablishedHome(targetPos)) {
						placedChest = targetPos.immutable();
						chestPlaced = true;
					}
					chestCrafted = true;
					saveHomeMemory();
				}
				if ("minecraft:furnace".equals(expectedBlock) && targetPos != null) {
					placedFurnace = targetPos.immutable();
					saveHomeMemory();
				}
				if (isBedItem(expectedBlock) && targetPos != null && placedBed == null) {
					placedBed = targetPos.immutable();
					bedPlaced = true;
					saveHomeMemory();
				}
				submittedAt = -1;
				if (placed >= count) {
					if (schematic != null && blueprintOrigin != null) {
						placedShelter = blueprintOrigin;
						shelterBuilt = true;
						saveHomeMemory();
					}
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

		private static int findInventorySlot(LocalPlayer player, String itemId) {
			ResourceLocation id = ResourceLocation.tryParse(itemId);
			if (id == null) return -1;
			for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (!stack.isEmpty() && stack.getItem() == BuiltInRegistries.ITEM.get(id)) {
					return slot;
				}
			}
			return -1;
		}

		/**
		 * Swap a backpack stack into the least valuable hotbar slot. Tools
		 * and food are poor candidates because the survival state machines
		 * search only slots 0-8; an empty slot is always preferred.
		 */
		private static int blockHotbarSlot(LocalPlayer player) {
			int best = 0;
			int bestScore = Integer.MIN_VALUE;
			for (int slot = 0; slot < 9; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				int score = 0;
				if (stack.isEmpty()) score += 1_000;
				if (!stack.isEmpty() && stack.isDamageableItem()) score -= 500;
				if (!stack.isEmpty() && stack.getItem() instanceof BlockItem) score += 100;
				if (!stack.isEmpty() && stack.getItem().isEdible()) score -= 200;
				if (!stack.isEmpty()) score += Math.max(0, 20 - stack.getCount());
				if (score > bestScore) {
					bestScore = score;
					best = slot;
				}
			}
			return best;
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
	 * The `Input` object is only a holder: `KeyboardInput.tick` derives the
	 * actual move vector from these `KeyMapping`s. Setting the fields directly
	 * without updating the key mappings leaves vanilla movement active.
	 */
	static void setWalkInput(Minecraft client, boolean forward) {
		setWalkInput(client, forward, false);
	}

	static void setWalkInput(Minecraft client, boolean forward, boolean sprint) {
		client.options.keyUp.setDown(forward);
		client.options.keyDown.setDown(false);
		client.options.keyLeft.setDown(false);
		client.options.keyRight.setDown(false);
		client.options.keyJump.setDown(false);
		client.options.keyShift.setDown(false);
		client.options.keySprint.setDown(forward && sprint);
		// Ask vanilla to derive the new move vector immediately from the keys.
		if (client.player != null && client.player.input instanceof KeyboardInput keyboard) {
			keyboard.tick(false, 1.0f);
		}
	}

	/**
	 * Swimming uses the same vanilla key state as walking, but the jump key is
	 * what makes the body rise in water. Keep it down every swim tick rather
	 * than calling `jumpFromGround`, which does nothing without ground.
	 */
	static void setSwimInput(Minecraft client, boolean forward) {
		client.options.keyUp.setDown(forward);
		client.options.keyDown.setDown(false);
		client.options.keyLeft.setDown(false);
		client.options.keyRight.setDown(false);
		client.options.keyJump.setDown(true);
		client.options.keyShift.setDown(false);
		client.options.keySprint.setDown(false);
		if (client.player != null && client.player.input instanceof KeyboardInput keyboard) {
			keyboard.tick(false, 1.0f);
		}
	}

	static void releaseWalkInput(Minecraft client) {
		setWalkInput(client, false);
	}

	/**
	 * Reflex movement while the camera watches an attacker. Vanilla reads the
	 * key mappings, not the `Input` holder, so both are updated together.
	 * `strafe` is +1 for left, -1 for right.
	 */
	static void setCombatMove(
		Minecraft client,
		int strafe,
		boolean backward,
		boolean forward,
		boolean sprint
	) {
		client.options.keyUp.setDown(forward && !backward);
		client.options.keyDown.setDown(backward);
		client.options.keyLeft.setDown(strafe > 0);
		client.options.keyRight.setDown(strafe < 0);
		client.options.keyJump.setDown(false);
		client.options.keyShift.setDown(false);
		client.options.keySprint.setDown(sprint);
		if (client.player != null && client.player.input instanceof KeyboardInput keyboard) {
			keyboard.tick(false, 1.0f);
		}
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
	 * Exact standability at a fixed feet level. `standingY` searches nearby
	 * levels and therefore returns `y + 1` for a ground-level cell whose own
	 * column is one block lower. Using that result with `== y` rejected every
	 * downslope cell, so A* could only climb and ordinary terrain looked like
	 * an impassable island. Path grids need this fixed-level check instead.
	 */
	static boolean standableAt(Minecraft client, BlockPos at) {
		BlockPos floorPos = at.below();
		BlockState floor = client.level.getBlockState(floorPos);
		BlockState feet = client.level.getBlockState(at);
		BlockState head = client.level.getBlockState(at.above());
		return floor.blocksMotion()
			&& !floor.is(BlockTags.LEAVES)
			&& floor.getFluidState().isEmpty()
			&& feet.getFluidState().isEmpty()
			&& (feet.isAir() || !feet.blocksMotion())
			&& head.getFluidState().isEmpty()
			&& (head.isAir() || !head.blocksMotion());
	}

	/**
	 * A cell the body's two-block frame can occupy at this feet level: no
	 * fluid, and neither the feet nor the head cell blocks motion. The floor
	 * is deliberately not required, so this also describes the air column the
	 * body passes through before a one-block drop.
	 */
	static boolean bodySpaceAt(Minecraft client, BlockPos at) {
		BlockState feet = client.level.getBlockState(at);
		BlockState head = client.level.getBlockState(at.above());
		return feet.getFluidState().isEmpty()
			&& (feet.isAir() || !feet.blocksMotion())
			&& head.getFluidState().isEmpty()
			&& (head.isAir() || !head.blocksMotion());
	}

	/**
	 * Movement geometry A* must respect to avoid routes that look valid on a
	 * standability grid but wedge the body in game.
	 *
	 * <p>A one-block drop needs the destination column clear at the body's
	 * current height: vanilla will not lower the body through a solid lip,
	 * and the body cannot fall until it has moved horizontally over the gap.
	 * A diagonal needs both orthogonal cells body-clear, because vanilla
	 * resolves horizontal movement one axis at a time and a closed corner
	 * cancels both axes.
	 */
	static BoundedPathfinder.Traversal traversal(Minecraft client) {
		return (from, to) -> {
			if (to.y() < from.y()) {
				// The body moves sideways at its current height first, so the
				// destination column must be open for the body's feet and head
				// at the current level, not merely at the lower destination.
				for (int y = to.y(); y <= from.y(); y++) {
					if (!bodySpaceAt(client, new BlockPos(to.x(), y, to.z()))) {
						return false;
					}
				}
			}
			int dx = to.x() - from.x();
			int dz = to.z() - from.z();
			if (dx != 0 && dz != 0) {
				// Vanilla resolves a diagonal one axis at a time, so both
				// orthogonal cells must clear the body at the higher of the two
				// levels. Checking only the destination let a body try to cut
				// through a closed corner and stall against it.
				int high = Math.max(from.y(), to.y());
				BlockPos first = new BlockPos(to.x(), high, from.z());
				BlockPos second = new BlockPos(from.x(), high, to.z());
				if (!bodySpaceAt(client, first) || !bodySpaceAt(client, second)) {
					return false;
				}
			}
			return true;
		};
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

	/**
	 * Turns the body toward a heading at a human rate and reports whether it
	 * is close enough to walk. Movement is gated on alignment because walking
	 * forward while still facing thirty degrees away drives the body into the
	 * wall it is trying to avoid.
	 */
	static boolean turnTowards(LocalPlayer player, float yaw) {
		player.setYRot(
			ViewSlew.stepYaw(player.getYRot(), yaw, ViewSlew.WALK_TURN_PER_TICK)
		);
		keepEyesOffEnderman(player);
		return ViewSlew.aligned(player.getYRot(), yaw, ViewSlew.WALK_ALIGNMENT);
	}

	/**
	 * Walking toward a waypoint can make the crosshair cross an enderman's
	 * face even when the route itself is harmless. Movement only needs yaw;
	 * glance down while one is close so an ordinary stroll cannot trigger a
	 * hostile teleport-and-hit. Explicit eye-stage attacks still use aimAt and
	 * are not affected by this movement safeguard.
	 */
	private static void keepEyesOffEnderman(LocalPlayer player) {
		if (player.level() == null) return;
		List<EnderMan> endermen = player.level().getEntitiesOfClass(
			EnderMan.class,
			player.getBoundingBox().inflate(24.0),
			EnderMan::isAlive
		);
		if (endermen.isEmpty()) return;
		float yaw = player.getYRot();
		for (EnderMan enderman : endermen) {
			double dx = enderman.getX() - player.getX();
			double dz = enderman.getZ() - player.getZ();
			float bearing = (float) Math.toDegrees(Math.atan2(-dx, dz));
			if (Math.abs(ViewSlew.wrap(bearing - yaw)) <= 22.0f) {
				player.setXRot(Math.max(player.getXRot(), 35.0f));
				return;
			}
		}
	}

	/** Slower, two-axis look used while idle. Returns true when settled. */
	static boolean lookTowards(LocalPlayer player, float yaw, float pitch) {
		player.setYRot(
			ViewSlew.stepYaw(player.getYRot(), yaw, ViewSlew.LOOK_TURN_PER_TICK)
		);
		player.setXRot(
			ViewSlew.stepPitch(player.getXRot(), pitch, ViewSlew.PITCH_PER_TICK)
		);
		return ViewSlew.aligned(player.getYRot(), yaw, 2.0f)
			&& Math.abs(player.getXRot() - Math.max(-90.0f, Math.min(90.0f, pitch))) <= 2.0f;
	}

	/**
	 * Points the body's real rotation at a world position. The rendered
	 * camera slews separately, but vanilla picks the block the attack key
	 * acts on from the player's own view vector. A mining task that only
	 * steers the camera restarts a destroy the crosshair never targets, so
	 * destroyProgress stays at zero forever.
	 */
	static void aimBodyAt(LocalPlayer player, Vec3 target) {
		Vec3 direction = target.subtract(player.getEyePosition());
		if (direction.length() < 1.0e-6) return;
		player.setYRot(ViewSlew.yawTo(direction.x, direction.z));
		player.setXRot(ViewSlew.pitchTo(direction.x, direction.y, direction.z));
	}

	/** True when the body stands on a leaf block instead of real ground. */
	static boolean onCanopy(Minecraft client) {
		LocalPlayer player = client.player;
		if (player == null || client.level == null) return false;
		BlockPos feet = player.blockPosition();
		SupportBlock support = supportBlock(client, player);
		BlockState feetState = client.level.getBlockState(feet);
		return CanopyEscape.trappedInsideTree(
				player.onGround(),
				feetState.is(BlockTags.LEAVES) || feetState.is(BlockTags.LOGS)
			)
			|| CanopyEscape.standingInTreeCanopy(
				player.onGround(),
				support.state().is(BlockTags.LEAVES),
				support.state().is(BlockTags.LOGS),
				leafNeighbours(client, feet)
			)
			|| CanopyEscape.standingOnRaisedCanopyPlatform(
				player.onGround(),
				client.level.canSeeSky(feet),
				leafNeighbours(client, feet),
				naturalGround(support.state())
			);
	}

	private static boolean naturalGround(BlockState state) {
		return state.is(BlockTags.DIRT)
			|| state.is(BlockTags.SAND)
			|| state.is(BlockTags.BASE_STONE_OVERWORLD)
			|| state.is(Blocks.GRAVEL)
			|| state.is(Blocks.CLAY)
			|| state.is(Blocks.SNOW_BLOCK)
			|| state.is(Blocks.MOSS_BLOCK)
			|| state.is(Blocks.MUD);
	}

	/**
	 * The block actually supporting the player's bounding box. A player can
	 * stand on the corner of a leaf or a step while `blockPosition()` (which
	 * floors one point) reports the adjacent empty column. That made canopy
	 * detection miss entirely after a respawn on a tree: the body had no
	 * navigation neighbour and did not look like it was on a canopy either.
	 */
	private static SupportBlock supportBlock(Minecraft client, LocalPlayer player) {
		AABB box = player.getBoundingBox();
		int supportY = (int) Math.floor(box.minY - 0.01);
		int minX = (int) Math.floor(box.minX + 0.001);
		int maxX = (int) Math.floor(box.maxX - 0.001);
		int minZ = (int) Math.floor(box.minZ + 0.001);
		int maxZ = (int) Math.floor(box.maxZ - 0.001);
		BlockPos leaf = null;
		BlockPos log = null;
		BlockPos solid = null;
		for (int x = minX; x <= maxX; x++) {
			for (int z = minZ; z <= maxZ; z++) {
				BlockPos pos = new BlockPos(x, supportY, z);
				BlockState state = client.level.getBlockState(pos);
				if (state.is(BlockTags.LEAVES)) {
					if (leaf == null) leaf = pos;
				} else if (state.is(BlockTags.LOGS)) {
					if (log == null) log = pos;
				} else if (
					state.blocksMotion()
						&& state.getFluidState().isEmpty()
				) {
					if (solid == null) solid = pos;
				}
			}
		}
		BlockPos chosen = solid != null ? solid : log != null ? log : leaf;
		if (chosen == null) chosen = player.blockPosition().below();
		return new SupportBlock(chosen, client.level.getBlockState(chosen));
	}

	private record SupportBlock(BlockPos pos, BlockState state) {
	}

	/** Leaves packed around the body are the wall that traps a felled tree. */
	private static int leafNeighbours(Minecraft client, BlockPos feet) {
		int leaves = 0;
		for (int dy = 0; dy <= 2; dy++) {
			for (Direction direction : Direction.Plane.HORIZONTAL) {
				if (client.level.getBlockState(feet.above(dy).relative(direction)).is(BlockTags.LEAVES)) {
					leaves++;
				}
			}
		}
		return leaves;
	}

	/**
	 * One tick of a controlled descent from a tree canopy. Returns true while
	 * the body is still on or above the canopy, false once it stands on a
	 * normal floor.
	 *
	 * <p>A leaves-only floor is deliberately excluded from the navigation
	 * grid, so a body that lands on a canopy has no standable neighbour and
	 * every A* search returns no route. Peeling the leaf under the feet drops
	 * it exactly one block onto the next layer; the last short gap is either
	 * taken or walked around, so the body never freezes on a tree.
	 */
	static boolean descendCanopyStep(Minecraft client) {
		LocalPlayer player = client.player;
		if (player == null || client.level == null) return false;
		if (!player.onGround()) {
			// The peeled leaf is gone and the body is falling to the next
			// layer. Keep the escape state; steering mid-air would cancel it.
			releaseWalkInput(client);
			return true;
		}
		BlockPos feet = player.blockPosition();
		BlockState feetState = client.level.getBlockState(feet);
		if (feetState.is(BlockTags.LEAVES) || feetState.is(BlockTags.LOGS)) {
			// The body is clipped inside a trunk or a leaf cell. Clear that
			// cell first; no horizontal escape target can be reached while
			// the camera is inside a solid block.
			return breakCanopyBlock(client, feet);
		}
		SupportBlock supportBlock = supportBlock(client, player);
		BlockPos support = supportBlock.pos();
		BlockState under = supportBlock.state();
		boolean leafSupport = under.is(BlockTags.LEAVES);
		boolean logSupport = under.is(BlockTags.LOGS) && leafNeighbours(client, feet) >= 1;
		boolean raisedPlatform =
			client.level.canSeeSky(feet)
				&& leafNeighbours(client, feet) >= 2
				&& !naturalGround(under);
		if (!leafSupport && !logSupport && !raisedPlatform) {
			releaseMiningInput(client);
			releaseWalkInput(client);
			CameraController.release();
			return false;
		}
		BlockState next = client.level.getBlockState(support.below());
		boolean belowIsCanopy = next.is(BlockTags.LEAVES)
			|| (next.is(BlockTags.LOGS) && leafNeighbours(client, feet.below()) >= 2);
		int drop = belowIsCanopy ? 1 : canopyDrop(client, support);
		boolean safeLanding = belowIsCanopy || canopyLandingSafe(client, support, drop);
		if (CanopyEscape.canPeel(belowIsCanopy, drop, safeLanding)) {
			return breakCanopyBlock(client, support);
		}
		// The last layer is too high for a safe drop. Walk the canopy toward a
		// column whose ground is closer instead of falling off the tree.
		BlockPos landing = canopyLandingColumn(client, feet);
		if (landing != null) {
			BlockPos step = nextCanopyStep(client, feet, landing);
			if (step != null) {
				steerTowards(client, step);
				return true;
			}
		}
		// Nothing safer exists inside the search radius. A controlled fall is
		// still progress; a frozen body never reaches the next tree.
		return breakCanopyBlock(client, support);
	}

	/** Blocks from the feet to the first non-leaf floor, or -1 if unknown. */
	private static int canopyDrop(Minecraft client, BlockPos support) {
		for (int depth = 1; depth <= 16; depth++) {
			BlockState state = client.level.getBlockState(support.below(depth));
			if (!state.getFluidState().isEmpty() || state.blocksMotion()) return depth;
		}
		return -1;
	}

	/**
	 * The drop that remains once every leaf in this column is gone. A canopy
	 * column always answers one block for {@link #canopyDrop}; landing choice
	 * needs the real ground instead.
	 */
	private static int canopyGroundDrop(Minecraft client, BlockPos support) {
		for (int depth = 1; depth <= 24; depth++) {
			BlockState state = client.level.getBlockState(support.below(depth));
			if (state.is(BlockTags.LEAVES)) continue;
			if (!state.getFluidState().isEmpty() || state.blocksMotion()) return depth;
		}
		return -1;
	}

	private static boolean canopyLandingSafe(Minecraft client, BlockPos support, int drop) {
		if (drop < 0 || drop > 24) return false;
		BlockState landing = client.level.getBlockState(support.below(drop));
		if (landing.getFluidState().is(FluidTags.LAVA)) return false;
		return !landing.is(Blocks.MAGMA_BLOCK)
			&& !landing.is(Blocks.CACTUS)
			&& !landing.is(Blocks.SWEET_BERRY_BUSH)
			&& !landing.is(Blocks.CAMPFIRE);
	}

	/**
	 * Nearest canopy column whose ground is close enough to leave safely.
	 * Keeping this inside four blocks means the body never wanders across an
	 * entire forest crown looking for a perfect exit.
	 */
	private static BlockPos canopyLandingColumn(Minecraft client, BlockPos feet) {
		BlockPos best = null;
		double bestDistance = Double.POSITIVE_INFINITY;
		for (BlockPos pos : BlockPos.betweenClosed(feet.offset(-4, 0, -4), feet.offset(4, 0, 4))) {
			BlockPos column = pos.immutable();
			if (column.equals(feet)) continue;
			if (!client.level.getBlockState(column.below()).is(BlockTags.LEAVES)) continue;
			if (!bodySpaceAt(client, column)) continue;
			int drop = canopyGroundDrop(client, column.below());
			if (!CanopyEscape.canLeaveCanopy(drop, canopyLandingSafe(client, column.below(), drop))) {
				continue;
			}
			double distance = feet.distSqr(column);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = column;
			}
		}
		return best;
	}

	/**
	 * One greedy step across the crown. Only cells that still have a leaf
	 * under them are eligible, so the walk cannot turn into a fall.
	 */
	private static BlockPos nextCanopyStep(Minecraft client, BlockPos feet, BlockPos goal) {
		BlockPos best = null;
		double bestDistance = feet.distSqr(goal);
		for (int dx = -1; dx <= 1; dx++) {
			for (int dz = -1; dz <= 1; dz++) {
				if (dx == 0 && dz == 0) continue;
				BlockPos next = feet.offset(dx, 0, dz);
				if (!client.level.getBlockState(next.below()).is(BlockTags.LEAVES)) continue;
				if (!bodySpaceAt(client, next)) continue;
				double distance = next.distSqr(goal);
				if (distance < bestDistance) {
					bestDistance = distance;
					best = next;
				}
			}
		}
		return best;
	}

	private static void steerTowards(Minecraft client, BlockPos column) {
		LocalPlayer player = client.player;
		double dx = column.getX() + 0.5 - player.getX();
		double dz = column.getZ() + 0.5 - player.getZ();
		player.setYRot((float) Math.toDegrees(Math.atan2(-dx, dz)));
		CameraController.steerHeading(
			player,
			player.getYRot(),
			CameraController.displayPitch(player)
		);
		setWalkInput(client, true);
	}

	private static boolean breakCanopyBlock(Minecraft client, BlockPos block) {
		LocalPlayer player = client.player;
		CameraController.steerTo(player, Vec3.atCenterOf(block));
		BlockHitResult hit = BlockInteraction.nearestExposedHit(
			client.level,
			player.getEyePosition(),
			block
		);
		if (!block.equals(canopyMining)) {
			releaseMiningInput(client);
			client.gameMode.startDestroyBlock(block, hit.getDirection());
			canopyMining = block.immutable();
			CraftMateBodyClient.LOGGER.info(
				"CraftMate canopy mining target={} state={} face={} eye={}",
				block,
				client.level.getBlockState(block),
				hit.getDirection(),
				player.getEyePosition()
			);
		} else {
			client.gameMode.continueDestroyBlock(block, hit.getDirection());
		}
		client.hitResult = hit;
		client.missTime = 0;
		return true;
	}

	public static boolean holdsMiningInput() {
		return agentInputAllowed && miningInputHeld;
	}

	/**
	 * A task must not leave the synthetic attack key held after it finishes,
	 * is cancelled, or a reflex interrupts it.
	 */
	static void releaseMiningInput(Minecraft client) {
		boolean shouldStop = miningInputHeld || agentInputAllowed;
		miningInputHeld = false;
		canopyMining = null;
		if (shouldStop && client.gameMode != null && client.gameMode.isDestroying()) {
			client.gameMode.stopDestroyBlock();
		}
	}

	/** Releases every synthetic input a finished or interrupted task can own. */
	public static void releaseInputs(Minecraft client) {
		releaseMiningInput(client);
		if (client.options != null) {
			releaseWalkInput(client);
			client.options.keyUse.setDown(false);
		}
	}

	/**
	 * Hands the shared key mappings back to the operator after takeover.
	 * Synthetic input is stopped, but keys the human is physically pressing
	 * must stay down; otherwise one cleanup tick makes a held W look like a
	 * missed keypress until the key is released and pressed again.
	 */
	private static void restorePhysicalInputs(Minecraft client) {
		if (client.options == null) return;
		long window = client.getWindow() == null ? 0L : client.getWindow().getWindow();
		restorePhysicalKey(client.options.keyUp, window);
		restorePhysicalKey(client.options.keyDown, window);
		restorePhysicalKey(client.options.keyLeft, window);
		restorePhysicalKey(client.options.keyRight, window);
		restorePhysicalKey(client.options.keyJump, window);
		restorePhysicalKey(client.options.keyShift, window);
		restorePhysicalKey(client.options.keySprint, window);
		restorePhysicalKey(client.options.keyUse, window);
		restorePhysicalKey(client.options.keyAttack, window);
		restorePhysicalKey(client.options.keyPickItem, window);
		if (client.player != null && client.player.input instanceof KeyboardInput keyboard) {
			keyboard.tick(false, 1.0f);
		}
	}

	private static void restorePhysicalKey(KeyMapping key, long window) {
		InputConstants.Key mapped = InputConstants.getKey(key.saveString());
		boolean physicallyDown = window != 0L && isPhysicallyDown(mapped, window);
		key.setDown(physicallyDown);
	}

	private static boolean isPhysicallyDown(InputConstants.Key mapped, long window) {
		if (mapped.getType() == InputConstants.Type.KEYSYM) {
			return InputConstants.isKeyDown(window, mapped.getValue());
		}
		if (mapped.getType() == InputConstants.Type.MOUSE) {
			return GLFW.glfwGetMouseButton(window, mapped.getValue()) == GLFW.GLFW_PRESS;
		}
		return false;
	}

	private static BlockPos findBlock(Minecraft client, java.util.function.Predicate<BlockState> matches) {
		BlockPos origin = client.player.blockPosition();
		Vec3 eye = client.player.getEyePosition();
		int radius = TARGET_SEARCH_RADIUS;
		List<BlockPos> candidates = new ArrayList<>();
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
			candidates.add(pos.immutable());
		}
		candidates.sort(
			Comparator.comparingDouble(candidate -> eye.distanceToSqr(Vec3.atCenterOf(candidate)))
		);
		for (BlockPos candidate : candidates) {
			if (BlockInteraction.hasExposedFace(client.level, candidate)) return candidate;
		}
		return null;
	}

	/**
	 * True when breaking {@code block} would remove the floor the body stands
	 * on in its current column. This is a pure geometric guard; the caller
	 * still needs a reachable exposed face for every real target.
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
	 * Fallback for a log that is present but not selected by the visible
	 * survey. The walk loop still requires a reachable exposed face before
	 * breaking it.
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
	 * Small, visible alternative search used from the per-tick destroy loop.
	 * The full 48-block scan belongs to task start only; repeating it every
	 * tick on a slow client blocked the render thread for the entire command
	 * deadline.
	 */
	private static BlockPos findBlockNear(
		Minecraft client,
		java.util.function.Predicate<BlockState> matches,
		int radius
	) {
		BlockPos origin = client.player.blockPosition();
		Vec3 eye = client.player.getEyePosition();
		BlockPos best = null;
		double bestScore = Double.POSITIVE_INFINITY;
		for (BlockPos pos : BlockPos.betweenClosed(
			origin.offset(-radius, -6, -radius),
			origin.offset(radius, 6, radius)
		)) {
			BlockState state = client.level.getBlockState(pos);
			if (!matches.test(state)) continue;
			if (removesCurrentSupport(client.player, pos)) continue;
			double distance = pos.distSqr(origin);
			if (distance > (double) radius * radius) continue;
			BlockPos candidate = pos.immutable();
			if (!canTouchBlock(client, eye, candidate)) continue;
			double score = eye.distanceToSqr(Vec3.atCenterOf(candidate));
			if (score < bestScore) {
				bestScore = score;
				best = candidate;
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
		for (NearbyCount block : nearbyCounts(client, player)) {
			JsonObject summary = new JsonObject();
			summary.addProperty("id", block.id());
			summary.addProperty("count", block.count());
			blocks.add(summary);
		}
		Vec3 eye = player.getEyePosition();
		for (VisibleWood wood : visibleWood(client, player)) {
			Vec3 center = Vec3.atCenterOf(new BlockPos(wood.x(), wood.y(), wood.z()));
			JsonObject summary = new JsonObject();
			summary.addProperty("id", wood.id());
			summary.addProperty("count", 1);
			summary.addProperty("x", wood.x());
			summary.addProperty("y", wood.y());
			summary.addProperty("z", wood.z());
			// Distance and bearing describe the body *now*. Caching either
			// with the scan made a valid target look several degrees stale
			// after the camera finished turning.
			summary.addProperty("distance", round(eye.distanceTo(center)));
			summary.addProperty("bearing", round(bearing(player, eye, center)));
			summary.addProperty("visible", true);
			blocks.add(summary);
		}
		Set<String> visibleOreKeys = new java.util.HashSet<>();
		for (OreTarget ore : visibleOres) {
			visibleOreKeys.add(ore.x() + ":" + ore.y() + ":" + ore.z());
		}
		for (OreTarget ore : localOres) {
			Vec3 center = Vec3.atCenterOf(new BlockPos(ore.x(), ore.y(), ore.z()));
			JsonObject summary = new JsonObject();
			summary.addProperty("id", ore.id());
			summary.addProperty("count", 1);
			summary.addProperty("x", ore.x());
			summary.addProperty("y", ore.y());
			summary.addProperty("z", ore.z());
			// Recompute distance/bearing for the current eye position. The
			// candidate list is cached for a few ticks, but the camera can turn
			// enough in that window to change what the planner should face.
			summary.addProperty("distance", round(eye.distanceTo(center)));
			summary.addProperty("bearing", round(bearing(player, eye, center)));
			summary.addProperty(
				"visible",
				visibleOreKeys.contains(ore.x() + ":" + ore.y() + ":" + ore.z())
			);
			blocks.add(summary);
		}
		return blocks;
	}

	private static List<NearbyCount> nearbyCounts(Minecraft client, LocalPlayer player) {
		// The operator owns input during takeover; a 17x9x17 block sweep and
		// ore raycasts are not worth a frame-time spike just to refresh a
		// dashboard nobody is steering with. Keep the last complete survey.
		if (!agentInputAllowed && nearbyCountsOrigin != null) return nearbyCounts;
		int now = tick(client);
		BlockPos origin = player.blockPosition();
		boolean fresh = cacheFresh(
			now,
			nearbyCountsTick,
			5,
			nearbyCountsOrigin == null ? -1.0 : nearbyCountsOrigin.distSqr(origin),
			2 * 2
		);
		if (fresh) return nearbyCounts;

		Map<String, Integer> counts = new java.util.TreeMap<>();
		List<OreTarget> oreCandidates = new ArrayList<>();
		for (BlockPos pos : BlockPos.betweenClosed(origin.offset(-8, -4, -8), origin.offset(8, 4, 8))) {
			BlockState state = client.level.getBlockState(pos);
			if (state.isAir()) continue;
			String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
			counts.merge(id, 1, Integer::sum);
			if (isOreId(id)) {
				oreCandidates.add(
					new OreTarget(
						id,
						pos.getX(),
						pos.getY(),
						pos.getZ(),
						Math.sqrt(pos.distSqr(origin))
					)
				);
			}
		}
		List<NearbyCount> next = counts.entrySet().stream()
			.sorted((left, right) -> {
				// A generic "most common blocks" limit let nearby water, stone
				// and dirt hide the exact station or ore the planner needed.
				// Keep progression-critical blocks ahead of bulk terrain.
				int priority = Integer.compare(
					nearbyPriority(left.getKey()),
					nearbyPriority(right.getKey())
				);
				if (priority != 0) return priority;
				int count = Integer.compare(right.getValue(), left.getValue());
				return count != 0 ? count : left.getKey().compareTo(right.getKey());
			})
			.limit(32)
			.map(entry -> new NearbyCount(entry.getKey(), entry.getValue()))
			.toList();
		localOres = oreCandidates.stream()
			.sorted((left, right) -> Double.compare(left.distance(), right.distance()))
			.limit(16)
			.toList();
		visibleOres = localOres.stream()
			.filter((ore) -> {
				BlockPos position = new BlockPos(ore.x(), ore.y(), ore.z());
				return hasVisibleFace(client, position)
					&& canSee(client, player, player.getEyePosition(), position);
			})
			.limit(12)
			.toList();
		nearbyCountsTick = now;
		nearbyCountsOrigin = origin.immutable();
		nearbyCounts = next;
		return nearbyCounts;
	}

	static boolean isOreId(String id) {
		return id.endsWith("_ore") || id.equals("minecraft:ancient_debris");
	}

	static int nearbyPriority(String id) {
		if (isLogId(id)) return 0;
		if (
			id.equals("minecraft:crafting_table")
				|| id.equals("minecraft:furnace")
				|| id.equals("minecraft:blast_furnace")
				|| id.equals("minecraft:smoker")
				|| id.endsWith("_bed")
				|| id.equals("minecraft:chest")
				|| id.equals("minecraft:trapped_chest")
				|| id.equals("minecraft:barrel")
		) {
			return 1;
		}
		if (isOreId(id)) return 2;
		return 3;
	}

	/**
	 * Samples the loaded world surface and remembers only wood the player has
	 * an unobstructed sight line to. A count-only scan cannot distinguish a
	 * tree across a valley from a block inside a sealed cave; this survey can,
	 * without pretending it sees through terrain.
	 *
	 * <p>The survey is sliced across client ticks with a hard time budget. A
	 * complete previous result remains visible while the next one is built.
	 * While a human owns the body, perception keeps its last result and does
	 * no scanning at all, because input latency matters more than fresh trees.
	 */
	private static List<VisibleWood> visibleWood(Minecraft client, LocalPlayer player) {
		if (!agentInputAllowed) {
			visibleWoodScan = null;
			return visibleWood;
		}
		int now = tick(client);
		BlockPos origin = player.blockPosition();
		// Deep underground there are no surface trunks to see. Heightmap
		// reads across 96 blocks are much more expensive there (the server is
		// still lighting/loading cave chunks), so keep the last surface survey
		// instead of paying 50ms for an empty result. A forest floor under a
		// canopy is only a few blocks below the heightmap and still scans.
		int surface = client.level.getHeight(
			Heightmap.Types.WORLD_SURFACE,
			origin.getX(),
			origin.getZ()
		);
		if (surface - origin.getY() > 12) {
			visibleWoodScan = null;
			return visibleWood;
		}
		if (visibleWoodScan != null) {
			if (
				visibleWoodScan.origin.distSqr(origin) > VISUAL_RESCAN_DISTANCE_SQR
					|| now - visibleWoodScan.startedTick > 20 * 15
			) {
				visibleWoodScan = null;
			} else if (advanceVisibleWoodScan(client, player, visibleWoodScan)) {
				publishVisibleWood(client, player, visibleWoodScan, now);
				visibleWoodScan = null;
				return visibleWood;
			} else {
				return visibleWood;
			}
		}
		boolean fresh = cacheFresh(
			now,
			visibleWoodScanTick,
			VISUAL_SCAN_INTERVAL_TICKS,
			visibleWoodOrigin == null ? -1.0 : visibleWoodOrigin.distSqr(origin),
			VISUAL_RESCAN_DISTANCE_SQR
		);
		if (fresh) return visibleWood;

		visibleWoodScan = new VisibleWoodScan(
			origin.immutable(),
			now,
			Math.max(0, now / VISUAL_SCAN_INTERVAL_TICKS),
			client.level.getMinBuildHeight(),
			client.level.getMaxBuildHeight() - 1
		);
		if (advanceVisibleWoodScan(client, player, visibleWoodScan)) {
			publishVisibleWood(client, player, visibleWoodScan, now);
			visibleWoodScan = null;
		}
		return visibleWood;
	}

	/**
	 * A cache must not be treated as fresh merely because its origin is null.
	 * The old sentinel was Integer.MIN_VALUE, so `now - last` overflowed to a
	 * negative number and the first empty result stayed cached forever.
	 */
	static boolean cacheFresh(
		int now,
		int lastScanTick,
		int maxAgeTicks,
		double originDistanceSqr,
		double rescanDistanceSqr
	) {
		if (originDistanceSqr < 0) return false;
		long age = (long) now - lastScanTick;
		return age >= 0 && age < maxAgeTicks && originDistanceSqr <= rescanDistanceSqr;
	}

	/**
	 * Processes whole world columns until the per-tick budget is exhausted.
	 * Returns true once every row has been sampled.
	 */
	private static boolean advanceVisibleWoodScan(
		Minecraft client,
		LocalPlayer player,
		VisibleWoodScan scan
	) {
		long deadline = System.nanoTime() + VISUAL_SCAN_BUDGET_NANOS;
		Vec3 eye = player.getEyePosition();
		// A hard row cap is the real guarantee. The time check can be fooled
		// by a single expensive chunk/heightmap lookup, but six rows bound
		// the work even when every lookup is slow.
		int rows = 0;
		while (scan.nextDx <= VISUAL_WOOD_RADIUS) {
			int dx = scan.nextDx;
			for (int dz = -VISUAL_WOOD_RADIUS; dz <= VISUAL_WOOD_RADIUS; dz++) {
				int distanceSqr = dx * dx + dz * dz;
				if (distanceSqr > scan.radiusSqr) continue;
				int x = scan.origin.getX() + dx;
				int z = scan.origin.getZ() + dz;
				// Beyond the dense radius one parity is sampled per scan. Two
				// consecutive scans still cover every column, but the render
				// thread does not pay for a million lookups on every refresh.
				if (
					!sampleColumn(
						x,
						z,
						distanceSqr,
						scan.denseRadiusSqr,
						scan.midRadiusSqr,
						scan.scanOrdinal
					)
				) {
					continue;
				}
				if (!client.level.hasChunkAt(new BlockPos(x, scan.origin.getY(), z))) continue;
				int surface = Math.min(
					scan.maxY,
					client.level.getHeight(Heightmap.Types.WORLD_SURFACE, x, z)
				);
				// Heightmap.getHeight returns the first free Y above the
				// highest block, so the tree canopy is at surface - 1. Check
				// both cells, then reject bare ground with one lookup.
				int top = surface;
				scan.cursor.set(x, top, z);
				BlockState surfaceState = client.level.getBlockState(scan.cursor);
				if (
					!surfaceState.is(BlockTags.LOGS)
						&& !surfaceState.is(BlockTags.LEAVES)
				) {
					top = surface - 1;
					if (top < scan.minY) continue;
					scan.cursor.set(x, top, z);
					surfaceState = client.level.getBlockState(scan.cursor);
					if (
						!surfaceState.is(BlockTags.LOGS)
							&& !surfaceState.is(BlockTags.LEAVES)
					) {
						continue;
					}
				}
				scan.columns++;
				int lowest = Math.max(scan.minY, top - VISUAL_COLUMN_DEPTH);
				BlockPos log = null;
				String logId = null;
				for (int y = top; y >= lowest; y--) {
					scan.cursor.set(x, y, z);
					BlockState state = client.level.getBlockState(scan.cursor);
					if (!state.is(BlockTags.LOGS)) continue;
					log = scan.cursor.immutable();
					logId = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
					break;
				}
				if (log == null) continue;
				BlockPos canopy = new BlockPos(x, top, z);
				Vec3 center = Vec3.atCenterOf(log);
				double distance = eye.distanceTo(center);
				if (distance > VISUAL_WOOD_RADIUS) continue;
				String id = logId;
				boolean duplicate = scan.candidates.stream().anyMatch((other) ->
					other.id().equals(id)
						&& Math.abs(other.top().getX() - x) <= 4
						&& Math.abs(other.top().getZ() - z) <= 4
				);
				if (duplicate) continue;
				scan.candidates.add(new WoodCandidate(id, log, canopy, distance));
			}
			scan.nextDx++;
			rows++;
			if (rows >= VISUAL_SCAN_ROWS_PER_TICK || System.nanoTime() >= deadline) break;
		}
		return scan.nextDx > VISUAL_WOOD_RADIUS;
	}

	private static void publishVisibleWood(
		Minecraft client,
		LocalPlayer player,
		VisibleWoodScan scan,
		int now
	) {
		Vec3 eye = player.getEyePosition();
		scan.candidates.sort((left, right) -> {
			int byDistance = Double.compare(left.distance(), right.distance());
			if (byDistance != 0) return byDistance;
			return Double.compare(
				Math.abs(bearing(player, eye, Vec3.atCenterOf(left.top()))),
				Math.abs(bearing(player, eye, Vec3.atCenterOf(right.top())))
			);
		});

		List<VisibleWood> found = new ArrayList<>();
		int probes = 0;
		long raycastStartedAt = System.nanoTime();
		for (WoodCandidate candidate : scan.candidates) {
			if (probes++ >= VISUAL_RAYCAST_LIMIT) break;
			BlockPos visiblePoint = firstVisibleTrunkPoint(
				client,
				player,
				eye,
				candidate.top()
			);
			if (visiblePoint == null && !canSee(client, player, eye, candidate.canopy())) {
				continue;
			}
			found.add(new VisibleWood(
				candidate.id(),
				candidate.top().getX(),
				candidate.top().getY(),
				candidate.top().getZ()
			));
			if (found.size() >= VISUAL_TARGET_LIMIT) break;
		}
		long raycastMs = (System.nanoTime() - raycastStartedAt) / 1_000_000L;
		long elapsedMs = (System.nanoTime() - scan.startedAt) / 1_000_000L;

		visibleWood = List.copyOf(found);
		visibleWoodColumns = scan.columns;
		visibleWoodCandidates = scan.candidates.size();
		visibleWoodScanTick = now;
		visibleWoodOrigin = scan.origin;
		String signature = visibleWood.stream()
			.map((wood) -> wood.id() + "@" + wood.x() + "," + wood.y() + "," + wood.z())
			.reduce("", (left, right) -> left + "|" + right);
		if (!signature.equals(visibleWoodSignature)) {
			visibleWoodSignature = signature;
			VisibleWood nearest = visibleWood.isEmpty() ? null : visibleWood.get(0);
			Vec3 nearestCenter = nearest == null
				? null
				: Vec3.atCenterOf(new BlockPos(nearest.x(), nearest.y(), nearest.z()));
			CraftMateBodyClient.LOGGER.info(
				"CraftMate perception visibleWood={} range={} nearest={} distance={} bearing={} columns={} candidates={} elapsedMs={}",
				visibleWood.size(),
				VISUAL_WOOD_RADIUS,
				nearest == null ? "none" : nearest.id(),
				nearestCenter == null ? "-" : Math.round(eye.distanceTo(nearestCenter) * 10.0) / 10.0,
				nearestCenter == null ? "-" : Math.round(bearing(player, eye, nearestCenter) * 10.0) / 10.0,
				visibleWoodColumns,
				visibleWoodCandidates,
				elapsedMs
			);
		}
		if (elapsedMs >= 20L) {
			CraftMateBodyClient.LOGGER.info(
				"CraftMate perception scan done in {}ms over {} ticks columns={} candidates={} visible={} raycastMs={}",
				elapsedMs,
				Math.max(1, now - scan.startedTick),
				scan.columns,
				scan.candidates.size(),
				found.size(),
				raycastMs
			);
		}
	}

	static boolean sampleColumn(
		int x,
		int z,
		int distanceSqr,
		int denseRadiusSqr,
		int midRadiusSqr,
		int scanOrdinal
	) {
		int stride = distanceSqr <= denseRadiusSqr ? 1 : distanceSqr <= midRadiusSqr ? 2 : 3;
		if (stride == 1) return true;
		int phase = scanOrdinal % stride;
		return Math.floorMod(x + phase, stride) == 0 && Math.floorMod(z + phase, stride) == 0;
	}

	/**
	 * A trunk is taller than one collision sample. A leaf layer can cover the
	 * top log while the exposed side of a lower log is still visible, so test
	 * a few sections down the trunk instead of discarding the whole tree.
	 */
	private static BlockPos firstVisibleTrunkPoint(
		Minecraft client,
		LocalPlayer player,
		Vec3 eye,
		BlockPos top
	) {
		for (int offset = 0; offset < 5; offset++) {
			BlockPos candidate = top.below(offset);
			if (!isLogId(blockId(client, candidate))) break;
			if (canSee(client, player, eye, candidate)) return candidate;
		}
		return null;
	}

	private static boolean canSee(
		Minecraft client,
		LocalPlayer player,
		Vec3 eye,
		BlockPos target
	) {
		BlockState state = client.level.getBlockState(target);
		if (state.isAir()) return false;
		BlockHitResult hit = client.level.clip(new ClipContext(
			eye,
			Vec3.atCenterOf(target),
			ClipContext.Block.VISUAL,
			ClipContext.Fluid.NONE,
			player
		));
		return hit.getType() == HitResult.Type.MISS || hit.getBlockPos().equals(target);
	}

	private static double bearing(LocalPlayer player, Vec3 eye, Vec3 target) {
		double dx = target.x - eye.x;
		double dz = target.z - eye.z;
		float targetYaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
		return net.minecraft.util.Mth.wrapDegrees(targetYaw - player.getYRot());
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

	private static BlockPos nearbyBlockPosition(
		Minecraft client,
		LocalPlayer player,
		Block block,
		int radius
	) {
		BlockPos origin = player.blockPosition();
		BlockPos best = null;
		double bestDistance = Double.POSITIVE_INFINITY;
		int radiusSqr = radius * radius;
		// Bound the vertical band. A full 97x17x97 cube is ~160k lookups on
		// the render thread even once every five seconds. Tables live on a
		// walkable surface, so a shallow band is enough to recover one.
		int floorY = Math.max(client.level.getMinBuildHeight(), origin.getY() - 8);
		int ceilingY = Math.min(client.level.getMaxBuildHeight() - 1, origin.getY() + 8);
		for (BlockPos pos : BlockPos.betweenClosed(
			origin.offset(-radius, floorY - origin.getY(), -radius),
			origin.offset(radius, ceilingY - origin.getY(), radius)
		)) {
			BlockPos candidate = pos.immutable();
			if (candidate.distSqr(origin) > radiusSqr) continue;
			if (!client.level.getBlockState(candidate).is(block)) continue;
			double distance = candidate.distSqr(origin);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = candidate;
			}
		}
		return best;
	}

	private static void noteObservedChestCapacity(BlockPos pos, int emptySlots) {
		BlockPos next = pos.immutable();
		if (
			observedChest != null &&
			observedChest.equals(next) &&
			observedChestEmptySlots == emptySlots
		) return;
		observedChest = next;
		observedChestEmptySlots = emptySlots;
		saveHomeMemory();
	}

	/** A double chest stores its two halves in adjacent block entities. */
	private static boolean sameChestCluster(BlockPos left, BlockPos right) {
		if (left.equals(right)) return true;
		if (left.getY() != right.getY()) return false;
		return Math.abs(left.getX() - right.getX()) + Math.abs(left.getZ() - right.getZ()) == 1;
	}

	private static boolean outsideEstablishedHome(BlockPos pos) {
		return !nearEstablishedHome(pos, 24);
	}

	private static boolean nearEstablishedHome(BlockPos pos, int radius) {
		BlockPos[] anchors = { placedChest, placedBed };
		boolean established = false;
		for (BlockPos anchor : anchors) {
			if (anchor == null) continue;
			established = true;
			if (anchor.distSqr(pos) <= (double) radius * radius) return true;
		}
		return !established;
	}

	/**
	 * A home chest can be dozens of blocks above the body after a mining
	 * descent. Scanning every block in that vertical box would stall the
	 * render thread; chests are block entities, so iterate only loaded chunk
	 * entity maps and recover the nearest matching container.
	 */
	private static BlockPos loadedChestPosition(
		Minecraft client,
		LocalPlayer player,
		int radius
	) {
		BlockPos origin = player.blockPosition();
		int chunkRadius = Math.max(1, (radius + 15) / 16);
		int centerX = origin.getX() >> 4;
		int centerZ = origin.getZ() >> 4;
		double radiusSqr = (double) radius * radius;
		BlockPos best = null;
		double bestDistance = Double.POSITIVE_INFINITY;
		for (int chunkX = centerX - chunkRadius; chunkX <= centerX + chunkRadius; chunkX++) {
			for (int chunkZ = centerZ - chunkRadius; chunkZ <= centerZ + chunkRadius; chunkZ++) {
				LevelChunk chunk = client.level.getChunk(chunkX, chunkZ);
				for (BlockEntity entity : chunk.getBlockEntities().values()) {
					BlockPos position = entity.getBlockPos();
					if (
						!entity.getBlockState().is(Blocks.CHEST) &&
						!entity.getBlockState().is(Blocks.TRAPPED_CHEST)
					) continue;
					if (!chestHasCampStation(client, position)) continue;
					double distance = position.distSqr(origin);
					if (distance > radiusSqr || distance >= bestDistance) continue;
					bestDistance = distance;
					best = position.immutable();
				}
			}
		}
		return best;
	}

	/**
	 * Loaded chunks can contain mineshaft and dungeon loot chests. A camp
	 * chest is the storage partner of a placed table or bed; accepting the
	 * nearest unrelated chest sent the body toward y=-15 in a live run while
	 * its real camp was above the mine.
	 */
	private static boolean chestHasCampStation(Minecraft client, BlockPos chest) {
		for (BlockPos pos : BlockPos.betweenClosed(
			chest.offset(-6, -4, -6),
			chest.offset(6, 4, 6)
		)) {
			BlockState state = client.level.getBlockState(pos);
			if (state.is(Blocks.CRAFTING_TABLE)) return true;
			if (state.getBlock() instanceof BedBlock) return true;
		}
		return false;
	}

	/** Beds have sixteen colour variants, so recover by block type, not id. */
	private static BlockPos nearbyBedPosition(
		Minecraft client,
		LocalPlayer player,
		int radius
	) {
		BlockPos origin = player.blockPosition();
		BlockPos best = null;
		double bestDistance = Double.POSITIVE_INFINITY;
		int radiusSqr = radius * radius;
		int floorY = Math.max(client.level.getMinBuildHeight(), origin.getY() - 8);
		int ceilingY = Math.min(client.level.getMaxBuildHeight() - 1, origin.getY() + 8);
		for (BlockPos pos : BlockPos.betweenClosed(
			origin.offset(-radius, floorY - origin.getY(), -radius),
			origin.offset(radius, ceilingY - origin.getY(), radius)
		)) {
			BlockPos candidate = pos.immutable();
			if (candidate.distSqr(origin) > radiusSqr) continue;
			if (!(client.level.getBlockState(candidate).getBlock() instanceof BedBlock)) continue;
			double distance = candidate.distSqr(origin);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = candidate;
			}
		}
		return best;
	}

	private static double round(double value) {
		return Math.round(value * 100.0) / 100.0;
	}

	static boolean withinInteractionRange(LocalPlayer player, BlockPos target) {
		Vec3 center = Vec3.atCenterOf(target);
		return InteractionReach.withinReach(
			player.getX(), player.getY(), player.getZ(), player.getEyeHeight(),
			center.x, center.y, center.z, 4.5
		);
	}

	/**
	 * A block action only needs a reachable exposed face. The rendered camera
	 * may look anywhere; the packet carries the coordinate and face directly.
	 */
	static boolean canTouchBlock(Minecraft client, Vec3 eye, BlockPos target) {
		BlockState state = client.level.getBlockState(target);
		if (state.isAir()) return false;
		Direction face = BlockInteraction.nearestExposedFace(client.level, eye, target);
		if (face == null) return false;
		return PlacementTarget.withinReach(
			eye.distanceToSqr(BlockInteraction.facePoint(target, face))
		);
	}

	/**
	 * A station flush with the body's floor has its top face at foot level.
	 * Clipping to the block centre made the ray pass through the floor block
	 * the body was standing on, so a crafting table one block away reported
	 * "not reachable" forever and the planner walked back and forth around
	 * it. Aim at the centre of the face nearest the eye instead.
	 */
	static Vec3 stationInteractionPoint(LocalPlayer player, BlockPos target) {
		return BlockInteraction.point(player.getEyePosition(), target);
	}

	static BlockHitResult stationHit(LocalPlayer player, BlockPos target) {
		return BlockInteraction.hit(player.getEyePosition(), target);
	}

	/**
	 * Interaction is reach-based. Vanilla checks the eye-to-block distance
	 * and accepts the face carried by the use packet; it never asks the
	 * camera to be centred on the block. Requiring a clip here turned a
	 * perfectly touchable table into a permanent "unreachable" state.
	 */
	static boolean stationReachable(LocalPlayer player, BlockPos target) {
		return withinInteractionRange(player, target);
	}

	private static int findHotbar(LocalPlayer player, String itemId) {
		ResourceLocation id = ResourceLocation.tryParse(itemId);
		for (int slot = 0; slot < 9; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!stack.isEmpty() && (stack.getItem() == BuiltInRegistries.ITEM.get(id))) return slot;
		}
		return -1;
	}

	private static boolean matches(ItemStack stack, String itemId) {
		ResourceLocation id = ResourceLocation.tryParse(itemId);
		return id != null && stack.getItem() == BuiltInRegistries.ITEM.get(id);
	}

	private static boolean blockMatches(ClientLevel level, BlockPos pos, String blockId) {
		ResourceLocation id = ResourceLocation.tryParse(blockId);
		return id != null && level.getBlockState(pos).getBlock() == BuiltInRegistries.BLOCK.get(id);
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
