package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class AudienceLightTest {
	@Test
	void liftsBlackToAVisibleFloorAndLeavesFullBrightAlone() {
		assertEquals(38, AudienceLight.liftChannel(0));
		assertEquals(255, AudienceLight.liftChannel(255));
	}

	@Test
	void liftsDarkChannelsWithoutReversingOrder() {
		int previous = 0;
		for (int value = 0; value < 256; value++) {
			int lifted = AudienceLight.liftChannel(value);
			assertTrue(lifted >= previous, "curve must stay monotonic");
			previous = lifted;
		}
		assertTrue(AudienceLight.liftChannel(16) > 16);
		assertTrue(AudienceLight.liftChannel(64) > 64);
	}

	@Test
	void preservesAlphaAndEachColorByte() {
		int pixel = 0xFF203040;
		int lifted = AudienceLight.liftPixel(pixel);
		assertEquals(0xFF000000, lifted & 0xFF000000);
		assertEquals(AudienceLight.liftChannel(0x40), lifted & 0xFF);
		assertEquals(AudienceLight.liftChannel(0x30), (lifted >>> 8) & 0xFF);
		assertEquals(AudienceLight.liftChannel(0x20), (lifted >>> 16) & 0xFF);
	}
}
