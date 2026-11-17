package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class NavGoalTest {
	@Test
	void pointRequiresTheSameCell() {
		NavGoal goal = NavGoal.point(new BoundedPathfinder.Cell(10, 64, 10));
		assertTrue(goal.reached(new BoundedPathfinder.Cell(10, 64, 10)));
		assertFalse(goal.reached(new BoundedPathfinder.Cell(11, 64, 10)));
	}

	@Test
	void nearAcceptsTheWholeNeighbourhood() {
		NavGoal goal = NavGoal.near(new BoundedPathfinder.Cell(10, 64, 10), 3);
		assertTrue(goal.reached(new BoundedPathfinder.Cell(13, 65, 7)));
		assertFalse(goal.reached(new BoundedPathfinder.Cell(14, 64, 10)));
	}

	@Test
	void columnIgnoresHeightButKeepsTheRadius() {
		NavGoal goal = NavGoal.column(new BoundedPathfinder.Cell(10, 64, 10), 1);
		assertTrue(goal.reached(new BoundedPathfinder.Cell(10, 120, 10)));
		assertFalse(goal.reached(new BoundedPathfinder.Cell(12, 64, 10)));
	}

	@Test
	void estimateStopsPushingOnceInsideTheRadius() {
		NavGoal goal = NavGoal.near(new BoundedPathfinder.Cell(0, 0, 0), 3);
		assertEquals(7.0, goal.estimate(new BoundedPathfinder.Cell(10, 0, 0)), 0.001);
		assertEquals(0.0, goal.estimate(new BoundedPathfinder.Cell(3, 0, 0)), 0.001);
	}
}
