package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ShaftEscapeTest {
	@Test
	void aThreeWalledShaftWithAToolIsEscapable() {
		assertTrue(ShaftEscape.shouldDigOut(3, true));
	}

	@Test
	void openTerrainIsNotAShaft() {
		assertFalse(ShaftEscape.shouldDigOut(1, true));
	}

	@Test
	void noToolMeansNoWallBreaking() {
		assertFalse(ShaftEscape.shouldDigOut(4, false));
	}

	@Test
	void aVisibleSolidFaceIsMineable() {
		assertTrue(ShaftEscape.canBreakWall(true, true));
		assertFalse(ShaftEscape.canBreakWall(false, true));
		assertFalse(ShaftEscape.canBreakWall(true, false));
	}

	@Test
	void aToolOutsideTheHotbarMustBeEquippedBeforeMining() {
		assertTrue(ShaftEscape.needsToolEquip(true, false));
		assertFalse(ShaftEscape.needsToolEquip(true, true));
		assertFalse(ShaftEscape.needsToolEquip(false, false));
	}

	@Test
	void sameLevelTargetsUseATunnelAndDeepTargetsDoNot() {
		assertTrue(ShaftEscape.shouldTunnel(true, 0.0, 12.0));
		assertTrue(ShaftEscape.shouldTunnel(true, -2.0, 12.0));
		assertFalse(ShaftEscape.shouldTunnel(true, -8.0, 12.0));
		assertFalse(ShaftEscape.shouldTunnel(false, 0.0, 12.0));
		assertFalse(ShaftEscape.shouldTunnel(true, 4.0, 12.0));
		assertFalse(ShaftEscape.shouldTunnel(true, 0.0, 2.0));
	}

	@Test
	void aRouteThatStaysOnTheCaveFloorDoesNotAbortAnUpwardEscape() {
		assertFalse(ShaftEscape.routeAdvancesTowardTarget(false, 44.0, 44.0, 85.0));
		assertFalse(ShaftEscape.routeAdvancesTowardTarget(false, 43.0, 47.0, 85.0));
		assertTrue(ShaftEscape.routeAdvancesTowardTarget(false, 48.0, 47.0, 85.0));
	}

	@Test
	void horizontalTargetsAndCompletedRoutesStayUsable() {
		assertTrue(ShaftEscape.routeAdvancesTowardTarget(false, 44.0, 44.0, 45.0));
		assertTrue(ShaftEscape.routeAdvancesTowardTarget(true, 40.0, 44.0, 85.0));
	}

	@Test
	void exactTargetsDoNotAcceptAWholeBlockBelowTheFloor() {
		assertTrue(ShaftEscape.arrivalHeight(false) < 1.0);
		assertTrue(ShaftEscape.arrivalHeight(true) > ShaftEscape.arrivalHeight(false));
	}

	@Test
	void openSkyAtACliffIsNotAPillarSite() {
		assertFalse(ShaftEscape.shouldStartPillar(false, 0));
		assertFalse(ShaftEscape.shouldStartPillar(false, 2));
		assertFalse(ShaftEscape.shouldStartPillar(false, 3));
	}

	@Test
	void aCeilingOrFourWallsMakePillaringLegitimate() {
		assertTrue(ShaftEscape.shouldStartPillar(true, 0));
		assertTrue(ShaftEscape.shouldStartPillar(false, 4));
	}

	@Test
	void canopyAndLogsAreNotStructuralBarriers() {
		assertTrue(ShaftEscape.isStructuralBarrier(true, false, false));
		assertFalse(ShaftEscape.isStructuralBarrier(true, true, false));
		assertFalse(ShaftEscape.isStructuralBarrier(true, false, true));
		assertFalse(ShaftEscape.isStructuralBarrier(false, false, false));
	}

	@Test
	void recoveryPillarsHaveATwelveBlockBudget() {
		assertTrue(ShaftEscape.withinRecoveryPillarBudget(0));
		assertTrue(ShaftEscape.withinRecoveryPillarBudget(11));
		assertFalse(ShaftEscape.withinRecoveryPillarBudget(12));
		assertFalse(ShaftEscape.withinRecoveryPillarBudget(-1));
	}

	@Test
	void theSameLedgeIsAttemptedOnlyOnceInsideItsWindow() {
		assertFalse(ShaftEscape.ledgeAttemptExhausted(0, 20));
		assertTrue(ShaftEscape.ledgeAttemptExhausted(1, 20));
		assertFalse(
			ShaftEscape.ledgeAttemptExhausted(
				1,
				ShaftEscape.LEDGE_REPEAT_WINDOW_TICKS + 1
			)
		);
		assertFalse(ShaftEscape.ledgeAttemptExhausted(1, -1));
	}

	@Test
	void aTunnelDirectionGetsTwoConsecutiveAttempts() {
		assertFalse(ShaftEscape.tunnelDirectionExhausted(0));
		assertFalse(ShaftEscape.tunnelDirectionExhausted(1));
		assertTrue(ShaftEscape.tunnelDirectionExhausted(2));
		assertTrue(
			ShaftEscape.tunnelDirectionExhausted(
				ShaftEscape.MAX_TUNNEL_DIRECTION_FAILURES
			)
		);
	}

	@Test
	void aPillarNeedsSkyOrAWayToBreakItsOwnSupport() {
		assertTrue(ShaftEscape.canRecoverFromPillar(true, false));
		assertTrue(ShaftEscape.canRecoverFromPillar(false, true));
		assertFalse(ShaftEscape.canRecoverFromPillar(false, false));
	}

	@Test
	void aPillarRebasesWhenTheBodyDropsToALowerFloor() {
		assertTrue(ShaftEscape.shouldRebasePillar(true, 75, 77));
		assertFalse(ShaftEscape.shouldRebasePillar(true, 77, 77));
		assertFalse(ShaftEscape.shouldRebasePillar(true, 78, 77));
		assertFalse(ShaftEscape.shouldRebasePillar(false, 75, 77));
	}

	@Test
	void aPillarStopsOnceItReachesTheRequestedFloor() {
		assertTrue(ShaftEscape.pillarReachedTarget(100, 99, 100.0));
		assertTrue(ShaftEscape.pillarReachedTarget(101, 100, 100.0));
		assertFalse(ShaftEscape.pillarReachedTarget(100, 99, 104.0));
		assertFalse(ShaftEscape.pillarReachedTarget(100, 100, 100.0));
	}

	@Test
	void aThickCeilingIsOpenedFromTheExposedBottomCellFirst() {
		assertEquals(2, ShaftEscape.firstCeilingOffset(true, true));
		assertEquals(2, ShaftEscape.firstCeilingOffset(true, false));
		assertEquals(3, ShaftEscape.firstCeilingOffset(false, true));
		assertEquals(-1, ShaftEscape.firstCeilingOffset(false, false));
	}

	@Test
	void retreatContinuesDownTheBodysOwnPillarColumn() {
		assertTrue(ShaftEscape.continuesPillarRetreat(true, true, 108, 107, true));
		assertFalse(ShaftEscape.continuesPillarRetreat(false, true, 108, 107, true));
		assertFalse(ShaftEscape.continuesPillarRetreat(true, false, 108, 107, true));
		assertFalse(ShaftEscape.continuesPillarRetreat(true, true, 108, 106, true));
		assertFalse(ShaftEscape.continuesPillarRetreat(true, true, 108, 107, false));
	}
}
