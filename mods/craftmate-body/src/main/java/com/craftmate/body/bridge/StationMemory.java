package com.craftmate.body.bridge;

/**
 * A client level only knows blocks inside loaded chunks. Reading an
 * unloaded station position returns void air, which is not evidence that the
 * player broke the station. The remembered table, furnace, chest and bed are
 * therefore forgotten only when their chunk is loaded and the block really
 * disappeared; otherwise leaving the base for a mining trip would erase the
 * camp anchor and make the planner build a new station at the next stop.
 */
final class StationMemory {
	private StationMemory() {
	}

	static boolean shouldForget(boolean chunkLoaded, boolean blockPresent) {
		return chunkLoaded && !blockPresent;
	}
}
