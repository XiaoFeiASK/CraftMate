package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ShaftEscapeTest {
	@Test
	void aThreeWalledShaftWithAToolIsEscapable() {
		assertTrue(ShaftEscape.shouldDigOut(3, true));
	}

	@Test
	void openTerrainIsNotAShaft() {
		assertFalse(ShaftEscape.shouldDigOut(1, true));
	}

	@Test
	void noToolMeansNoWallBreaking() {
		assertFalse(ShaftEscape.shouldDigOut(4, false));
	}

	@Test
	void aVisibleSolidFaceIsMineable() {
		assertTrue(ShaftEscape.canBreakWall(true, true));
		assertFalse(ShaftEscape.canBreakWall(false, true));
		assertFalse(ShaftEscape.canBreakWall(true, false));
	}
}
