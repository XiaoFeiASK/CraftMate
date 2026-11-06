package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class MiningDropsTest {
	@Test
	void mapsBlocksToTheirActualInventoryDrops() {
		assertEquals(
			Set.of("minecraft:cobblestone"),
			MiningDrops.expectedFor("minecraft:stone", "minecraft:stone", false, false)
		);
		assertEquals(
			Set.of("minecraft:raw_iron"),
			MiningDrops.expectedFor("minecraft:iron_ore", "minecraft:iron_ore", false, false)
		);
		assertEquals(
			Set.of("minecraft:oak_log"),
			MiningDrops.expectedFor("minecraft:oak_log", "minecraft:oak_log", true, false)
		);
	}

	@Test
	void leavesAcceptAnyLeafDropButIgnoreAnUnrelatedStack() {
		Set<String> expected = MiningDrops.expectedFor(
			"minecraft:oak_leaves",
			"minecraft:oak_leaves",
			false,
			true
		);
		assertTrue(expected.isEmpty());
		assertTrue(MiningPickupEvidence.pickupOptional(expected));
		assertTrue(MiningPickupEvidence.optionalPickupSettled(expected, 12, 12));
		Map<String, Integer> gains = Map.of("minecraft:apple", 1, "minecraft:oak_log", 2);
		assertEquals(gains, MiningPickupEvidence.expectedGains(gains, expected));
	}

	@Test
	void aGuaranteedDropStillRequiresPickupConfirmation() {
		Set<String> expected = Set.of("minecraft:raw_iron");
		assertTrue(!MiningPickupEvidence.pickupOptional(expected));
		assertTrue(!MiningPickupEvidence.optionalPickupSettled(expected, 200, 12));
	}

	@Test
	void onlyTheRequestedDropConfirmsPickup() {
		Map<String, Integer> gains = Map.of(
			"minecraft:apple",
			1,
			"minecraft:oak_log",
			2,
			"minecraft:stick",
			1
		);
		assertEquals(
			Map.of("minecraft:oak_log", 2),
			MiningPickupEvidence.expectedGains(gains, Set.of("minecraft:oak_log"))
		);
	}
}
