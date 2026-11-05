package com.craftmate.body.bridge;

import java.util.Map;
import java.util.Set;

/**
 * Mining is complete only when the body has picked up the drop. A block
 * turning to air is useful evidence but says nothing about whether the item
 * despawned, fell into lava, or is still on the ground.
 */
final class MiningPickupEvidence {
	private MiningPickupEvidence() {
	}

	/**
	 * Items that appeared in the inventory after the block was destroyed and
	 * that were not present in the pre-break snapshot count as a confirmed
	 * pickup. Callers pass the block id as documentation; the inventory delta
	 * is the actual proof.
	 */
	static Map<String, Integer> gains(
		Map<String, Integer> before,
		Map<String, Integer> after
	) {
		Map<String, Integer> gained = new java.util.TreeMap<>();
		for (var entry : after.entrySet()) {
			int delta = entry.getValue() - before.getOrDefault(entry.getKey(), 0);
			if (delta > 0) gained.put(entry.getKey(), delta);
		}
		return gained;
	}

	/**
	 * A drop can be delayed by the server. Waiting for a specific item keeps
	 * the task honest without requiring the client to predict loot tables.
	 */
	static boolean satisfied(
		Map<String, Integer> before,
		Map<String, Integer> after,
		int required
	) {
		return total(gains(before, after)) >= required;
	}

	static int total(Map<String, Integer> counts) {
		return counts.values().stream().mapToInt(Integer::intValue).sum();
	}

	/**
	 * A pickup can be proven for one item while another drop is still on the
	 * ground. The remaining drops are not a failure as long as the requested
	 * count was met; they are reported as `unconfirmed` evidence.
	 */
	static Set<String> unconfirmedItems(
		Map<String, Integer> gained,
		Set<String> expected
	) {
		Set<String> missing = new java.util.TreeSet<>();
		for (String item : expected) {
			if (gained.getOrDefault(item, 0) <= 0) missing.add(item);
		}
		return missing;
	}
}
