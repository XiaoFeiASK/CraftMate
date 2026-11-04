package com.craftmate.body.bridge;

/**
 * Pure slot arithmetic for the semantic inventory report. Vanilla indexes the
 * player inventory as 0–8 hotbar, 9–35 main, 36–39 armor (feet, legs, chest,
 * head) and 40 offhand. The wire keeps that index so evidence can point at
 * the exact slot a stack came from.
 */
final class InventorySnapshot {
	static final int LAST_SLOT = 40;

	private InventorySnapshot() {
	}

	/** Returns the semantic section for a vanilla slot, or null for no slot. */
	static String section(int slot) {
		if (slot >= 0 && slot < 9) return "hotbar";
		if (slot >= 9 && slot < 36) return "main";
		if (slot >= 36 && slot < 40) return "armor";
		if (slot == 40) return "offhand";
		return null;
	}

	/**
	 * Remaining uses, not the damage counter. A nearly broken pickaxe must
	 * read as low durability to a planner, and an undamaged tool as full.
	 */
	static int remainingDurability(int damage, int maxDurability) {
		if (maxDurability <= 0) return 0;
		return Math.max(0, maxDurability - Math.max(0, damage));
	}
}
