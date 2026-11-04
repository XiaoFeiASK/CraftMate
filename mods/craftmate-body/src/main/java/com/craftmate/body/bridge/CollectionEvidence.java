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
	 *
	 * <p>Not being at the item yet is not a failure: pickup needs an approach
	 * first. Only a stalled approach counts as blocked, which is why the stall
	 * window is checked before {@code nearItem}.
	 */
	static String blockedReason(boolean nearItem, int stuckTicks, int stallTicks) {
		if (stuckTicks < stallTicks) return null;
		return nearItem
			? "item is within reach but the inventory did not change"
			: "no progress toward the dropped item";
	}
}
