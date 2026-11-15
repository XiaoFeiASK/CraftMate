package com.craftmate.body.bridge;

/**
 * Camp infrastructure belongs on the surface. A workbench, chest or bed
 * placed deep in a mine turns the body's "home" anchor into a hole, scatters
 * stations across the world and makes every later trip climb back to the
 * wrong place. A furnace is deliberately not in that set: it is a portable
 * tool station that never becomes a home anchor, and smelting the ore at the
 * mine face is the intended field behaviour. A workbench is portable too: a
 * player carries one down to craft a furnace or a pickaxe at the ore face.
 * The placement path keeps such a table out of home memory unless it is
 * actually built beside the established camp. A shallow mine entrance is
 * still fine; only a real descent is refused for the durable camp fixtures.
 */
final class StationPlacement {
	private static final int MAX_ENTRANCE_DEPTH = 8;

	private StationPlacement() {
	}

	static boolean isCampStation(String blockId) {
		return "minecraft:chest".equals(blockId)
			|| "minecraft:trapped_chest".equals(blockId)
			|| "minecraft:barrel".equals(blockId)
			|| blockId.endsWith("_bed");
	}

	static boolean blockedUnderground(String blockId, int feetY, int terrainSurfaceY) {
		return isCampStation(blockId) && feetY < terrainSurfaceY - MAX_ENTRANCE_DEPTH;
	}
}
