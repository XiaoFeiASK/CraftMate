package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.AABB;
import org.junit.jupiter.api.Test;

class PlacementTargetTest {
	private record Candidate(String name, double distanceSqr, boolean destinationFree)
		implements PlacementTarget.Surface {}

	@Test
	void prefersAFreeDestinationThenDistance() {
		Candidate occupied = new Candidate("occupied", 0.2, false);
		Candidate farFree = new Candidate("far-free", 9.0, true);
		Candidate nearFree = new Candidate("near-free", 4.0, true);
		Candidate chosen = PlacementTarget.choose(List.of(occupied, farFree, nearFree));
		assertEquals("near-free", chosen.name());
	}

	@Test
	void ignoresSurfacesBeyondInteractionReach() {
		Candidate far = new Candidate("far", 30.0, true);
		assertNull(PlacementTarget.choose(List.of(far)));
	}

	@Test
	void acceptsAFaceInsideReach() {
		Candidate near = new Candidate("near", 4.0, true);
		assertEquals("near", PlacementTarget.choose(List.of(near)).name());
	}

	@Test
	void rejectsACellInsideThePlayerHitbox() {
		AABB player = new AABB(-31.3, 66.0, 176.3, -30.7, 67.8, 177.7);
		assertTrue(PlacementTarget.overlapsPlayer(player, -32, 66, 177));
		assertFalse(PlacementTarget.overlapsPlayer(player, -33, 66, 177));
		assertFalse(PlacementTarget.overlapsPlayer(player, -31, 68, 177));
	}

	@Test
	void protectsTheCurrentColumnAndItsFloor() {
		BlockPos feet = new BlockPos(-31, 66, 177);
		assertTrue(PlacementTarget.overlapsStandingCell(feet, -31, 66, 177));
		assertTrue(PlacementTarget.overlapsStandingCell(feet, -31, 65, 177));
		assertTrue(PlacementTarget.overlapsStandingCell(feet, -31, 64, 177));
		assertFalse(PlacementTarget.overlapsStandingCell(feet, -31, 67, 177));
		assertFalse(PlacementTarget.overlapsStandingCell(feet, -32, 66, 177));
	}
}
