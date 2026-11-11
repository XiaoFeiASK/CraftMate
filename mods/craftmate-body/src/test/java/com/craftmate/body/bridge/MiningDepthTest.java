package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class MiningDepthTest {
	@Test
	void allowsAShallowStoneCutWithAPrimitivePickaxe() {
		assertFalse(MiningDepth.requiresStonePickaxe(8));
	}

	@Test
	void refusesARealDescentWithAPrimitivePickaxe() {
		assertTrue(MiningDepth.requiresStonePickaxe(9));
		assertTrue(MiningDepth.isPrimitivePickaxe("minecraft:wooden_pickaxe"));
		assertTrue(MiningDepth.isPrimitivePickaxe("minecraft:golden_pickaxe"));
		assertFalse(MiningDepth.isPrimitivePickaxe("minecraft:stone_pickaxe"));
	}
}
