package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class WaterSurfaceTest {
	@Test
	void swimsAsSoonAsTheBodyFallsIntoDeepWater() {
		// The eyes are still above the surface for a tick or two after the feet
		// enter the water. The body must already be holding jump.
		assertTrue(WaterSurface.needsJump(true, false, false));
	}

	@Test
	void surfacesEvenWhenStandingOnAFloodedFloor() {
		assertTrue(WaterSurface.needsJump(true, true, true));
	}

	@Test
	void leavesWalkingThroughShallowWaterAlone() {
		assertFalse(WaterSurface.needsJump(true, false, true));
	}

	@Test
	void ignoresDryGround() {
		assertFalse(WaterSurface.needsJump(false, false, false));
	}

	@Test
	void aDescentTaskMaySinkThroughClearWater() {
		assertTrue(WaterSurface.mayDive(true, false, 300, true));
	}

	@Test
	void aDescentTaskMayAlsoSinkWithTheEyesUnderwater() {
		// A flooded stair can be deeper than the surface. Air supply, not the
		// eye height, is what limits the dive.
		assertTrue(WaterSurface.mayDive(true, false, 300, true));
	}

	@Test
	void surfacesForAirWhenTheReserveIsLow() {
		assertFalse(WaterSurface.mayDive(true, false, 80, true));
	}

	@Test
	void ordinaryTasksDoNotDive() {
		assertFalse(WaterSurface.mayDive(true, false, 300, false));
		assertFalse(WaterSurface.mayDive(false, false, 300, true));
	}
}
