package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class MineStairTest {
	@Test
	void aSolidBodyCellIsClearedBeforeTheHeadOrLanding() {
		assertEquals(
			MineStair.BODY,
			MineStair.nextTarget(true, true, true)
		);
		assertEquals(
			MineStair.HEAD,
			MineStair.nextTarget(false, true, true)
		);
		assertEquals(
			MineStair.LANDING,
			MineStair.nextTarget(false, false, true)
		);
	}

	@Test
	void anOpenStepAdvancesInsteadOfReturningNoPlan() {
		// This is the regression: all three cells air used to produce a null
		// blueprint, so the body cleared the same column and then relocated
		// the mine entrance instead of descending.
		assertEquals(
			MineStair.ADVANCE,
			MineStair.nextTarget(false, false, false)
		);
	}

	@Test
	void aBlockedHeadingTriesPerpendicularBranchesBeforeTurningBack() {
		assertArrayEquals(
			new int[][] { { 1, 0 }, { -1, 0 }, { 0, 1 } },
			MineStair.fallbackHeadings(0, -1)
		);
	}

	@Test
	void decorationsDoNotBecomeStairObstacles() {
		assertTrue(MineStair.blocksStep(false, true, false), "solid stone blocks the step");
		assertFalse(MineStair.blocksStep(true, false, false), "air does not block the step");
		assertFalse(
			MineStair.blocksStep(false, false, false),
			"a wall torch is non-air but must remain pass-through"
		);
		assertFalse(
			MineStair.blocksStep(false, true, true),
			"a fluid is handled by the mine safety checks, not the solid-step test"
		);
	}

	@Test
	void aDeepOpenEndedStairWithNoBranchIsAbandonable() {
		assertTrue(MineStair.abandonableDeadEnd(false, 17, false));
		assertFalse(
			MineStair.abandonableDeadEnd(true, 17, false),
			"a pending cell means the stair can still advance"
		);
		assertFalse(
			MineStair.abandonableDeadEnd(false, 17, true),
			"a branch is a productive way forward"
		);
		assertFalse(
			MineStair.abandonableDeadEnd(false, 3, false),
			"a shallow stair is still being started"
		);
	}
}
