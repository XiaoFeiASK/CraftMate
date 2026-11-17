package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ToolSelectionTest {
	@Test
	void aFistCannotHarvestBlocksThatRequireACorrectTool() {
		assertFalse(ToolSelection.canHarvest(true, false));
		assertTrue(ToolSelection.canHarvest(true, true));
		assertTrue(ToolSelection.canHarvest(false, false));
	}

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

	@Test
	void aFreshReplacementBeatsTheWornToolOfTheSameTier() {
		assertEquals(
			2,
			ToolSelection.chooseBest(
				new boolean[] { true, true, true, false, false, false, false, false, false },
				new float[] { 8.0f, 8.0f, 8.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f },
				new int[] { 3, 40, 131, 0, 0, 0, 0, 0, 0 },
				0
			)
		);
	}

	@Test
	void aHealthyCurrentToolDoesNotFlickerBetweenEqualTools() {
		assertEquals(
			1,
			ToolSelection.chooseBest(
				new boolean[] { true, true, false, false, false, false, false, false, false },
				new float[] { 8.0f, 8.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f },
				new int[] { 110, 100, 0, 0, 0, 0, 0, 0, 0 },
				1
			)
		);
	}

	@Test
	void aNearlyBrokenFasterToolLosesToAFreshSlowerTool() {
		assertEquals(
			1,
			ToolSelection.chooseBest(
				new boolean[] { true, true, false, false, false, false, false, false, false },
				new float[] { 6.0f, 4.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f },
				new int[] { 2, 131, 0, 0, 0, 0, 0, 0, 0 },
				0
			)
		);
	}
}
