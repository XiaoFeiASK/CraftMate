package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.Test;

class VoxelRayTest {
	@Test
	void findsTheFirstSolidBlockAlongTheLine() {
		BlockPos hit = VoxelRay.firstSolid(
			new Vec3(0.5, 0.5, 0.5),
			new Vec3(4.5, 0.5, 0.5),
			pos -> pos.equals(new BlockPos(2, 0, 0)) || pos.equals(new BlockPos(3, 0, 0))
		);
		assertEquals(new BlockPos(2, 0, 0), hit);
	}

	@Test
	void returnsNullWhenNothingBlocksTheLine() {
		assertNull(
			VoxelRay.firstSolid(
				new Vec3(0.5, 0.5, 0.5),
				new Vec3(4.5, 0.5, 0.5),
				pos -> false
			)
		);
	}

	@Test
	void walksDiagonalsWithoutSkippingTheCrossingCell() {
		BlockPos hit = VoxelRay.firstSolid(
			new Vec3(0.5, 0.5, 0.5),
			new Vec3(3.5, 3.5, 3.5),
			pos -> pos.equals(new BlockPos(2, 2, 2))
		);
		assertEquals(new BlockPos(2, 2, 2), hit);
	}
}
