package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class CanopyCleanupTest {
	@Test
	void acceptsARelevantCanopyLeaf() {
		assertTrue(CanopyCleanup.relevant(-5, 121, 9, -5, 119, 9, 4.0, 5.0));
	}

	@Test
	void rejectsAnUnrelatedTreeAcrossTheRavine() {
		assertFalse(CanopyCleanup.relevant(12, 121, 9, -5, 119, 9, 4.0, 5.0));
	}

	@Test
	void rejectsARelevantLeafOutsideInteractionRange() {
		assertFalse(CanopyCleanup.relevant(-5, 121, 9, -5, 119, 9, 25.0, 4.0));
	}
}
