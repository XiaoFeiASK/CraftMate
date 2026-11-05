package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.api.Test;

class CraftGridLayoutTest {
	@Test
	void centersAOneByTwoRecipeInTheMiddleColumn() {
		assertEquals(
			List.of(1, 4),
			CraftGridLayout.centeredTargets(2, 1, 2, 3, 3)
		);
	}

	@Test
	void keepsAFullGridRecipeAtTheOrigin() {
		assertEquals(
			List.of(0, 1, 2, 3, 4, 5, 6, 7, 8),
			CraftGridLayout.centeredTargets(9, 3, 3, 3, 3)
		);
	}

	@Test
	void centersATwoByTwoRecipeOnAThreeByThreeTable() {
		assertEquals(
			List.of(0, 1, 3, 4),
			CraftGridLayout.centeredTargets(4, 2, 2, 3, 3)
		);
	}
}
