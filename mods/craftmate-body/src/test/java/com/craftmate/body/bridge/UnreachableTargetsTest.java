package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class UnreachableTargetsTest {
	@Test
	void aTargetIsSuppressedOnlyUntilItsTtlExpires() {
		UnreachableTargets targets = new UnreachableTargets(60_000);
		targets.block(42L, 1_000);
		assertTrue(targets.blocked(42L, 1_001));
		assertTrue(targets.blocked(42L, 60_999));
		assertFalse(targets.blocked(42L, 61_000));
	}

	@Test
	void differentTargetsDoNotInvalidateEachOther() {
		UnreachableTargets targets = new UnreachableTargets(1_000);
		targets.block(1L, 10);
		targets.block(2L, 10);
		targets.unblock(1L);
		assertFalse(targets.blocked(1L, 11));
		assertTrue(targets.blocked(2L, 11));
	}
}
