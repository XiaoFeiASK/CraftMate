package com.craftmate.body.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;

/**
 * A slow, bounded scan of loaded chunks for structure signatures.
 *
 * <p>The ordinary perception sweep only sees the 17x9x17 box around the body.
 * That is enough to mine the block in front of the face, but not enough to
 * find a village, a fortress or a stronghold: the endgame chain needs a
 * landmark beyond interaction range. This index walks nearby chunks a few per
 * tick, uses the section palette to skip empty terrain, and only deep-scans a
 * section whose palette could contain a signature.
 *
 * <p>It never guesses. A hint is a block that was actually observed, with its
 * coordinate; the planner still has to navigate and verify the structure.
 */
final class ChunkIndex {
	private static final int CHUNK_RADIUS = 5;
	private static final long BUDGET_NANOS = 3_000_000L;
	private static final int MAX_CHUNKS_PER_TICK = 2;
	private static final int MAX_HINTS = 24;

	record Hint(
		String kind,
		String label,
		int x,
		int y,
		int z,
		String detail,
		double confidence
	) {
	}

	private final Set<Long> scanned = new HashSet<>();
	private final Set<String> hintKeys = new HashSet<>();
	private final List<Hint> hints = new ArrayList<>();
	private final Deque<long[]> pending = new ArrayDeque<>();
	private int scannedCount;
	private int lastOriginX = Integer.MIN_VALUE;
	private int lastOriginZ = Integer.MIN_VALUE;

	/**
	 * One pass per client tick. The body already slices ore raycasts with a
	 * six-millisecond budget; this scan uses its own small budget so a chunk
	 * survey can never become the frame-time owner.
	 */
	void tick(Minecraft client, LocalPlayer player) {
		if (client.level == null || player == null) return;
		long deadline = System.nanoTime() + BUDGET_NANOS;
		if (pending.isEmpty() || movedFar(player)) enqueue(player);
		int chunks = 0;
		while (
			!pending.isEmpty()
				&& chunks < MAX_CHUNKS_PER_TICK
				&& System.nanoTime() < deadline
		) {
			long[] chunk = pending.poll();
			if (chunk == null) break;
			long key = key(chunk[0], chunk[1]);
			if (scanned.contains(key)) continue;
			scanChunk(client, chunk[0], chunk[1]);
			scanned.add(key);
			scannedCount++;
			chunks++;
		}
		// Bound long sessions: the index is a hint cache, not a save file.
		if (scanned.size() > 4096) scanned.clear();
	}

	List<Hint> hints() {
		return List.copyOf(hints);
	}

	int scannedCount() {
		return scannedCount;
	}

	void clear() {
		scanned.clear();
		hintKeys.clear();
		hints.clear();
		pending.clear();
		scannedCount = 0;
		lastOriginX = Integer.MIN_VALUE;
		lastOriginZ = Integer.MIN_VALUE;
	}

	boolean scanning() {
		return !pending.isEmpty();
	}

	JsonArray toJson() {
		JsonArray array = new JsonArray();
		for (Hint hint : hints) {
			JsonObject entry = new JsonObject();
			entry.addProperty("kind", hint.kind());
			entry.addProperty("label", hint.label());
			entry.addProperty("x", hint.x());
			entry.addProperty("y", hint.y());
			entry.addProperty("z", hint.z());
			entry.addProperty("detail", hint.detail());
			entry.addProperty("confidence", hint.confidence());
			array.add(entry);
		}
		return array;
	}

	private boolean movedFar(LocalPlayer player) {
		if (lastOriginX == Integer.MIN_VALUE) return true;
		int cx = player.blockPosition().getX() >> 4;
		int cz = player.blockPosition().getZ() >> 4;
		return Math.abs(cx - lastOriginX) >= 3 || Math.abs(cz - lastOriginZ) >= 3;
	}

	private void enqueue(LocalPlayer player) {
		lastOriginX = player.blockPosition().getX() >> 4;
		lastOriginZ = player.blockPosition().getZ() >> 4;
		pending.clear();
		List<long[]> order = new ArrayList<>();
		for (int dx = -CHUNK_RADIUS; dx <= CHUNK_RADIUS; dx++) {
			for (int dz = -CHUNK_RADIUS; dz <= CHUNK_RADIUS; dz++) {
				order.add(new long[] { lastOriginX + dx, lastOriginZ + dz });
			}
		}
		// Nearest first, so a nearby village is reported before a far chunk.
		order.sort(
			(left, right) ->
				Integer.compare(
					Math.abs((int) left[0] - lastOriginX) + Math.abs((int) left[1] - lastOriginZ),
					Math.abs((int) right[0] - lastOriginX) + Math.abs((int) right[1] - lastOriginZ)
				)
		);
		pending.addAll(order);
	}

	private void scanChunk(Minecraft client, long chunkX, long chunkZ) {
		LevelChunk chunk = client.level.getChunk((int) chunkX, (int) chunkZ);
		LevelChunkSection[] sections = chunk.getSections();
		int minSection = client.level.getMinSection();
		for (int index = 0; index < sections.length; index++) {
			LevelChunkSection section = sections[index];
			if (section == null || section.hasOnlyAir()) continue;
			if (!section.maybeHas(ChunkIndex::isSignature)) continue;
			int baseY = (minSection + index) * 16;
			for (int y = 0; y < 16; y++) {
				for (int z = 0; z < 16; z++) {
					for (int x = 0; x < 16; x++) {
						BlockState state = section.getBlockState(x, y, z);
						Hint hint = hintFor(state, (int) chunkX * 16 + x, baseY + y, (int) chunkZ * 16 + z);
						if (hint != null) record(hint);
					}
				}
			}
		}
	}

	private static boolean isSignature(BlockState state) {
		return hintFor(state, 0, 0, 0) != null;
	}

	private static Hint hintFor(BlockState state, int x, int y, int z) {
		if (state.is(Blocks.END_PORTAL_FRAME)) {
			return new Hint("stronghold", "要塞", x, y, z, "end_portal_frame", 1.0);
		}
		if (state.is(Blocks.END_PORTAL)) {
			return new Hint("end_portal", "末地传送门", x, y, z, "end_portal", 1.0);
		}
		if (state.is(Blocks.BELL)) {
			return new Hint("village", "村庄", x, y, z, "bell", 0.8);
		}
		if (state.is(Blocks.NETHER_BRICK_FENCE)) {
			return new Hint("fortress", "下界要塞", x, y, z, "nether_brick_fence", 0.8);
		}
		if (state.is(Blocks.SCULK_SHRIEKER)) {
			return new Hint("ancient_city", "远古城市", x, y, z, "sculk_shrieker", 0.7);
		}
		if (state.is(Blocks.SPAWNER)) {
			return new Hint("dungeon", "刷怪笼", x, y, z, "spawner", 0.5);
		}
		if (state.is(Blocks.NETHER_PORTAL)) {
			return new Hint("portal", "下界传送门", x, y, z, "nether_portal", 1.0);
		}
		return null;
	}

	private void record(Hint hint) {
		String key = hint.kind() + ":" + hint.x() + ":" + hint.y() + ":" + hint.z();
		if (!hintKeys.add(key)) return;
		hints.add(hint);
		if (hints.size() > MAX_HINTS) hints.remove(0);
	}

	private static long key(long x, long z) {
		return (x & 0xFFFFFFFFL) | ((z & 0xFFFFFFFFL) << 32);
	}
}
