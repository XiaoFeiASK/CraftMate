package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ViewSlewTest {
	@Test
	void turnsAtMostTheConfiguredStep() {
		assertEquals(12.0f, ViewSlew.stepYaw(0.0f, 90.0f, 12.0f), 0.001f);
		assertEquals(-12.0f, ViewSlew.stepYaw(0.0f, -90.0f, 12.0f), 0.001f);
	}

	@Test
	void takesTheShortWayAroundTheCompass() {
		// 170 -> -170 is a 20 degree turn, not 340.
		assertEquals(178.0f, ViewSlew.stepYaw(170.0f, -170.0f, 8.0f), 0.001f);
		assertEquals(-178.0f, ViewSlew.stepYaw(-170.0f, 170.0f, 8.0f), 0.001f);
	}

	@Test
	void snapsTheLastFewDegreesInsteadOfOvershooting() {
		assertEquals(5.0f, ViewSlew.stepYaw(0.0f, 5.0f, 12.0f), 0.001f);
	}

	@Test
	void clampsPitchToTheVanillaRange() {
		assertEquals(90.0f, ViewSlew.stepPitch(80.0f, 120.0f, 20.0f), 0.001f);
		assertEquals(-90.0f, ViewSlew.stepPitch(-80.0f, -120.0f, 20.0f), 0.001f);
	}

	@Test
	void onlyWalksWhenFacingCloseEnough() {
		assertTrue(ViewSlew.aligned(0.0f, 20.0f, ViewSlew.WALK_ALIGNMENT));
		assertFalse(ViewSlew.aligned(0.0f, 40.0f, ViewSlew.WALK_ALIGNMENT));
		assertTrue(ViewSlew.aligned(179.0f, -179.0f, 5.0f));
	}

	@Test
	void bodyTurnRatesStayGentleEnoughForTheCameraSpring() {
		// Twenty client ticks per second. The rendered camera is allowed to
		// lag the body; these bounds keep that lag a gentle spring instead of
		// a one-frame snap.
		assertTrue(ViewSlew.WALK_TURN_PER_TICK * 20.0f <= 120.0f);
		assertTrue(ViewSlew.LOOK_TURN_PER_TICK * 20.0f <= 80.0f);
		assertTrue(ViewSlew.PITCH_PER_TICK * 20.0f <= 60.0f);
		assertTrue(ViewSlew.WALK_TURN_PER_TICK > ViewSlew.LOOK_TURN_PER_TICK);
	}

	@Test
	void aimingAtABlockUsesTheBodysOwnRotation() {
		assertEquals(-90.0f, ViewSlew.yawTo(1.0, 0.0), 0.001f);
		assertEquals(0.0f, ViewSlew.yawTo(0.0, 1.0), 0.001f);
		assertEquals(90.0f, ViewSlew.yawTo(-1.0, 0.0), 0.001f);
		assertEquals(180.0f, Math.abs(ViewSlew.yawTo(0.0, -1.0)), 0.001f);
		assertEquals(90.0f, ViewSlew.pitchTo(0.0, -1.0, 0.0), 0.001f);
		assertEquals(-90.0f, ViewSlew.pitchTo(0.0, 1.0, 0.0), 0.001f);
	}
}
