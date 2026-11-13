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

	/**
	 * A distant chunk can be present in the client while its sections are
	 * still arriving. At world join that race returned void air for the camp
	 * chest and replaced the remembered home with a nearby outpost. Only
	 * trust a missing block after walking up to it.
	 */
	static boolean shouldForgetNearby(
		double distanceSq,
		boolean chunkLoaded,
		boolean blockPresent
	) {
		return distanceSq <= 8.0 * 8.0 && shouldForget(chunkLoaded, blockPresent);
	}
}
