package com.craftmate.body.bridge;

/**
 * Camp infrastructure belongs on the surface. A workbench, furnace, chest or
 * bed placed deep in a mine turns the body's "home" anchor into a hole,
 * scatters stations across the world and makes every later trip climb back to
 * the wrong place. A shallow mine entrance is still fine; only a real descent
 * is refused.
 */
final class StationPlacement {
	private static final int MAX_ENTRANCE_DEPTH = 8;

	private StationPlacement() {
	}

	static boolean isCampStation(String blockId) {
		return "minecraft:crafting_table".equals(blockId)
			|| "minecraft:furnace".equals(blockId)
			|| "minecraft:blast_furnace".equals(blockId)
			|| "minecraft:chest".equals(blockId)
			|| "minecraft:trapped_chest".equals(blockId)
			|| "minecraft:barrel".equals(blockId)
			|| blockId.endsWith("_bed");
	}

	static boolean blockedUnderground(String blockId, int feetY, int terrainSurfaceY) {
		return isCampStation(blockId) && feetY < terrainSurfaceY - MAX_ENTRANCE_DEPTH;
	}
}
