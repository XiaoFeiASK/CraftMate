package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class StairEscapeTest {
	@Test
	void clearsAnOrdinaryVisibleBlocker() {
		assertTrue(StairEscape.canClearSightBlocker(true, false, 1.5f, false, false));
		assertTrue(StairEscape.canClearSightBlocker(true, false, 50.0f, true, true));
	}

	@Test
	void refusesUnbreakableFluidOrUnmineableBlockers() {
		assertFalse(StairEscape.canClearSightBlocker(false, false, 1.0f, false, false));
		assertFalse(StairEscape.canClearSightBlocker(true, true, 1.0f, false, false));
		assertFalse(StairEscape.canClearSightBlocker(true, false, -1.0f, false, false));
		assertFalse(StairEscape.canClearSightBlocker(true, false, 50.0f, true, false));
	}

	@Test
	void keepsWorkingUntilTheBlockerIsActuallyGone() {
		assertTrue(StairEscape.obstructionNeedsWork(false));
		assertFalse(StairEscape.obstructionNeedsWork(true));
	}
}
