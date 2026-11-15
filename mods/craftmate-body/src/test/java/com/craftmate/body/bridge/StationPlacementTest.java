package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class StationPlacementTest {
	@Test
	void refusesCampStationsWellBelowTheSurface() {
		assertTrue(StationPlacement.blockedUnderground("minecraft:chest", 20, 64));
		assertTrue(StationPlacement.blockedUnderground("minecraft:barrel", 20, 64));
	}

	@Test
	void allowsAFieldFurnaceAtTheOreFace() {
		assertFalse(StationPlacement.blockedUnderground("minecraft:furnace", 20, 64));
		assertFalse(StationPlacement.blockedUnderground("minecraft:blast_furnace", 20, 64));
	}

	@Test
	void allowsAPortableWorkbenchAtTheOreFace() {
		// A carried table is how a player crafts a furnace or pickaxe beside
		// the ore. Placement keeps it out of the home anchor instead.
		assertFalse(StationPlacement.blockedUnderground("minecraft:crafting_table", 20, 64));
	}

	@Test
	void allowsAMineEntranceAndOrdinaryBuildingBlocks() {
		assertFalse(StationPlacement.blockedUnderground("minecraft:crafting_table", 58, 64));
		assertFalse(StationPlacement.blockedUnderground("minecraft:furnace", 60, 64));
		assertFalse(StationPlacement.blockedUnderground("minecraft:cobblestone", 10, 64));
	}
}
