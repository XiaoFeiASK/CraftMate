package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class SleepEvidenceTest {
	@Test
	void aUsableBedAndNightHaveNoBlockedReason() {
		assertNull(SleepEvidence.blockedReason(false, true, false, false, true));
	}

	@Test
	void eachPreconditionIsReportedInOrder() {
		assertEquals("player is already sleeping", SleepEvidence.blockedReason(true, false, false, false, false));
		assertEquals("no bed within 16 blocks", SleepEvidence.blockedReason(false, false, false, false, true));
		assertEquals("beds explode in this dimension", SleepEvidence.blockedReason(false, true, true, true, false));
		assertEquals("the bed is occupied", SleepEvidence.blockedReason(false, true, true, false, true));
		assertEquals("it is not night or a thunderstorm", SleepEvidence.blockedReason(false, true, false, false, false));
	}

	@Test
	void onlyANewDayConfirmsTheNightWasSkipped() {
		assertTrue(SleepEvidence.nextDayReached(4, 5));
		assertFalse(SleepEvidence.nextDayReached(4, 4));
		assertFalse(SleepEvidence.nextDayReached(4, 3));
	}
}
