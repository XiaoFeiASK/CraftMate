package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ShaftCoverTest {
	@Test
	void aThreeBlockShaftWithACapIsEnclosed() {
		assertTrue(GameActions.shaftIsEnclosed(4, 3, true, true));
		assertTrue(GameActions.shaftIsEnclosed(3, 4, true, true));
	}

	@Test
	void anOpenShaftIsNotShelter() {
		assertFalse(GameActions.shaftIsEnclosed(4, 2, true, true));
		assertFalse(GameActions.shaftIsEnclosed(4, 3, true, false));
	}

	@Test
	void aBlockInTheBodySpaceIsNotHeadroom() {
		assertFalse(GameActions.shaftIsEnclosed(4, 3, false, true));
	}

	@Test
	void openTerrainIsNotAShaft() {
		assertFalse(GameActions.shaftIsEnclosed(0, 3, true, true));
		assertFalse(GameActions.shaftIsEnclosed(2, 3, true, true));
	}
}
