package com.craftmate.body.bridge;

import java.util.ArrayList;
import java.util.List;

/**
 * Vanilla centers a shaped recipe in the crafting grid before placing it.
 * Re-implementing that rule here keeps the manual fallback aligned with the
 * server's own recipe-book placement instead of trying to infer offsets from
 * the flattened ingredient list.
 */
final class CraftGridLayout {
	private CraftGridLayout() {
	}

	static List<Integer> centeredTargets(
		int cells,
		int recipeWidth,
		int recipeHeight,
		int gridWidth,
		int gridHeight
	) {
		List<Integer> targets = new ArrayList<>();
		int offsetX = Math.floorDiv(gridWidth - recipeWidth, 2);
		int offsetY = Math.floorDiv(gridHeight - recipeHeight, 2);
		for (int row = 0; row < recipeHeight && targets.size() < cells; row++) {
			for (int column = 0; column < recipeWidth && targets.size() < cells; column++) {
				targets.add((offsetY + row) * gridWidth + offsetX + column);
			}
		}
		return targets;
	}
}
