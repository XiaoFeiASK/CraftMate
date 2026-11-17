package com.craftmate.body.bridge;

/**
 * Picks the hotbar slot whose tool can actually produce the requested drop.
 * Mining with the wrong item still breaks some blocks, so "the block turned
 * to air" is not proof that the task succeeded.
 */
final class ToolSelection {
	/**
	 * A tool this close to breaking is not a real choice when a healthy
	 * replacement is one hotbar slot away.
	 */
	private static final int MIN_HEALTHY_USES = 8;
	/** Avoid swapping between two nearly identical tools every block. */
	private static final int DURABILITY_MARGIN = 16;

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

	/**
	 * Pick the best usable hotbar slot for harvesting a block: fastest first,
	 * then the most remaining uses. Vanilla gives every tool of the same
	 * material the same speed, so a body that crafts a fresh replacement used
	 * to keep mining with the worn tool until it snapped. The current slot is
	 * sticky so two healthy tools of the same tier do not flip every block.
	 */
	static int chooseBest(boolean[] usable, float[] speed, int[] remaining, int current) {
		int healthy = chooseBest(usable, speed, remaining, current, true);
		return healthy >= 0
			? healthy
			: chooseBest(usable, speed, remaining, current, false);
	}

	private static int chooseBest(
		boolean[] usable,
		float[] speed,
		int[] remaining,
		int current,
		boolean requireHealthy
	) {
		int best = -1;
		float bestSpeed = -1.0f;
		int bestRemaining = -1;
		if (
			current >= 0
				&& current < usable.length
				&& usable[current]
				&& (!requireHealthy || remaining[current] >= MIN_HEALTHY_USES)
		) {
			best = current;
			bestSpeed = speed[current];
			bestRemaining = remaining[current];
		}
		for (int slot = 0; slot < usable.length; slot++) {
			if (!usable[slot] || slot == best) continue;
			if (requireHealthy && remaining[slot] < MIN_HEALTHY_USES) continue;
			float slotSpeed = speed[slot];
			int slotRemaining = remaining[slot];
			boolean faster = slotSpeed > bestSpeed + 1.0e-4f;
			boolean sameSpeed = Math.abs(slotSpeed - bestSpeed) <= 1.0e-4f;
			boolean moreUses = sameSpeed && slotRemaining > bestRemaining + DURABILITY_MARGIN;
			if (best < 0 || faster || moreUses) {
				best = slot;
				bestSpeed = slotSpeed;
				bestRemaining = slotRemaining;
			}
		}
		return best;
	}
}
