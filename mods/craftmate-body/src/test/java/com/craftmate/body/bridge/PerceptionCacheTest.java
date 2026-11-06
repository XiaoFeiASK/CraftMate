package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class PerceptionCacheTest {
	@Test
	void aNullOriginIsNeverAValidCacheHit() {
		assertFalse(GameActions.cacheFresh(12_000, Integer.MIN_VALUE, 30, -1, 64));
	}

	@Test
	void aRecentScanAtTheSameCellIsFresh() {
		assertTrue(GameActions.cacheFresh(12_000, 11_985, 30, 9, 64));
	}

	@Test
	void movingPastTheRescanRadiusInvalidatesTheCache() {
		assertFalse(GameActions.cacheFresh(12_000, 11_985, 30, 81, 64));
	}

	@Test
	void aClockThatMovesBackwardsInvalidatesTheCache() {
		assertFalse(GameActions.cacheFresh(100, 200, 30, 0, 64));
	}
}
