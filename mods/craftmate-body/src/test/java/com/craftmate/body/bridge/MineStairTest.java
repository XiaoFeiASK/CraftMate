package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;

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
}
