package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

class ApproachRouteTest {
	@Test
	void attackPositionMustBeNearAnimalHorizontally() {
		BlockPos cow = new BlockPos(0, 64, 0);
		assertTrue(ApproachRoute.withinEntityReach(cow, 2, 64, 0));
		assertTrue(ApproachRoute.withinEntityReach(cow, 0, 65, -2));
		assertFalse(ApproachRoute.withinEntityReach(cow, 3, 64, 0));
		assertFalse(ApproachRoute.withinEntityReach(cow, 30, 64, 0));
	}

	@Test
	void attackPositionMustBeAtAnimalFeetLevel() {
		BlockPos cow = new BlockPos(0, 64, 0);
		assertFalse(ApproachRoute.withinEntityReach(cow, 1, 61, 0));
		assertFalse(ApproachRoute.withinEntityReach(cow, 1, 68, 0));
	}

	@Test
	void partialRouteIsNotUsedForApproach() {
		ApproachRoute.Route partial = new ApproachRoute.Route(
			java.util.List.of(new net.minecraft.world.phys.Vec3(0.5, 64, 0.5)),
			new net.minecraft.world.phys.Vec3(0.5, 64, 0.5),
			false
		);
		assertFalse(ApproachRoute.usableForApproach(partial));
		assertFalse(ApproachRoute.usableForApproach(null));
	}
}
