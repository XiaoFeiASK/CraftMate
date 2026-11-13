package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class PickaxeBudgetTest {
	@Test
	void aFullBackupBeatsTheWornPickaxeInHand() {
		PickaxeBudget.Candidate chosen = PickaxeBudget.choose(
			new PickaxeBudget.Candidate[] {
				new PickaxeBudget.Candidate(2, "minecraft:stone_pickaxe", 24, 4.0f, 2),
				new PickaxeBudget.Candidate(31, "minecraft:stone_pickaxe", 131, 4.0f, 2),
			},
			true,
			PickaxeBudget.requiredUses(70, 0)
		);

		assertEquals(31, chosen.slot());
		assertEquals(131, chosen.uses());
	}

	@Test
	void aFasterEnoughTierWinsWhenBothCanFinishTheTrip() {
		PickaxeBudget.Candidate chosen = PickaxeBudget.choose(
			new PickaxeBudget.Candidate[] {
				new PickaxeBudget.Candidate(1, "minecraft:stone_pickaxe", 131, 4.0f, 2),
				new PickaxeBudget.Candidate(8, "minecraft:iron_pickaxe", 199, 6.0f, 3),
			},
			true,
			PickaxeBudget.requiredUses(90, 0)
		);

		assertEquals(8, chosen.slot());
	}

	@Test
	void theRichestToolIsReportedWhenNoPickaxeCanFinish() {
		PickaxeBudget.Candidate chosen = PickaxeBudget.choose(
			new PickaxeBudget.Candidate[] {
				new PickaxeBudget.Candidate(0, "minecraft:stone_pickaxe", 12, 4.0f, 2),
				new PickaxeBudget.Candidate(5, "minecraft:stone_pickaxe", 33, 4.0f, 2),
			},
			true,
			PickaxeBudget.requiredUses(70, 0)
		);

		assertEquals(5, chosen.slot());
	}
}
