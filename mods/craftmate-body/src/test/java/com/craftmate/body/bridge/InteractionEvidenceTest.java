package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class InteractionEvidenceTest {
	private static InteractionEvidence.BlockSnapshot block(
		String id, String state, boolean air, boolean replaceable
	) {
		return new InteractionEvidence.BlockSnapshot(id, state, air, replaceable, false);
	}

	private static InteractionEvidence.TargetSnapshot target(
		int id, float health, boolean alive, boolean visible, double distance
	) {
		return new InteractionEvidence.TargetSnapshot(id, health, alive, visible, distance);
	}

	@Test
	void placementRequiresTheRequestedBlockAndASpentItem() {
		assertTrue(
			InteractionEvidence.placementConfirmed(
				"minecraft:oak_planks",
				block("minecraft:air", "air", true, true),
				block("minecraft:oak_planks", "planks", false, false),
				4,
				3,
				false
			)
		);
		assertFalse(
			InteractionEvidence.placementConfirmed(
				"minecraft:oak_planks",
				block("minecraft:air", "air", true, true),
				block("minecraft:oak_planks", "planks", false, false),
				4,
				4,
				false
			),
			"a predicted block without inventory consumption is not confirmed"
		);
		assertFalse(
			InteractionEvidence.placementConfirmed(
				"minecraft:oak_planks",
				block("minecraft:air", "air", true, true),
				block("minecraft:dirt", "dirt", false, false),
				4,
				3,
				false
			),
			"a different block must not count as the requested placement"
		);
		assertFalse(
			InteractionEvidence.placementConfirmed(
				"minecraft:oak_planks",
				block("minecraft:stone", "stone", false, false),
				block("minecraft:oak_planks", "planks", false, false),
				4,
				3,
				false
			),
			"placing into an already occupied cell overwrites nothing"
		);
	}

	@Test
	void creativePlacementDoesNotNeedInventoryConsumption() {
		assertTrue(
			InteractionEvidence.placementConfirmed(
				"minecraft:oak_planks",
				block("minecraft:air", "air", true, true),
				block("minecraft:oak_planks", "planks", false, false),
				4,
				4,
				true
			)
		);
	}

	@Test
	void useNeedsAWorldInventoryOrScreenEffect() {
		assertFalse(
			InteractionEvidence.useConfirmed(
				block("minecraft:chest", "chest", false, false),
				block("minecraft:chest", "chest", false, false),
				2,
				2
			),
			"an unchanged chest and item is not proof"
		);
		assertTrue(
			InteractionEvidence.useConfirmed(
				block("minecraft:redstone_ore", "ore:lit=false", false, false),
				block("minecraft:redstone_ore", "ore:lit=true", false, false),
				0,
				0
			),
			"a block state change is observable"
		);
		assertTrue(
			InteractionEvidence.useConfirmed(
				block("minecraft:grass_block", "grass", false, false),
				block("minecraft:grass_block", "grass", false, false),
				1,
				0
			),
			"an inventory change is observable"
		);
	}

	@Test
	void attackOnlyCountsWhenTheSameEntityLostHealthOrDied() {
		assertTrue(
			InteractionEvidence.attackConfirmed(
				target(7, 20f, true, true, 2.0),
				target(7, 14f, true, true, 2.0)
			)
		);
		assertTrue(
			InteractionEvidence.attackConfirmed(
				target(7, 20f, true, true, 2.0),
				target(7, 0f, false, true, 2.0)
			)
		);
		assertFalse(
			InteractionEvidence.attackConfirmed(
				target(7, 20f, true, true, 2.0),
				target(7, 20f, true, true, 2.0)
			),
			"a swing without a health change is not a hit"
		);
		assertFalse(
			InteractionEvidence.attackConfirmed(
				target(7, 20f, true, true, 2.0),
				target(8, 10f, true, true, 2.0)
			),
			"a different entity must not be credited"
		);
		assertFalse(
			InteractionEvidence.attackConfirmed(
				target(7, 20f, true, true, 2.0),
				null
			),
			"a despawned entity is unconfirmed, not a kill"
		);
	}

	@Test
	void attackBlockReasonIsExplicit() {
		assertNull(InteractionEvidence.attackBlocked(target(7, 20f, true, true, 2.0)));
		assertEquals(
			"target is out of reach",
			InteractionEvidence.attackBlocked(target(7, 20f, true, true, 4.0))
		);
		assertEquals(
			"target is no longer visible",
			InteractionEvidence.attackBlocked(target(7, 20f, true, false, 2.0))
		);
		assertEquals(
			"target is already dead",
			InteractionEvidence.attackBlocked(target(7, 0f, false, true, 2.0))
		);
		assertEquals(
			"target is no longer present",
			InteractionEvidence.attackBlocked(null)
		);
	}

	@Test
	void itemChangeComparesBothKindAndCount() {
		assertTrue(InteractionEvidence.itemChanged("minecraft:milk_bucket", 1, "minecraft:bucket", 1));
		assertTrue(InteractionEvidence.itemChanged("minecraft:bread", 3, "minecraft:bread", 2));
		assertFalse(InteractionEvidence.itemChanged("minecraft:bread", 3, "minecraft:bread", 3));
		assertFalse(InteractionEvidence.itemChanged(null, 0, "minecraft:bread", 1));
	}

	@Test
	void attackWaitsForEnoughCharge() {
		assertFalse(InteractionEvidence.attackReady(0.0f));
		assertFalse(InteractionEvidence.attackReady(0.6f));
		assertTrue(InteractionEvidence.attackReady(0.9f));
		assertTrue(InteractionEvidence.attackReady(1.0f));
	}

	@Test
	void durabilityEvidenceRequiresTheSameTool() {
		assertTrue(
			InteractionEvidence.durabilityChanged(
				"minecraft:iron_pickaxe",
				"minecraft:iron_pickaxe",
				10,
				11
			)
		);
		assertFalse(
			InteractionEvidence.durabilityChanged(
				"minecraft:iron_pickaxe",
				"minecraft:stone_pickaxe",
				10,
				11
			),
			"a different tool must not inherit the old durability"
		);
		assertFalse(InteractionEvidence.durabilityChanged("minecraft:iron_pickaxe", "minecraft:iron_pickaxe", 10, 10));
	}
}
