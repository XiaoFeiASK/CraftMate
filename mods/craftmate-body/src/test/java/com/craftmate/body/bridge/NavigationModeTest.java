package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class NavigationModeTest {
	@Test
	void walkIsTheBackwardCompatibleDefault() {
		assertEquals(NavigationMode.WALK, NavigationMode.parse(null));
		assertEquals(NavigationMode.WALK, NavigationMode.parse(""));
		assertEquals(NavigationMode.WALK, NavigationMode.parse("walk"));
	}

	@Test
	void explicitModesControlTerrainMutation() {
		assertFalse(NavigationMode.WALK.mayDig());
		assertFalse(NavigationMode.WALK.mayBuild());
		assertTrue(NavigationMode.DIG.mayDig());
		assertFalse(NavigationMode.DIG.mayBuild());
		assertTrue(NavigationMode.RECOVER.mayDig());
		assertTrue(NavigationMode.RECOVER.mayBuild());
	}

	@Test
	void unknownModesAreRejectedInsteadOfSilentlyWalking() {
		assertThrows(IllegalArgumentException.class, () -> NavigationMode.parse("tunnel"));
	}
}
