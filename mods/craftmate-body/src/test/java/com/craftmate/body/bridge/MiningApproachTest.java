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
	void walksDirectlyWhenNoRouteExistsAndProgressIsStillPossible() {
		assertEquals(
			MiningApproach.Mode.WALK_TO_LOG,
			MiningApproach.next(false, true, false)
		);
	}

	@Test
	void clearsARelevantLeafOnlyAfterTheApproachStalls() {
		assertEquals(
			MiningApproach.Mode.CLEAR_CANOPY,
			MiningApproach.next(false, true, true)
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

	@Test
	void usesAnotherLogAlreadyUnderTheCrosshair() {
		assertEquals(
			MiningApproach.Obstruction.USE_HIT_BLOCK,
			MiningApproach.obstruction(true, false, false, false)
		);
	}

	@Test
	void clearsLeavesAndSoilInsteadOfScanningTheForest() {
		assertEquals(
			MiningApproach.Obstruction.CLEAR_OBSTRUCTION,
			MiningApproach.obstruction(false, true, false, false)
		);
		assertEquals(
			MiningApproach.Obstruction.CLEAR_OBSTRUCTION,
			MiningApproach.obstruction(false, false, true, false)
		);
	}

	@Test
	void tunnelsOutWhenTheBodyIsEnclosed() {
		assertEquals(
			MiningApproach.Obstruction.CLEAR_OBSTRUCTION,
			MiningApproach.obstruction(false, false, false, true)
		);
	}

	@Test
	void searchesOnlyWhenTheObstructionIsHardAndTheBodyIsOpen() {
		assertEquals(
			MiningApproach.Obstruction.SEARCH_ALTERNATIVE,
			MiningApproach.obstruction(false, false, false, false)
		);
	}
}
