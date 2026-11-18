package com.craftmate.body.bridge;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.RenderShape;
import net.minecraft.world.level.block.state.BlockState;

/** Minecraft-side solid-block probe for the third-person camera. */
public final class CameraProbe {
	private CameraProbe() {
	}

	public static boolean isOpaqueSolid(BlockGetter level, BlockPos pos) {
		BlockState state = level.getBlockState(pos);
		return state.getRenderShape() == RenderShape.MODEL
			&& state.isSolidRender(level, pos)
			&& state.getFluidState().isEmpty();
	}
}
