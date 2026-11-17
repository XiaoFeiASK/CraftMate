package com.craftmate.body.bridge;

import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Armour slot and upgrade rules. The body crafts a full set long before the
 * planner stops asking for gear, so equipping has to be automatic and must
 * never replace a better piece with a worse one.
 */
public final class ArmorSelection {
	public static final int HELMET_MENU_SLOT = 5;
	public static final int CHESTPLATE_MENU_SLOT = 6;
	public static final int LEGGINGS_MENU_SLOT = 7;
	public static final int BOOTS_MENU_SLOT = 8;

	private ArmorSelection() {
	}

	public record Candidate(int inventorySlot, String itemId) {
	}

	public record Upgrade(
		int sourceInventorySlot,
		int armorMenuSlot,
		String itemId,
		String currentItemId
	) {
	}

	/** Returns helmet/chestplate/leggings/boots, or null for a non-armour item. */
	public static String slot(String itemId) {
		String path = path(itemId);
		if (path.endsWith("_helmet") || path.equals("turtle_helmet")) return "helmet";
		if (path.endsWith("_chestplate")) return "chestplate";
		if (path.endsWith("_leggings")) return "leggings";
		if (path.endsWith("_boots")) return "boots";
		return null;
	}

	/**
	 * Vanilla protection order. Turtle shells sit with gold and chain helmets;
	 * the exact number is irrelevant because every comparison is within one
	 * equipment slot.
	 */
	public static int tier(String itemId) {
		String path = path(itemId);
		if (path.startsWith("netherite_")) return 6;
		if (path.startsWith("diamond_")) return 5;
		if (path.startsWith("iron_")) return 4;
		if (path.startsWith("chainmail_")) return 3;
		if (path.startsWith("golden_") || path.equals("turtle_helmet")) return 2;
		if (path.startsWith("leather_")) return 1;
		return 0;
	}

	public static int armorMenuSlot(String slot) {
		return switch (slot) {
			case "helmet" -> HELMET_MENU_SLOT;
			case "chestplate" -> CHESTPLATE_MENU_SLOT;
			case "leggings" -> LEGGINGS_MENU_SLOT;
			case "boots" -> BOOTS_MENU_SLOT;
			default -> -1;
		};
	}

	/**
	 * Player inventory indices and `InventoryMenu` slot indices differ in the
	 * hotbar and armour sections. Clicking the inventory index directly put
	 * the cursor on a crafting or armour slot instead.
	 */
	public static int inventoryMenuSlot(int inventorySlot) {
		if (inventorySlot >= 0 && inventorySlot <= 8) return 36 + inventorySlot;
		if (inventorySlot >= 9 && inventorySlot <= 35) return inventorySlot;
		return switch (inventorySlot) {
			case 39 -> HELMET_MENU_SLOT;
			case 38 -> CHESTPLATE_MENU_SLOT;
			case 37 -> LEGGINGS_MENU_SLOT;
			case 36 -> BOOTS_MENU_SLOT;
			case 40 -> 45;
			default -> -1;
		};
	}

	/**
	 * Chooses the largest strictly-better piece available. `equipped` is keyed
	 * by {@link #slot(String)}; missing or empty means the armour slot is free.
	 */
	public static Upgrade best(
		Map<String, String> equipped,
		List<Candidate> candidates
	) {
		Upgrade best = null;
		int bestTier = 0;
		for (Candidate candidate : candidates) {
			String slot = slot(candidate.itemId());
			if (slot == null) continue;
			int tier = tier(candidate.itemId());
			if (tier <= 0 || tier <= bestTier) continue;
			String current = equipped.get(slot);
			if (tier <= tier(current)) continue;
			int menuSlot = armorMenuSlot(slot);
			if (menuSlot < 0) continue;
			best = new Upgrade(
				candidate.inventorySlot(),
				menuSlot,
				candidate.itemId(),
				current
			);
			bestTier = tier;
		}
		return best;
	}

	private static String path(String itemId) {
		if (itemId == null) return "";
		int separator = itemId.indexOf(':');
		return (separator >= 0 ? itemId.substring(separator + 1) : itemId)
			.toLowerCase(Locale.ROOT);
	}
}
