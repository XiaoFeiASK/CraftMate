package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
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
}
