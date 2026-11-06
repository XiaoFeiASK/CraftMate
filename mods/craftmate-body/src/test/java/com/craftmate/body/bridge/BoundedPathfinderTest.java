package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.List;
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
			(cell) -> cell.x() == 4 && cell.y() == 0 && cell.z() == 0,
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
			(cell) -> cell.x() == 4,
			(x, y, z) -> z == 0 && x == 0,
			100,
			16
		);
		assertTrue(result == null);
	}

	@Test
	void searchesFromANonStandableStart() {
		// The body can be perched on a leaf canopy, where its own cell is not
		// "standable" (leaves are excluded as floors). Rejecting that start
		// made every search return null and left navigation frozen.
		BoundedPathfinder.Result result = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(0, 3, 0),
			new BoundedPathfinder.Cell(3, 3, 0),
			(cell) -> cell.x() == 3 && cell.y() == 3 && cell.z() == 0,
			(x, y, z) -> y == 3 && !(x == 0 && z == 0),
			200,
			16
		);
		assertNotNull(result);
		assertTrue(result.complete());
	}

	@Test
	void enforcesNodeBudget() {
		BoundedPathfinder.Result result = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(0, 0, 0),
			new BoundedPathfinder.Cell(30, 0, 30),
			(cell) -> cell.x() == 30 && cell.z() == 30,
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
			(cell) -> cell.x() == 2 && cell.y() == 1,
			(x, y, z) -> x == 0 ? y == 0 : y == 1,
			100,
			16
		);
		assertNotNull(result);
		assertTrue(result.complete());
	}

	@Test
	void followsASlopeMoreThanEightBlocksAboveTheStart() {
		// A crafting table placed on a hillside or tree platform can be more
		// than eight blocks above the body. The old hard vertical window made
		// the route impossible even though a legal one-block staircase existed.
		BoundedPathfinder.Result result = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(0, 0, 0),
			new BoundedPathfinder.Cell(12, 12, 0),
			(cell) -> cell.x() == 12 && cell.y() == 12 && cell.z() == 0,
			(x, y, z) -> z == 0 && y == Math.max(0, Math.min(x, 12)),
			500,
			24
		);
		assertNotNull(result);
		assertTrue(result.complete());
		assertTrue(result.path().get(result.path().size() - 1).y() == 12);
	}

	@Test
	void doesNotFakeCompletionWhenGoalIsOutsideRadius() {
		BoundedPathfinder.Result result = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(0, 0, 0),
			new BoundedPathfinder.Cell(30, 0, 0),
			(cell) -> cell.x() == 30 && cell.y() == 0 && cell.z() == 0,
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
			(cell) -> cell.x() == 1 && cell.y() == 1 && cell.z() == 1,
			(x, y, z) -> x == 0 ? y == 0 : (x == 1 && z == 1 ? y == 1 : y == 0),
			50,
			8
		);
		assertNotNull(result);
		assertTrue(result.complete());
	}

	@Test
	void keepsVerticalGoalToleranceAtOneBlock() {
		// An x/z-only goal let a route climb eight blocks of tree canopy and
		// still "arrive" at a ground-level column. The goal must include the
		// requested feet level, with a one-block allowance for downslope cells.
		BoundedPathfinder.Cell goal = new BoundedPathfinder.Cell(4, 0, 0);
		BoundedPathfinder.Goal nearGoal = (cell) ->
			Math.abs(cell.x() - goal.x()) <= 1
				&& Math.abs(cell.z() - goal.z()) <= 1
				&& Math.abs(cell.y() - goal.y()) <= 1;
		assertTrue(nearGoal.reached(new BoundedPathfinder.Cell(4, 1, 0)));
		assertTrue(nearGoal.reached(new BoundedPathfinder.Cell(4, -1, 0)));
		assertFalse(nearGoal.reached(new BoundedPathfinder.Cell(4, 8, 0)));

		BoundedPathfinder.Result result = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(0, 0, 0),
			goal,
			nearGoal,
			(x, y, z) -> y == 0 || (y > 0 && x >= 3 && z == 0),
			100,
			16
		);
		assertNotNull(result);
		assertTrue(result.complete());
		assertTrue(List.of(-1, 0, 1).contains(result.path().get(result.path().size() - 1).y()));
	}

	@Test
	void traversalRejectsDiagonalThroughClosedCorner() {
		// The search still finds an L-shaped way around an open corner, so
		// the assertion belongs on the predicate: a diagonal whose two
		// orthogonal cells are solid is never offered as a legal move.
		BoundedPathfinder.Cell from = new BoundedPathfinder.Cell(0, 0, 0);
		BoundedPathfinder.Cell diagonal = new BoundedPathfinder.Cell(1, 0, 1);
		Set<BoundedPathfinder.Cell> solid = new HashSet<>();
		solid.add(new BoundedPathfinder.Cell(1, 0, 0));
		solid.add(new BoundedPathfinder.Cell(0, 0, 1));
		BoundedPathfinder.Traversal corners = (start, end) -> {
			int dx = end.x() - start.x();
			int dz = end.z() - start.z();
			if (dx == 0 || dz == 0) return true;
			return !solid.contains(new BoundedPathfinder.Cell(end.x(), start.y(), start.z()))
				&& !solid.contains(new BoundedPathfinder.Cell(start.x(), start.y(), end.z()));
		};
		assertTrue(!corners.allowed(from, diagonal));
		assertTrue(corners.allowed(from, new BoundedPathfinder.Cell(1, 0, 0)));
	}

	@Test
	void traversalRejectsDropIntoCoveredColumn() {
		// A destination cell at y=0 is standable, but the body cannot move
		// sideways into it at y=1 because the lip at (1,1) is solid.
		BoundedPathfinder.Result result = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(0, 1, 0),
			new BoundedPathfinder.Cell(1, 0, 0),
			(cell) -> cell.x() == 1 && cell.y() == 0 && cell.z() == 0,
			(x, y, z) -> (x == 0 && y == 1) || (x == 1 && y == 0),
			(from, to) -> !(to.y() < from.y() && to.x() == 1),
			100,
			8
		);
		assertTrue(result == null || !result.complete());
	}

}
