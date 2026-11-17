package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class OrePerceptionTest {
	@Test
	void deepslateIronOreBelongsToTheStoneIronOreFamily() {
		assertTrue(OrePerception.matches("minecraft:iron_ore", "minecraft:deepslate_iron_ore"));
		assertTrue(OrePerception.matches("minecraft:deepslate_iron_ore", "minecraft:iron_ore"));
		assertTrue(OrePerception.matches("minecraft:gold_ore", "minecraft:deepslate_gold_ore"));
	}

	@Test
	void differentOreFamiliesAndNonOresDoNotMatch() {
		assertFalse(OrePerception.matches("minecraft:iron_ore", "minecraft:deepslate_gold_ore"));
		assertFalse(OrePerception.matches("minecraft:iron_ore", "minecraft:stone"));
		assertFalse(OrePerception.matches("minecraft:ancient_debris", "minecraft:iron_ore"));
	}

	@Test
	void requestedStateIsNotWeakerThanTheObservationActuallyProves() {
		assertTrue(OrePerception.satisfies(false, false, "observed"));
		assertFalse(OrePerception.satisfies(false, false, "visible"));
		assertTrue(OrePerception.satisfies(true, false, "visible"));
		assertFalse(OrePerception.satisfies(true, false, "reachable"));
		assertTrue(OrePerception.satisfies(true, true, "reachable"));
		assertFalse(OrePerception.satisfies(true, true, "unknown"));
	}

	@Test
	void statusNamesTheFirstBrokenObservationLink() {
		assertEquals(OrePerception.NOT_OBSERVED, OrePerception.status(0, 0, 0, 0));
		assertEquals(
			OrePerception.OBSERVED_NOT_PLANNED,
			OrePerception.status(3, 0, 0, 0)
		);
		assertEquals(
			OrePerception.OBSERVED_NOT_PLANNED,
			OrePerception.status(3, 2, 0, 0)
		);
		assertEquals(
			OrePerception.OBSERVED_NOT_PLANNED,
			OrePerception.status(3, 2, 1, 0)
		);
		assertEquals(OrePerception.CANDIDATE_READY, OrePerception.status(3, 2, 1, 1));
		for (
			int visible = 0;
			visible <= 2;
			visible++
		) {
			assertEquals(
				OrePerception.CANDIDATE_READY,
				OrePerception.status(3, 2, visible, 1)
			);
		}
	}

	@Test
	void anOreInsideCurrentReachIsReachableWithoutASeparateStandingCell() {
		assertTrue(GameActions.oreReachable(true, true, 1.0, true, false));
		assertTrue(GameActions.oreReachable(true, false, 1.0, true, false));
		assertFalse(GameActions.oreReachable(true, true, 1.0, false, false));
		assertTrue(GameActions.oreReachable(true, true, 1.0, false, true));
		assertTrue(GameActions.oreReachable(true, true, 12.0, false, false));
		assertFalse(GameActions.oreReachable(false, true, 1.0, true, true));
	}
}
