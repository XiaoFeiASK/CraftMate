package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class ToolSelectionTest {
	@Test
	void aCorrectToolInAnotherSlotIsSelected() {
		assertEquals(
			3,
			ToolSelection.choose(
				new String[] {
					"minecraft:dirt",
					"minecraft:stick",
					"minecraft:oak_planks",
					"minecraft:wooden_pickaxe",
					null,
					null,
					null,
					null,
					null,
				},
				new boolean[] { false, false, false, true, false, false, false, false, false },
				true,
				2,
				2
			)
		);
	}

	@Test
	void noCorrectToolIsAnErrorInsteadOfBreakingWithoutDrops() {
		assertEquals(
			-1,
			ToolSelection.choose(
				new String[] { "minecraft:oak_planks", null, null, null, null, null, null, null, null },
				new boolean[] { false, false, false, false, false, false, false, false, false },
				true,
				0,
				0
			)
		);
	}

	@Test
	void aBlockWithoutAToolRequirementKeepsTheCurrentSlot() {
		assertEquals(
			0,
			ToolSelection.choose(
				new String[] { "minecraft:dirt", null, null, null, null, null, null, null, null },
				new boolean[] { false, false, false, false, false, false, false, false, false },
				false,
				1,
				0
			)
		);
	}
}
