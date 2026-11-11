package com.craftmate.body.bridge;

/**
 * Picks the hotbar slot whose tool can actually produce the requested drop.
 * Mining with the wrong item still breaks some blocks, so "the block turned
 * to air" is not proof that the task succeeded.
 */
final class ToolSelection {
	private ToolSelection() {
	}

	/** Stone and ores require a pickaxe; dirt, wood and leaves do not. */
	static boolean canHarvest(boolean requiresCorrectTool, boolean hasCorrectTool) {
		return !requiresCorrectTool || hasCorrectTool;
	}

	/**
	 * Returns the best usable hotbar slot, or -1 when the requested block
	 * needs a correct tool and the hotbar has none.
	 *
	 * @param slots hotbar item ids, one per slot; null for an empty slot
	 * @param correctAt currently selected slot, used as a deterministic tie-break
	 */
	static int choose(
		String[] slots,
		boolean[] usable,
		boolean requiresCorrectTool,
		int correctAt,
		int current
	) {
		if (!requiresCorrectTool) return current;
		if (current >= 0 && current < slots.length && slots[current] != null && usable[current]) {
			return current;
		}
		for (int slot = 0; slot < slots.length; slot++) {
			if (slots[slot] != null && usable[slot]) return slot;
		}
		return correctAt >= 0 && correctAt < slots.length
				&& slots[correctAt] != null
				&& usable[correctAt]
			? correctAt
			: -1;
	}
}
