package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

class BoundedPathfinderTest {
	@Test
	void walksAroundShortWall() {
		Set<BoundedPathfinder.Cell> blocked = new HashSet<>();
		for (int z = -4; z <= 4; z++) {
			blocked.add(new BoundedPathfinder.Cell(2, 0, z));
		}
		BoundedPathfinder.Result result = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(0, 0, 0),
			new BoundedPathfinder.Cell(4, 0, 0),
			(x, y, z) -> x == 4 && y == 0 && z == 0,
			(x, y, z) -> y == 0 && !blocked.contains(new BoundedPathfinder.Cell(x, y, z)),
			500,
			16
		);
		assertNotNull(result);
		assertTrue(result.complete());
		assertTrue(result.path().size() > 5, "path should include waypoints around the wall");
	}

	@Test
	void refusesUnreachableGap() {
		BoundedPathfinder.Result result = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(0, 0, 0),
			new BoundedPathfinder.Cell(4, 0, 0),
			(x, y, z) -> x == 4,
			(x, y, z) -> z == 0 && x == 0,
			100,
			16
		);
		assertTrue(result == null);
	}

	@Test
	void enforcesNodeBudget() {
		BoundedPathfinder.Result result = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(0, 0, 0),
			new BoundedPathfinder.Cell(30, 0, 30),
			(x, y, z) -> x == 30 && z == 30,
			(x, y, z) -> y == 0,
			20,
			64
		);
		assertFalse(result != null && result.expanded() > 20);
	}

	@Test
	void allowsOneBlockStepUp() {
		BoundedPathfinder.Result result = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(0, 0, 0),
			new BoundedPathfinder.Cell(2, 1, 0),
			(x, y, z) -> x == 2 && y == 1,
			(x, y, z) -> x == 0 ? y == 0 : y == 1,
			100,
			16
		);
		assertNotNull(result);
		assertTrue(result.complete());
	}

	@Test
	void doesNotFakeCompletionWhenGoalIsOutsideRadius() {
		BoundedPathfinder.Result result = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(0, 0, 0),
			new BoundedPathfinder.Cell(30, 0, 0),
			(x, y, z) -> x == 30 && y == 0 && z == 0,
			(x, y, z) -> y == 0,
			500,
			4
		);
		assertFalse(result != null && result.complete());
	}

	@Test
	void diagonalStepReachesASlopeAOrthogonalGridCannot() {
		// A single diagonal rise is ordinary terrain, but a four-direction
		// search has to detour around it. The eight-direction search must
		// treat the diagonal cell as a valid move or hunts stall on slopes.
		BoundedPathfinder.Result result = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(0, 0, 0),
			new BoundedPathfinder.Cell(1, 1, 1),
			(x, y, z) -> x == 1 && y == 1 && z == 1,
			(x, y, z) -> x == 0 ? y == 0 : (x == 1 && z == 1 ? y == 1 : y == 0),
			50,
			8
		);
		assertNotNull(result);
		assertTrue(result.complete());
	}
}
