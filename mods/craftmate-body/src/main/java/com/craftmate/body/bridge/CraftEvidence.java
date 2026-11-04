package com.craftmate.body.bridge;

import java.util.Map;

/**
 * A completed craft is a result the server put in the output slot followed by
 * the same number of that item appearing in the main inventory. An open menu,
 * a recipe preview, or a result that was never taken is not a completed craft.
 */
final class CraftEvidence {
	private CraftEvidence() {
	}

	static int gained(Map<String, Integer> before, Map<String, Integer> after, String itemId) {
		return Math.max(0, count(after, itemId) - count(before, itemId));
	}

	/**
	 * A result that was visibly in the output slot and then appeared in the
	 * inventory in the same amount is a completed transfer. This does not rely
	 * on comparing grid snapshots across submissions: the recipe book may
	 * refill a grid after a result is taken, so "grid changed since the last
	 * submission" can be false even though the craft was real.
	 */
	static boolean transferConfirmed(
		int resultVisible,
		Map<String, Integer> inventoryBefore,
		Map<String, Integer> inventoryAfter,
		String itemId,
		int expected
	) {
		if (itemId == null || expected <= 0 || resultVisible <= 0) return false;
		return gained(inventoryBefore, inventoryAfter, itemId) >= expected;
	}

	/**
	 * Counts real free space before the menu handles the result: partially
	 * filled stacks of the same item plus completely empty slots. The maximum
	 * stack size matters because not every item stacks to 64.
	 */
	static boolean inventoryHasRoom(int emptySlots, int matchingFree, int amount, int maxStackSize) {
		if (amount <= 0) return true;
		if (maxStackSize <= 0) return false;
		return matchingFree + Math.max(0, emptySlots) * maxStackSize >= amount;
	}

	private static int count(Map<String, Integer> counts, String item) {
		return counts.getOrDefault(item, 0);
	}
}
