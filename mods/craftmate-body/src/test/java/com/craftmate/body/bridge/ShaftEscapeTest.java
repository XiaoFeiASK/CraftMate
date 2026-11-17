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
	void aDeadEndWithOneWallStillOpensWithATool() {
		// A dead-end tunnel has one wall, not four. Once A* has no route,
		// opening that wall is the next legal move instead of E_ENCLOSED.
		assertTrue(ShaftEscape.shouldDigOut(1, true));
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
	void aBodyBelowItsEntranceOnTheStairLineIsNotRelocated() {
		// Entrance at 149,75,-69 heading north (dz=-1); four steps down and
		// north, the body stands at 149,71,-73. The old height guard saw the
		// entrance four blocks above the body and rebuilt it every cycle.
		assertTrue(
			ShaftEscape.insideOwnStair(149, 71, -73, 149, 75, -69, 0, -1)
		);
		assertTrue(
			ShaftEscape.insideOwnStair(149, 71, -74, 149, 75, -69, 0, -1),
			"one block of stair drift is still the body's own shaft"
		);
		assertFalse(
			ShaftEscape.insideOwnStair(159, 71, -73, 149, 75, -69, 0, -1),
			"a body ten blocks east is on different ground"
		);
		assertFalse(
			ShaftEscape.insideOwnStair(149, 76, -69, 149, 75, -69, 0, -1),
			"a body above the entrance is the roof case the guard targets"
		);
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
	void theStartCellIsNotTheGoalWhenTheTargetIsOneLevelUp() {
		assertFalse(ShaftEscape.startCellReachesGoal(49, 50));
		assertTrue(ShaftEscape.startCellReachesGoal(50, 50));
		assertFalse(ShaftEscape.startCellReachesGoal(51, 50));
	}

	@Test
	void aRouteThatDescendsIsNotProgressTowardAChestTwoBlocksAbove() {
		assertFalse(ShaftEscape.routeAdvancesTowardTarget(false, 73.0, 75.0, 77.0));
		assertFalse(ShaftEscape.routeAdvancesTowardTarget(false, 75.0, 75.0, 77.0));
		assertTrue(ShaftEscape.routeAdvancesTowardTarget(false, 76.0, 75.0, 77.0));
	}

	@Test
	void onlyTheCampLevelMayChooseANewMineEntrance() {
		assertTrue(ShaftEscape.nearHomeLevel(75, 77));
		assertTrue(ShaftEscape.nearHomeLevel(66, 77));
		assertFalse(ShaftEscape.nearHomeLevel(59, 77));
		assertFalse(ShaftEscape.nearHomeLevel(55, 77));
		// The camp's own terraces may sit up to four blocks below the home
		// anchor; that is not a roof entrance and must keep the mine.
		assertTrue(ShaftEscape.atHomeWalkingLevel(73, 77));
		assertTrue(ShaftEscape.atHomeWalkingLevel(81, 77));
		assertFalse(ShaftEscape.atHomeWalkingLevel(70, 77));
		assertFalse(ShaftEscape.atHomeWalkingLevel(84, 77));
	}

	@Test
	void aRememberedEntranceMustStayInsideTheCampSite() {
		assertTrue(ShaftEscape.entranceWithinHomeSite(131, 74, -58, 135, 77, -61, 10));
		assertFalse(ShaftEscape.entranceWithinHomeSite(147, 61, -56, 135, 77, -61, 10));
		assertFalse(ShaftEscape.entranceWithinHomeSite(135, 66, -61, 135, 77, -61, 10));
		// The square search window used to reach this corner; persistence
		// rejected it as 13.5 blocks from home and the site search repeated
		// the same rejected entrance forever.
		assertFalse(ShaftEscape.entranceWithinHomeSite(148, 75, -70, 138, 79, -61, 10));
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
	void explicitTargetClimbAllowsAnOpenPitButOpportunisticPillarDoesNot() {
		assertTrue(ShaftEscape.shouldStartTargetClimb(true, false, 0));
		assertTrue(ShaftEscape.shouldStartTargetClimb(false, true, 0));
		assertTrue(ShaftEscape.shouldStartTargetClimb(false, false, 4));
		assertFalse(ShaftEscape.shouldStartTargetClimb(false, false, 3));
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
	void aLowerMineEntranceIsNotMistakenForARoofEntrance() {
		assertFalse(ShaftEscape.entranceAboveWalkingLevel(74, 77));
		assertFalse(ShaftEscape.entranceAboveWalkingLevel(77, 77));
		assertFalse(ShaftEscape.entranceAboveWalkingLevel(79, 77));
		assertTrue(ShaftEscape.entranceAboveWalkingLevel(80, 77));
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
	void aStairCornerRecentersOntoItsRealSupportBeforePillaring() {
		assertTrue(ShaftEscape.shouldRecenterBeforePillar(false, true));
		assertFalse(ShaftEscape.shouldRecenterBeforePillar(true, true));
		assertFalse(ShaftEscape.shouldRecenterBeforePillar(false, false));
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

	@Test
	void anAlreadyDugEntranceSurvivesTheCandidateProbe() {
		assertTrue(ShaftEscape.keepRememberedEntrance("descent_blocked"));
		assertFalse(ShaftEscape.keepRememberedEntrance("buried"));
		assertFalse(ShaftEscape.keepRememberedEntrance(null));
	}

	@Test
	void aWalledShaftCanOnlyDescendOntoASolidFloor() {
		assertTrue(ShaftEscape.canDescendShaft(4, true, true, true));
		assertTrue(ShaftEscape.canDescendShaft(3, true, true, true));
		assertFalse(ShaftEscape.canDescendShaft(2, true, true, true));
		assertFalse(ShaftEscape.canDescendShaft(4, false, true, true));
		assertFalse(ShaftEscape.canDescendShaft(4, true, false, true));
		assertFalse(ShaftEscape.canDescendShaft(4, true, true, false));
	}

	@Test
	void passableDecorationInThePillarCellIsCleared() {
		// A wall torch in the vacated feet cell is passable but not
		// replaceable; jump-place would fail silently forever.
		assertTrue(
			ShaftEscape.shouldClearPillarCell(false, false, false, false, 0.0f)
		);
	}

	@Test
	void valuableOrClimbablePillarCellOccupantsAreKept() {
		assertFalse(
			ShaftEscape.shouldClearPillarCell(true, false, false, false, 0.0f)
		);
		assertFalse(
			ShaftEscape.shouldClearPillarCell(false, true, false, false, 0.5f)
		);
		assertFalse(
			ShaftEscape.shouldClearPillarCell(false, false, true, false, 0.5f)
		);
		assertFalse(
			ShaftEscape.shouldClearPillarCell(false, false, false, true, 0.4f)
		);
		assertFalse(
			ShaftEscape.shouldClearPillarCell(false, false, false, false, -1.0f)
		);
		assertFalse(
			ShaftEscape.shouldClearPillarCell(false, false, false, false, 1.5f)
		);
	}
}
