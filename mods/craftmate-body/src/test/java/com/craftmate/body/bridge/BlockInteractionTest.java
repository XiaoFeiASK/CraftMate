package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

class BlockInteractionTest {
	private static final BlockPos TABLE = new BlockPos(0, 0, 0);

	@BeforeAll
	static void bootstrapRegistries() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@Test
	void leavesOccludeInteractionFacesButAirDoesNot() {
		assertFalse(
			BlockInteraction.openForInteraction(Blocks.OAK_LEAVES.defaultBlockState())
		);
		assertTrue(BlockInteraction.openForInteraction(Blocks.AIR.defaultBlockState()));
	}

	@Test
	void aBodyAboveTheBlockUsesTheTopFace() {
		Vec3 point = BlockInteraction.point(new Vec3(0.5, 2.62, 0.5), TABLE);
		assertEquals(0.5, point.x);
		assertEquals(0.98, point.y);
		assertEquals(0.5, point.z);
	}

	@Test
	void aBodyBelowTheBlockUsesTheBottomFace() {
		Vec3 point = BlockInteraction.point(new Vec3(0.5, -1.5, 0.5), TABLE);
		assertEquals(0.02, point.y);
	}

	@Test
	void aSideApproachUsesTheNearestSideFace() {
		assertEquals(0.98, BlockInteraction.point(new Vec3(3.0, 0.62, 0.5), TABLE).x);
		assertEquals(0.02, BlockInteraction.point(new Vec3(-2.0, 0.62, 0.5), TABLE).x);
	}

	@Test
	void aSteepApproachToAFlushBlockUsesTheTopRatherThanTheCentre() {
		Vec3 point = BlockInteraction.point(new Vec3(1.3, 2.62, 0.5), TABLE);
		assertEquals(0.98, point.y);
	}

	@Test
	void theHitCarriesTheClickedFaceWithoutAViewAngle() {
		assertEquals(Direction.UP, BlockInteraction.hit(TABLE, Direction.UP).getDirection());
		assertEquals(Direction.WEST, BlockInteraction.hit(TABLE, Direction.WEST).getDirection());
	}

	@Test
	void anOreInANarrowTunnelWallIsVisibleFromTheShaft() {
		BlockPos ore = new BlockPos(2, 0, 0);
		BlockGetter level = level(Map.of(
			ore, Blocks.IRON_ORE.defaultBlockState(),
			new BlockPos(1, 0, 0), Blocks.AIR.defaultBlockState(),
			new BlockPos(1, 1, 0), Blocks.AIR.defaultBlockState()
		));
		assertEquals(
			Direction.WEST,
			BlockInteraction.visibleExposedFace(
				level,
				null,
				new Vec3(1.5, 1.62, 0.5),
				ore
			)
		);
	}

	@Test
	void oreDirectlyAboveTheEyeUsesItsBottomFace() {
		BlockPos ore = new BlockPos(0, 2, 0);
		BlockGetter level = level(Map.of(
			ore, Blocks.IRON_ORE.defaultBlockState(),
			new BlockPos(0, 1, 0), Blocks.AIR.defaultBlockState()
		));
		assertEquals(
			Direction.DOWN,
			BlockInteraction.visibleExposedFace(
				level,
				null,
				new Vec3(0.5, 1.62, 0.5),
				ore
			)
		);
	}

	@Test
	void aStairOverhangMayHideTheFaceCentreButNotTheWholeFace() {
		BlockPos ore = new BlockPos(0, 0, 0);
		BlockGetter level = level(Map.of(
			ore, Blocks.IRON_ORE.defaultBlockState(),
			new BlockPos(-1, 0, 0), Blocks.AIR.defaultBlockState(),
			new BlockPos(-2, 0, 0), Blocks.AIR.defaultBlockState(),
			new BlockPos(-2, 1, 0), Blocks.AIR.defaultBlockState()
		));
		assertEquals(
			Direction.WEST,
			BlockInteraction.visibleExposedFace(
				level,
				null,
				new Vec3(-2.0, 1.7, 0.5),
				ore
			)
		);
	}

	@Test
	void aDirectSideRayStillFindsTheOreFace() {
		BlockPos ore = new BlockPos(0, 0, 0);
		BlockGetter level = level(Map.of(
			ore, Blocks.IRON_ORE.defaultBlockState(),
			new BlockPos(-1, 0, 0), Blocks.AIR.defaultBlockState(),
			new BlockPos(-2, 0, 0), Blocks.AIR.defaultBlockState()
		));
		assertEquals(
			Direction.WEST,
			BlockInteraction.visibleExposedFace(
				level,
				null,
				new Vec3(-2.0, 0.5, 0.5),
				ore
			)
		);
	}

	private static BlockGetter level(Map<BlockPos, BlockState> overrides) {
		Map<BlockPos, BlockState> states = new HashMap<>(overrides);
		return new BlockGetter() {
			@Override
			public BlockEntity getBlockEntity(BlockPos pos) {
				return null;
			}

			@Override
			public BlockState getBlockState(BlockPos pos) {
				return states.getOrDefault(pos, Blocks.STONE.defaultBlockState());
			}

			@Override
			public FluidState getFluidState(BlockPos pos) {
				return getBlockState(pos).getFluidState();
			}

			@Override
			public int getHeight() {
				return 384;
			}

			@Override
			public int getMinBuildHeight() {
				return -64;
			}
		};
	}
}
