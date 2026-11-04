package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import org.junit.jupiter.api.Test;

class ContainerEvidenceTest {
	@Test
	void aBalancedInventoryAndContainerDeltaConfirmsTheTransfer() {
		Map<String, Integer> before = Map.of("minecraft:oak_log", 10);
		Map<String, Integer> after = Map.of("minecraft:oak_log", 7);
		Map<String, Integer> containerBefore = Map.of("minecraft:oak_log", 2);
		Map<String, Integer> containerAfter = Map.of("minecraft:oak_log", 5);
		assertEquals(3, ContainerEvidence.moved(before, after, containerBefore, containerAfter));
		assertTrue(ContainerEvidence.confirmed(before, after, containerBefore, containerAfter));
	}

	@Test
	void anInventoryLossWithoutAContainerGainIsNotConfirmed() {
		Map<String, Integer> before = Map.of("minecraft:oak_log", 10);
		Map<String, Integer> after = Map.of("minecraft:oak_log", 7);
		Map<String, Integer> container = Map.of("minecraft:oak_log", 2);
		assertEquals(0, ContainerEvidence.moved(before, after, container, container));
		assertFalse(ContainerEvidence.confirmed(before, after, container, container));
	}

	@Test
	void aContainerGainWithoutAnInventoryLossIsNotConfirmed() {
		Map<String, Integer> inventory = Map.of("minecraft:oak_log", 10);
		assertEquals(
			0,
			ContainerEvidence.moved(
				inventory,
				inventory,
				Map.of("minecraft:oak_log", 2),
				Map.of("minecraft:oak_log", 5)
			)
		);
	}

	@Test
	void differentItemsCannotCancelOutToAFalseConfirmation() {
		Map<String, Integer> inventoryBefore = Map.of(
			"minecraft:oak_log", 7,
			"minecraft:cobblestone", 8
		);
		Map<String, Integer> inventoryAfter = Map.of(
			"minecraft:oak_log", 4,
			"minecraft:cobblestone", 5
		);
		Map<String, Integer> containerBefore = Map.of("minecraft:oak_log", 1);
		Map<String, Integer> containerAfter = Map.of(
			"minecraft:oak_log", 4,
			"minecraft:cobblestone", 0
		);
		assertEquals(
			Map.of("minecraft:oak_log", 3),
			ContainerEvidence.moves(inventoryBefore, inventoryAfter, containerBefore, containerAfter)
		);
	}

	@Test
	void incompleteReasonsDistinguishClosedMenuFullContainerAndExhaustedInventory() {
		assertEquals(
			"the container screen closed before the transfer was confirmed",
			ContainerEvidence.incompleteReason(false, true, true)
		);
		assertEquals(
			"the container has no room for another matching item",
			ContainerEvidence.incompleteReason(true, true, false)
		);
		assertEquals(
			"no more matching items remain in the inventory",
			ContainerEvidence.incompleteReason(true, false, true)
		);
	}
}
