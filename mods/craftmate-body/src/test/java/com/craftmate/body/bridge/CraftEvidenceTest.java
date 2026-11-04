package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import org.junit.jupiter.api.Test;

class CraftEvidenceTest {
	@Test
	void aPartialInventoryGainCanBeReported() {
		Map<String, Integer> before = Map.of("minecraft:stick", 1);
		Map<String, Integer> after = Map.of("minecraft:stick", 3);
		assertEquals(2, CraftEvidence.gained(before, after, "minecraft:stick"));
	}

	@Test
	void inventoryRoomAccountsForExistingMatchingStacks() {
		assertTrue(CraftEvidence.inventoryHasRoom(0, 1, 1, 64));
		assertFalse(CraftEvidence.inventoryHasRoom(0, 0, 1, 64), "a full stack is not room for another item");
		assertTrue(CraftEvidence.inventoryHasRoom(1, 0, 64, 64));
		assertFalse(CraftEvidence.inventoryHasRoom(1, 0, 65, 64));
		assertTrue(CraftEvidence.inventoryHasRoom(1, 0, 1, 1));
		assertFalse(CraftEvidence.inventoryHasRoom(0, 0, 1, 1), "a non-stackable item needs an empty slot");
	}

	@Test
	void aVisibleResultThatReachesTheInventoryConfirmsTheTransfer() {
		assertTrue(
			CraftEvidence.transferConfirmed(
				4,
				Map.of("minecraft:stick", 0),
				Map.of("minecraft:stick", 4),
				"minecraft:stick",
				4
			)
		);
	}

	@Test
	void aResultSlotThatWasEmptyCannotConfirmATransfer() {
		assertFalse(
			CraftEvidence.transferConfirmed(
				0,
				Map.of("minecraft:stick", 0),
				Map.of("minecraft:stick", 4),
				"minecraft:stick",
				4
			)
		);
	}

	@Test
	void anInventoryGainSmallerThanTheVisibleBatchIsNotAConfirmedTransfer() {
		assertFalse(
			CraftEvidence.transferConfirmed(
				4,
				Map.of("minecraft:stick", 0),
				Map.of("minecraft:stick", 2),
				"minecraft:stick",
				4
			)
		);
	}

	@Test
	void theSameBatchIsNotCountedTwice() {
		Map<String, Integer> takeBaseline = Map.of("minecraft:stick", 4);
		assertEquals(
			0,
			CraftEvidence.gained(takeBaseline, Map.of("minecraft:stick", 4), "minecraft:stick")
		);
		assertFalse(
			CraftEvidence.transferConfirmed(
				2,
				takeBaseline,
				Map.of("minecraft:stick", 4),
				"minecraft:stick",
				2
			)
		);
	}
}
