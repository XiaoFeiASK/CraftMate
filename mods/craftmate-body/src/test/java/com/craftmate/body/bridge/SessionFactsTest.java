package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class SessionFactsTest {
	@Test
	void keepsMealFactsWhileTheSameBodyIsAlive() {
		assertFalse(SessionFacts.resetConsumables(true, true));
	}

	@Test
	void clearsMealFactsOnDeath() {
		assertTrue(SessionFacts.resetConsumables(false, true));
	}

	@Test
	void clearsMealFactsWhenRespawnCreatesANewBody() {
		assertTrue(SessionFacts.resetConsumables(true, false));
	}
}
