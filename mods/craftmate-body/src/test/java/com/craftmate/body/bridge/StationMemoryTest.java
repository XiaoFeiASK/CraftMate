package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class StationMemoryTest {
	@Test
	void keepsAStationWhileItsChunkIsUnloaded() {
		assertFalse(StationMemory.shouldForget(false, false));
		assertFalse(StationMemory.shouldForget(false, true));
	}

	@Test
	void forgetsAStationOnlyAfterObservingItsChunkWithoutIt() {
		assertTrue(StationMemory.shouldForget(true, false));
		assertFalse(StationMemory.shouldForget(true, true));
	}

	@Test
	void aDistantStationSurvivesAWorldJoinLoadingRace() {
		assertFalse(StationMemory.shouldForgetNearby(35.0 * 35.0, true, false));
		assertTrue(StationMemory.shouldForgetNearby(2.0 * 2.0, true, false));
		assertFalse(StationMemory.shouldForgetNearby(2.0 * 2.0, true, true));
	}
}
