package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class CollectionEvidenceTest {
	@Test
	void inventoryGainIsNeverNegative() {
		assertEquals(0, CollectionEvidence.gain(10, 10));
		assertEquals(0, CollectionEvidence.gain(10, 7));
		assertEquals(3, CollectionEvidence.gain(10, 13));
	}

	@Test
	void completionNeedsTheRequestedInventoryDelta() {
		assertTrue(CollectionEvidence.satisfied(4, 7, 3));
		assertFalse(CollectionEvidence.satisfied(4, 6, 3));
		assertFalse(
			CollectionEvidence.satisfied(4, 4, 1),
			"a removed item entity without inventory gain is not a collection"
		);
	}

	@Test
	void blockedReasonDistinguishesFullInventoryFromNoApproach() {
		assertNull(CollectionEvidence.blockedReason(true, 2, 60));
		assertNull(
			CollectionEvidence.blockedReason(false, 0, 80),
			"a body still walking toward the item has not been blocked yet"
		);
		assertEquals(
			"item is within reach but the inventory did not change",
			CollectionEvidence.blockedReason(true, 60, 60)
		);
		assertEquals(
			"no progress toward the dropped item",
			CollectionEvidence.blockedReason(false, 60, 60)
		);
	}
}
