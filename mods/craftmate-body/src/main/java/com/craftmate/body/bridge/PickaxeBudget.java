package com.craftmate.body.bridge;

/**
 * Chooses the pickaxe that should actually make a descent. Hotbar order is
 * irrelevant: a full backup in the backpack is worth more than the worn tool
 * currently held, and switching to it is a normal player action.
 */
final class PickaxeBudget {
	private PickaxeBudget() {
	}

	record Candidate(int slot, String item, int uses, float speed, int tier) {
	}

	static int requiredUses(int depth, int branchLength) {
		return Math.max(12, depth + branchLength * 2 + 8);
	}

	static Candidate choose(Candidate[] candidates, boolean needsStone, int required) {
		int minimumTier = needsStone ? 2 : 1;
		Candidate enough = null;
		Candidate richest = null;
		for (Candidate candidate : candidates) {
			if (candidate == null || candidate.tier() < minimumTier) continue;
			if (richest == null || candidate.uses() > richest.uses()
				|| (candidate.uses() == richest.uses() && candidate.tier() > richest.tier())) {
				richest = candidate;
			}
			if (candidate.uses() < required) continue;
			if (enough == null || candidate.speed() > enough.speed()
				|| (candidate.speed() == enough.speed() && candidate.uses() > enough.uses())
				|| (candidate.speed() == enough.speed() && candidate.uses() == enough.uses()
					&& candidate.tier() > enough.tier())) {
				enough = candidate;
			}
		}
		return enough != null ? enough : richest;
	}

	static int tier(String item) {
		if (item == null || !item.endsWith("_pickaxe")) return 0;
		if (item.contains("netherite_")) return 5;
		if (item.contains("diamond_")) return 4;
		if (item.contains("iron_")) return 3;
		if (item.contains("stone_")) return 2;
		if (item.contains("wooden_") || item.contains("golden_")) return 1;
		return 0;
	}
}
