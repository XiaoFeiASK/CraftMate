package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class RespawnRetryTest {
	@Test
	void neverRespawnsWhileTheOperatorOwnsControl() {
		RespawnRetry retry = new RespawnRetry();
		assertFalse(retry.shouldRequest(false, true, true, 1_000L));
	}

	@Test
	void retriesALostPacketAfterTheBoundedDelay() {
		RespawnRetry retry = new RespawnRetry();
		assertTrue(retry.shouldRequest(true, true, true, 1_000L));
		assertFalse(retry.shouldRequest(true, true, true, 5_999L));
		assertTrue(retry.shouldRequest(true, true, true, 6_000L));
	}

	@Test
	void resetsAfterRespawningOrLosingControl() {
		RespawnRetry retry = new RespawnRetry();
		assertTrue(retry.shouldRequest(true, true, true, 1_000L));
		assertFalse(retry.shouldRequest(true, true, false, 1_001L));
		assertTrue(retry.shouldRequest(true, true, true, 1_002L));
		assertFalse(retry.shouldRequest(false, true, true, 1_003L));
		assertTrue(retry.shouldRequest(true, true, true, 1_004L));
		retry.reset();
		assertTrue(retry.shouldRequest(true, true, true, 1_010L));
	}
}
