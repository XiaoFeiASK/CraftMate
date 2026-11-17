package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ReflexesTest {
	@Test
	void anArrowFlyingStraightAtTheChestIsACollisionCourse() {
		assertTrue(
			Reflexes.arrowOnCollisionCourse(
				10.0, 65.0, 0.0,
				-3.0, 0.0, 0.0,
				0.0, 65.0, 0.0
			)
		);
	}

	@Test
	void anArrowPassingBesideTheBodyIsNotACollisionCourse() {
		assertFalse(
			Reflexes.arrowOnCollisionCourse(
				10.0, 65.0, 3.0,
				-3.0, 0.0, 0.0,
				0.0, 65.0, 0.0
			)
		);
	}

	@Test
	void anArrowThatAlreadyPassedIsNotACollisionCourse() {
		assertFalse(
			Reflexes.arrowOnCollisionCourse(
				-2.0, 65.0, 0.0,
				-3.0, 0.0, 0.0,
				0.0, 65.0, 0.0
			)
		);
	}

	@Test
	void anArrowThatWillLandAfterTheLookaheadIsIgnored() {
		assertFalse(
			Reflexes.arrowOnCollisionCourse(
				40.0, 65.0, 0.0,
				-0.5, 0.0, 0.0,
				0.0, 65.0, 0.0
			)
		);
	}

	@Test
	void aGlancingTrajectoryThatMissesTheBodyDoesNotPreempt() {
		assertFalse(
			Reflexes.arrowOnCollisionCourse(
				12.0, 67.0, 0.0,
				-4.0, 0.0, 0.0,
				0.0, 65.0, 0.0
			)
		);
	}

	@Test
	void aDiagonalHitOnTheBodyIsDetected() {
		assertTrue(
			Reflexes.arrowOnCollisionCourse(
				6.0, 68.0, -6.0,
				-2.0, -1.0, 2.0,
				0.0, 65.0, 0.0
			)
		);
	}

	@Test
	void onlyMeleeRangeArrowsAndCreepersAreUrgent() {
		assertTrue(Reflexes.threatIsUrgent(false, false, 3.0));
		assertFalse(Reflexes.threatIsUrgent(false, false, 7.0));
		assertTrue(Reflexes.threatIsUrgent(false, true, 5.0));
		assertTrue(Reflexes.threatIsUrgent(true, false, 9.0));
	}

	@Test
	void anEmergencyRetreatStillLetsACreeperInterrupt() {
		assertTrue(Reflexes.keepsThreatDuringEmergency(true, true));
		assertFalse(Reflexes.keepsThreatDuringEmergency(true, false));
		assertTrue(Reflexes.keepsThreatDuringEmergency(false, false));
	}
}
