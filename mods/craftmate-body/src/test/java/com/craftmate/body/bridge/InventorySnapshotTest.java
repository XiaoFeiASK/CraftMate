package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

class InventorySnapshotTest {
	@Test
	void vanillaSlotsMapToTheFourSections() {
		assertEquals("hotbar", InventorySnapshot.section(0));
		assertEquals("hotbar", InventorySnapshot.section(8));
		assertEquals("main", InventorySnapshot.section(9));
		assertEquals("main", InventorySnapshot.section(35));
		assertEquals("armor", InventorySnapshot.section(36));
		assertEquals("armor", InventorySnapshot.section(39));
		assertEquals("offhand", InventorySnapshot.section(40));
		assertNull(InventorySnapshot.section(41));
		assertNull(InventorySnapshot.section(-1));
	}

	@Test
	void durabilityIsRemainingUsesNotDamage() {
		assertEquals(250, InventorySnapshot.remainingDurability(0, 250));
		assertEquals(1, InventorySnapshot.remainingDurability(249, 250));
		assertEquals(0, InventorySnapshot.remainingDurability(260, 250));
		assertEquals(0, InventorySnapshot.remainingDurability(0, 0));
	}
}
