package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class CanopyEscapeTest {
	@Test
	void recognizesATreeLogSurroundedByLeavesAsACanopyTrap() {
		assertTrue(CanopyEscape.standingInTreeCanopy(true, false, true, 2));
		assertTrue(CanopyEscape.standingInTreeCanopy(true, false, true, 8));
		assertTrue(CanopyEscape.standingInTreeCanopy(true, false, true, 1));
		assertTrue(CanopyEscape.standingInTreeCanopy(true, true, false, 0));
		assertFalse(CanopyEscape.standingInTreeCanopy(false, false, true, 8));
		assertFalse(CanopyEscape.standingInTreeCanopy(true, false, false, 8));
	}

	@Test
	void recognizesA_bodyClippedInsideAFloatingTrunk() {
		assertTrue(CanopyEscape.trappedInsideTree(true, true));
		assertFalse(CanopyEscape.trappedInsideTree(false, true));
		assertFalse(CanopyEscape.trappedInsideTree(true, false));
	}

	@Test
	void recognizesAPlacedPlatformInsideTheLeafCrown() {
		assertTrue(CanopyEscape.standingOnRaisedCanopyPlatform(true, true, 4, false));
		assertFalse(CanopyEscape.standingOnRaisedCanopyPlatform(true, false, 4, false));
		assertFalse(CanopyEscape.standingOnRaisedCanopyPlatform(true, true, 1, false));
		assertFalse(CanopyEscape.standingOnRaisedCanopyPlatform(true, true, 4, true));
		assertFalse(CanopyEscape.standingOnRaisedCanopyPlatform(false, true, 4, false));
	}

	@Test
	void onlyStartsOnAGroundedLeafFloor() {
		assertTrue(CanopyEscape.standingOnLeaves(true, true));
		assertFalse(CanopyEscape.standingOnLeaves(false, true));
		assertFalse(CanopyEscape.standingOnLeaves(true, false));
	}

	@Test
	void peelsWhileAnotherCanopyLayerIsBelow() {
		assertTrue(CanopyEscape.canPeel(true, 1, true));
	}

	@Test
	void takesOnlyAShortSafeDropOffTheCanopy() {
		assertTrue(CanopyEscape.canLeaveCanopy(3, true));
		assertTrue(CanopyEscape.canPeel(false, 2, true));
		assertFalse(CanopyEscape.canLeaveCanopy(4, true));
		assertFalse(CanopyEscape.canLeaveCanopy(2, false));
	}

	@Test
	void walksAcrossTheCanopyWhenTheLastDropWouldHurt() {
		assertTrue(CanopyEscape.shouldWalkToLanding(true, 6));
		assertFalse(CanopyEscape.shouldWalkToLanding(true, 3));
		assertFalse(CanopyEscape.shouldWalkToLanding(false, 6));
	}

	@Test
	void boundsCanopyRecoveryEvenWhileItReportsProgress() {
		assertFalse(CanopyEscape.timedOut(-1, 1_000));
		assertFalse(CanopyEscape.timedOut(10, 10 + CanopyEscape.ESCAPE_BUDGET_TICKS - 1));
		assertTrue(CanopyEscape.timedOut(10, 10 + CanopyEscape.ESCAPE_BUDGET_TICKS));
	}
}
