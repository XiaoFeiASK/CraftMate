package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class InteractionReachTest {
	@Test
	void aDiagonalStandIsWithinVanillaReach() {
		// Player feet at (-4.5, 120, 10.5), target log centre at (-4.5, 120.5, 9.5).
		double distance = InteractionReach.eyeDistance(
			-4.5,
			120.0,
			10.5,
			1.62,
			-4.5,
			120.5,
			9.5
		);
		assertTrue(distance < 4.5, "distance was " + distance);
	}

	@Test
	void aDistantSurfaceIsOutsideReach() {
		assertFalse(
			InteractionReach.withinReach(
				0.5,
				120.0,
				0.5,
				1.62,
				10.5,
				120.5,
				0.5,
				4.5
			)
		);
	}

	@Test
	void eyeHeightMattersForAHighFace() {
		double feet = InteractionReach.eyeDistance(0.5, 120.0, 0.5, 0.0, 0.5, 125.0, 0.5);
		double eye = InteractionReach.eyeDistance(0.5, 120.0, 0.5, 1.62, 0.5, 125.0, 0.5);
		assertTrue(eye < feet);
	}
}
