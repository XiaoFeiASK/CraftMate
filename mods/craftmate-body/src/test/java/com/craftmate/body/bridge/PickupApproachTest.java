package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class PickupApproachTest {
	@Test
	void jumpsIntoAPitWhenTheDropIsClearlyBelow() {
		assertTrue(PickupApproach.shouldJumpDown(115.0, 111.5, true, false));
	}

	@Test
	void doesNotJumpWhileAirborneOrForAFlatDrop() {
		assertFalse(PickupApproach.shouldJumpDown(115.0, 111.5, false, false));
		assertFalse(PickupApproach.shouldJumpDown(115.0, 114.8, true, false));
	}

	@Test
	void neverJumpsTowardLava() {
		assertFalse(PickupApproach.shouldJumpDown(115.0, 111.5, true, true));
	}
}
