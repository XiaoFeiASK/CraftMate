package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class MiningApproachTest {
	@Test
	void walksWhenACompleteRouteExists() {
		assertEquals(
			MiningApproach.Mode.WALK_TO_LOG,
			MiningApproach.next(true, true)
		);
	}

	@Test
	void clearsARelevantLeafWhenNoRouteExists() {
		assertEquals(
			MiningApproach.Mode.CLEAR_CANOPY,
			MiningApproach.next(false, true)
		);
	}

	@Test
	void keepsTheHonestFailureWhenNeitherExists() {
		assertEquals(
			MiningApproach.Mode.WALK_TO_LOG,
			MiningApproach.next(false, false)
		);
	}

	@Test
	void refusesToHoldAttackOutsideReach() {
		assertFalse(MiningApproach.canDestroy(false, true));
		assertFalse(MiningApproach.canDestroy(true, false));
		assertTrue(MiningApproach.canDestroy(true, true));
	}
}
