package com.craftmate.body.bridge;

/**
 * Pickup is only proven by the inventory. A dropped item disappearing can
 * mean another player took it, it despawned, or the server rejected the
 * pickup; none of those are "collected".
 */
final class CollectionEvidence {
	private CollectionEvidence() {
	}

	static int gain(int before, int after) {
		return Math.max(0, after - before);
	}

	static boolean satisfied(int before, int after, int requested) {
		return gain(before, after) >= requested;
	}

	/**
	 * Distinguishes a normal partial result from a full inventory. A body
	 * standing on an item with no gain for a while is more likely blocked than
	 * still walking, and the caller should report the difference.
	 */
	static String blockedReason(boolean nearItem, int stuckTicks, int stallTicks) {
		if (!nearItem) return "no progress toward the dropped item";
		if (stuckTicks >= stallTicks) return "item is within reach but the inventory did not change";
		return null;
	}
}
