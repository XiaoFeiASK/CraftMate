package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Blocks;
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
}
