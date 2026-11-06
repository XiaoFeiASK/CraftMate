package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class PerceptionSamplingTest {
	@Test
	void theDenseRadiusKeepsEveryColumn() {
		assertTrue(GameActions.sampleColumn(3, 4, 24 * 24, 24 * 24, 64 * 64, 5));
	}

	@Test
	void theMiddleRingUsesAQuarterGrid() {
		assertTrue(GameActions.sampleColumn(40, 42, 40 * 40 + 42 * 42, 24 * 24, 64 * 64, 0));
		assertFalse(GameActions.sampleColumn(41, 42, 41 * 41 + 42 * 42, 24 * 24, 64 * 64, 0));
	}

	@Test
	void adjacentScansRotateTheCoarseGrid() {
		assertFalse(GameActions.sampleColumn(65, 65, 65 * 65 + 65 * 65, 24 * 24, 64 * 64, 0));
		assertTrue(GameActions.sampleColumn(65, 65, 65 * 65 + 65 * 65, 24 * 24, 64 * 64, 1));
	}
}
