package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ArmorSelectionTest {
	@Test
	void recognisesEveryVanillaArmourSlot() {
		assertEquals("helmet", ArmorSelection.slot("minecraft:iron_helmet"));
		assertEquals("helmet", ArmorSelection.slot("minecraft:turtle_helmet"));
		assertEquals("chestplate", ArmorSelection.slot("minecraft:diamond_chestplate"));
		assertEquals("leggings", ArmorSelection.slot("minecraft:chainmail_leggings"));
		assertEquals("boots", ArmorSelection.slot("minecraft:netherite_boots"));
		assertNull(ArmorSelection.slot("minecraft:iron_ingot"));
	}

	@Test
	void equipsAnEmptySlotEvenWithLeather() {
		ArmorSelection.Upgrade upgrade = ArmorSelection.best(
			Map.of(),
			List.of(new ArmorSelection.Candidate(14, "minecraft:leather_chestplate"))
		);
		assertEquals(14, upgrade.sourceInventorySlot());
		assertEquals(ArmorSelection.CHESTPLATE_MENU_SLOT, upgrade.armorMenuSlot());
	}

	@Test
	void prefersIronOverLeatherAndDiamondOverIron() {
		ArmorSelection.Upgrade iron = ArmorSelection.best(
			Map.of("chestplate", "minecraft:leather_chestplate"),
			List.of(
				new ArmorSelection.Candidate(12, "minecraft:golden_chestplate"),
				new ArmorSelection.Candidate(20, "minecraft:iron_chestplate")
			)
		);
		assertEquals("minecraft:iron_chestplate", iron.itemId());

		ArmorSelection.Upgrade diamond = ArmorSelection.best(
			Map.of("chestplate", "minecraft:iron_chestplate"),
			List.of(new ArmorSelection.Candidate(20, "minecraft:diamond_chestplate"))
		);
		assertEquals("minecraft:diamond_chestplate", diamond.itemId());
	}

	@Test
	void neverDowngradesWornArmour() {
		assertNull(
			ArmorSelection.best(
				Map.of(
					"helmet", "minecraft:iron_helmet",
					"chestplate", "minecraft:iron_chestplate",
					"leggings", "minecraft:diamond_leggings",
					"boots", "minecraft:iron_boots"
				),
				List.of(
					new ArmorSelection.Candidate(10, "minecraft:chainmail_helmet"),
					new ArmorSelection.Candidate(11, "minecraft:leather_chestplate"),
					new ArmorSelection.Candidate(12, "minecraft:golden_leggings"),
					new ArmorSelection.Candidate(13, "minecraft:leather_boots")
				)
			)
		);
	}

	@Test
	void mapsPlayerInventoryIndicesToInventoryMenuIndices() {
		assertEquals(36, ArmorSelection.inventoryMenuSlot(0));
		assertEquals(44, ArmorSelection.inventoryMenuSlot(8));
		assertEquals(9, ArmorSelection.inventoryMenuSlot(9));
		assertEquals(35, ArmorSelection.inventoryMenuSlot(35));
		assertEquals(ArmorSelection.BOOTS_MENU_SLOT, ArmorSelection.inventoryMenuSlot(36));
		assertEquals(ArmorSelection.LEGGINGS_MENU_SLOT, ArmorSelection.inventoryMenuSlot(37));
		assertEquals(ArmorSelection.CHESTPLATE_MENU_SLOT, ArmorSelection.inventoryMenuSlot(38));
		assertEquals(ArmorSelection.HELMET_MENU_SLOT, ArmorSelection.inventoryMenuSlot(39));
		assertEquals(45, ArmorSelection.inventoryMenuSlot(40));
	}
}
