package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class DampedSpringTest {
	@Test
	void criticallyDampedApproachDoesNotOvershoot() {
		DampedSpring spring = new DampedSpring();
		spring.snap(0.0);
		double maximum = 0.0;
		for (int i = 0; i < 120; i++) {
			spring.step(10.0, 1.0 / 60.0, 8.0, 100.0);
			maximum = Math.max(maximum, spring.position());
		}
		assertTrue(maximum <= 10.0 + 1.0e-6);
		assertEquals(10.0, spring.position(), 1.0e-3);
		assertEquals(0.0, spring.velocity(), 1.0e-3);
	}

	@Test
	void frameRateDoesNotChangeTheSettledPosition() {
		DampedSpring atSixty = new DampedSpring();
		DampedSpring atOneTwenty = new DampedSpring();
		atSixty.snap(0.0);
		atOneTwenty.snap(0.0);
		for (int i = 0; i < 60; i++) atSixty.step(10.0, 1.0 / 60.0, 6.0, 100.0);
		for (int i = 0; i < 120; i++) atOneTwenty.step(10.0, 1.0 / 120.0, 6.0, 100.0);
		assertEquals(atSixty.position(), atOneTwenty.position(), 1.0e-6);
	}

	@Test
	void angleSpringTakesTheShortWayAroundTheCompass() {
		DampedSpring spring = new DampedSpring();
		spring.snapAngle(170.0);
		for (int i = 0; i < 120; i++) {
			spring.stepAngle(-170.0, 1.0 / 60.0, 6.0, 90.0);
		}
		assertEquals(-170.0, DampedSpring.wrapDegrees(spring.position()), 0.1);
	}

	@Test
	void speedCeilingBoundsAStallRecovery() {
		DampedSpring spring = new DampedSpring();
		spring.snap(0.0);
		spring.step(100.0, 1.0, 10.0, 12.0);
		assertTrue(Math.abs(spring.velocity()) <= 12.0);
	}

	@Test
	void wrappingKeepsAnglesInTheSignedDegreeRange() {
		assertEquals(170.0, DampedSpring.wrapDegrees(170.0), 1.0e-9);
		assertEquals(-170.0, DampedSpring.wrapDegrees(190.0), 1.0e-9);
		assertEquals(0.0, DampedSpring.wrapDegrees(360.0), 1.0e-9);
	}
}
