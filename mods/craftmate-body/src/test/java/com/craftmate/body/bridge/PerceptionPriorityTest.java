package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class PerceptionPriorityTest {
	@Test
	void progressionBlocksOutrankBulkTerrain() {
		assertTrue(
			GameActions.nearbyPriority("minecraft:crafting_table")
				< GameActions.nearbyPriority("minecraft:stone")
		);
		assertTrue(
			GameActions.nearbyPriority("minecraft:iron_ore")
				< GameActions.nearbyPriority("minecraft:dirt")
		);
		assertEquals(
			GameActions.nearbyPriority("minecraft:oak_log"),
			GameActions.nearbyPriority("minecraft:birch_log")
		);
	}

	@Test
	void everyOreSuffixAndAncientDebrisAreRecognized() {
		assertTrue(GameActions.isOreId("minecraft:iron_ore"));
		assertTrue(GameActions.isOreId("minecraft:deepslate_diamond_ore"));
		assertTrue(GameActions.isOreId("minecraft:nether_gold_ore"));
		assertTrue(GameActions.isOreId("minecraft:ancient_debris"));
		assertFalse(GameActions.isOreId("minecraft:stone"));
	}
}
