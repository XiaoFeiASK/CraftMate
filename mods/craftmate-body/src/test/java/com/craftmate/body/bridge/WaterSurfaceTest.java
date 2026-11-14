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
}
