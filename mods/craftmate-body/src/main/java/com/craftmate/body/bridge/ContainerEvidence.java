package com.craftmate.body.bridge;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * Container transfer is only confirmed when the inventory loses exactly what
 * the opened container gains. A menu update alone, or an item moving between
 * two inventory slots, is not a deposit.
 */
final class ContainerEvidence {
	private ContainerEvidence() {
	}

	/**
	 * Per-item balance is deliberate. Two different item types could
	 * otherwise cancel out to the same total while neither transfer was
	 * actually confirmed.
	 */
	static Map<String, Integer> moves(
		Map<String, Integer> inventoryBefore,
		Map<String, Integer> inventoryAfter,
		Map<String, Integer> containerBefore,
		Map<String, Integer> containerAfter
	) {
		Set<String> items = new LinkedHashSet<>();
		items.addAll(inventoryBefore.keySet());
		items.addAll(inventoryAfter.keySet());
		items.addAll(containerBefore.keySet());
		items.addAll(containerAfter.keySet());
		Map<String, Integer> moves = new LinkedHashMap<>();
		for (String item : items) {
			int lost = Math.max(
				0,
				count(inventoryBefore, item) - count(inventoryAfter, item)
			);
			int gained = Math.max(
				0,
				count(containerAfter, item) - count(containerBefore, item)
			);
			if (lost > 0 && lost == gained) moves.put(item, lost);
		}
		return moves;
	}

	static int moved(
		Map<String, Integer> inventoryBefore,
		Map<String, Integer> inventoryAfter,
		Map<String, Integer> containerBefore,
		Map<String, Integer> containerAfter
	) {
		return moves(inventoryBefore, inventoryAfter, containerBefore, containerAfter)
			.values()
			.stream()
			.mapToInt(Integer::intValue)
			.sum();
	}

	static boolean confirmed(
		Map<String, Integer> inventoryBefore,
		Map<String, Integer> inventoryAfter,
		Map<String, Integer> containerBefore,
		Map<String, Integer> containerAfter
	) {
		return moved(inventoryBefore, inventoryAfter, containerBefore, containerAfter) > 0;
	}

	/**
	 * Explains why a transfer stopped without guessing that the container was
	 * full merely because one quick-move did not transfer a whole stack.
	 */
	static String incompleteReason(boolean menuOpen, boolean itemRemaining, boolean containerHasSpace) {
		if (!menuOpen) return "the container screen closed before the transfer was confirmed";
		if (!itemRemaining) return "no more matching items remain in the inventory";
		if (!containerHasSpace) return "the container has no room for another matching item";
		return "the container accepted only part of the requested amount";
	}

	private static int count(Map<String, Integer> counts, String item) {
		return counts.getOrDefault(item, 0);
	}
}
