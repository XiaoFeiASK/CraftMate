package com.craftmate.body.bridge;

/**
 * A wooden pickaxe has 59 uses and mines stone slowly. Digging a real
 * staircase with one spends almost the whole tool before the body reaches
 * the ore layer; in the live run the result was a deep hole, a broken
 * pickaxe, and a body that could not get back. A shallow stone cut is still
 * fine, so only a descent of more than eight blocks demands stone or better.
 */
final class MiningDepth {
	private static final int MAX_PRIMITIVE_DEPTH = 8;

	private MiningDepth() {
	}

	static boolean requiresStonePickaxe(int depth) {
		return depth > MAX_PRIMITIVE_DEPTH;
	}

	static boolean isPrimitivePickaxe(String itemId) {
		return "minecraft:wooden_pickaxe".equals(itemId)
			|| "minecraft:golden_pickaxe".equals(itemId);
	}
}
