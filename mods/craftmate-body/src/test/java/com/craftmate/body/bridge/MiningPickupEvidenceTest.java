package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class MiningPickupEvidenceTest {
	@Test
	void blockBreakAloneIsNotAPickup() {
		Map<String, Integer> before = Map.of("minecraft:oak_log", 0);
		Map<String, Integer> after = Map.of("minecraft:oak_log", 0);
		assertFalse(MiningPickupEvidence.satisfied(before, after, 1));
		assertEquals(Map.of(), MiningPickupEvidence.gains(before, after));
	}

	@Test
	void inventoryIncreaseIsConfirmedPerItem() {
		Map<String, Integer> gained = MiningPickupEvidence.gains(
			Map.of("minecraft:oak_log", 2, "minecraft:apple", 1),
			Map.of("minecraft:oak_log", 3, "minecraft:apple", 1, "minecraft:stick", 1)
		);
		assertEquals(Map.of("minecraft:oak_log", 1, "minecraft:stick", 1), gained);
		assertEquals(2, MiningPickupEvidence.total(gained));
		assertTrue(MiningPickupEvidence.satisfied(
			Map.of("minecraft:oak_log", 2),
			Map.of("minecraft:oak_log", 3),
			1
		));
	}

	@Test
	void delayedOrPartialDropsAreNamedNotPretended() {
		Map<String, Integer> gained = Map.of("minecraft:oak_log", 1);
		assertEquals(
			Set.of("minecraft:apple"),
			MiningPickupEvidence.unconfirmedItems(gained, Set.of("minecraft:oak_log", "minecraft:apple"))
		);
	}

	@Test
	void unrelatedNearbyDropsDoNotConfirmTheTargetBlock() {
		Map<String, Integer> gained = Map.of(
			"minecraft:apple", 1,
			"minecraft:oak_log", 1
		);
		assertEquals(
			Map.of("minecraft:oak_log", 1),
			MiningPickupEvidence.expectedGains(gained, Set.of("minecraft:oak_log"))
		);
	}
}
