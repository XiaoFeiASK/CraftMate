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

	@Test
	void aToolOutsideTheHotbarMustBeEquippedBeforeMining() {
		assertTrue(ShaftEscape.needsToolEquip(true, false));
		assertFalse(ShaftEscape.needsToolEquip(true, true));
		assertFalse(ShaftEscape.needsToolEquip(false, false));
	}

	@Test
	void sameLevelAndDownhillTargetsUseATunnelRatherThanStairsUp() {
		assertTrue(ShaftEscape.shouldTunnel(true, 0.0, 12.0));
		assertTrue(ShaftEscape.shouldTunnel(true, -8.0, 12.0));
		assertFalse(ShaftEscape.shouldTunnel(false, 0.0, 12.0));
		assertFalse(ShaftEscape.shouldTunnel(true, 4.0, 12.0));
		assertFalse(ShaftEscape.shouldTunnel(true, 0.0, 2.0));
	}

	@Test
	void openSkyAtACliffIsNotAPillarSite() {
		assertFalse(ShaftEscape.shouldStartPillar(false, 0));
		assertFalse(ShaftEscape.shouldStartPillar(false, 2));
	}

	@Test
	void aCeilingOrThreeWallsMakePillaringLegitimate() {
		assertTrue(ShaftEscape.shouldStartPillar(true, 0));
		assertTrue(ShaftEscape.shouldStartPillar(false, 3));
		assertTrue(ShaftEscape.shouldStartPillar(false, 4));
	}

	@Test
	void anUndergroundCaveCanPillarWithoutAPlayerMadeShaft() {
		assertTrue(ShaftEscape.shouldStartPillar(false, 0, true));
		assertTrue(ShaftEscape.shouldStartPillar(false, 2, true));
		assertFalse(ShaftEscape.shouldStartPillar(false, 0, false));
	}

	@Test
	void aPillarNeedsSkyOrAWayToBreakItsOwnSupport() {
		assertTrue(ShaftEscape.canRecoverFromPillar(true, false));
		assertTrue(ShaftEscape.canRecoverFromPillar(false, true));
		assertFalse(ShaftEscape.canRecoverFromPillar(false, false));
	}
}
