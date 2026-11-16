package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class CameraSpringTest {
	@Test
	void followTargetKeepsTheCharacterOnTheHorizontalCentreLine() {
		CameraSpring.Target south = CameraSpring.followTarget(
			0,
			64,
			0,
			0,
			0,
			0,
			0
		);
		assertEquals(0.0, south.x(), 1.0e-6);
		assertEquals(64.35, south.y(), 1.0e-6);
		assertEquals(-3.2, south.z(), 1.0e-6);

		CameraSpring.Target east = CameraSpring.followTarget(
			0,
			64,
			0,
			-90,
			0,
			0,
			0
		);
		assertEquals(-3.2, east.x(), 1.0e-6);
		assertEquals(0.0, east.z(), 1.0e-6);
	}

	@Test
	void lookAheadIsBounded() {
		CameraSpring.Target target = CameraSpring.followTarget(
			0,
			64,
			0,
			0,
			0,
			20,
			-20
		);
		double dx = target.x();
		double dz = target.z() + 3.2;
		assertTrue(Math.hypot(dx, dz) <= 0.5 + 1.0e-6);
	}

	@Test
	void framingPitchBlendsLookIntentWithBodyPitch() {
		assertEquals(12.0f, CameraSpring.framingPitch(20.0f, 0.0f), 1.0e-6);
		assertEquals(8.0f, CameraSpring.framingPitch(0.0f, 20.0f), 1.0e-6);
	}

	@Test
	void springNeverJumpsMoreThanItsPerFrameBudget() {
		CameraSpring spring = new CameraSpring();
		spring.snap(0, 64, 0);
		spring.step(new CameraSpring.Target(30, 80, -30), 1.0 / 60.0);
		double moved = spring.distanceTo(0, 64, 0);
		assertTrue(moved <= CameraSpring.MAX_STEP_PER_FRAME + 1.0e-6);
		assertFalse(moved < 0.1);
	}

	@Test
	void occlusionClipsTowardTheEyeAndKeepsAMargin() {
		CameraSpring.Target desired = new CameraSpring.Target(0, 64, -3.2);
		CameraSpring.Target clipped = CameraSpring.clipped(0, 64, 0, desired, 1.0);
		assertTrue(clipped.z() > -3.2);
		assertTrue(clipped.z() <= -0.6);
	}
}
