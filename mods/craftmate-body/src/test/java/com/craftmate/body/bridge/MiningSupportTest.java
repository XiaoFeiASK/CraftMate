package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

class MiningSupportTest {
	@Test
	void supportBlockDirectlyBeneathBodyIsExcluded() {
		assertTrue(GameActions.removesCurrentSupport(4.5, 70, -2.5, new BlockPos(4, 69, -3)));
	}

	@Test
	void neighbouringStoneRemainsAValidTarget() {
		assertFalse(GameActions.removesCurrentSupport(4.5, 70, -2.5, new BlockPos(5, 69, -3)));
		assertFalse(GameActions.removesCurrentSupport(4.5, 70, -2.5, new BlockPos(4, 69, -2)));
	}

	@Test
	void deeperFloorIsNotSelectedAsSupport() {
		assertFalse(GameActions.removesCurrentSupport(4.5, 70, -2.5, new BlockPos(4, 66, -3)));
	}
}
