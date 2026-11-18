package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

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

	@Test
	void aToolBelowTheRescueReserveStopsTheDescentForReplacement() {
		PickaxeBudget.Candidate worn = new PickaxeBudget.Candidate(
			0,
			"minecraft:stone_pickaxe",
			8,
			4.0f,
			2
		);
		PickaxeBudget.Candidate usable = new PickaxeBudget.Candidate(
			1,
			"minecraft:stone_pickaxe",
			12,
			4.0f,
			2
		);

		assertEquals(false, PickaxeBudget.hasRescueReserve(worn, 12));
		assertEquals(true, PickaxeBudget.hasRescueReserve(usable, 12));
	}

	@Test
	void theLastSwingIsSpentBeforeAskingForAReplacement() {
		PickaxeBudget.Candidate last = new PickaxeBudget.Candidate(
			0,
			"minecraft:iron_pickaxe",
			1,
			6.0f,
			3
		);
		PickaxeBudget.Candidate[] carried = new PickaxeBudget.Candidate[40];
		for (int slot = 0; slot < 8; slot++) {
			carried[slot] = new PickaxeBudget.Candidate(
				slot,
				"minecraft:iron_pickaxe",
				1,
				6.0f,
				3
			);
		}

		PickaxeBudget.Candidate chosen = PickaxeBudget.choose(
			carried,
			true,
			PickaxeBudget.requiredUses(40, 8)
		);

		assertEquals(0, chosen.slot());
		assertEquals(1, chosen.uses());
		assertTrue(PickaxeBudget.hasRescueReserve(chosen, 1));
		assertFalse(PickaxeBudget.hasRescueReserve(last, 2));
	}
}
