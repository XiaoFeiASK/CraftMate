package com.craftmate.body.bridge;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

/**
 * A small bounded A* search over standable block cells. It intentionally does
 * not know about Minecraft: callers supply a read-only passability snapshot,
 * so the search cannot touch a live level from another thread and every run
 * has a hard node budget.
 */
public final class BoundedPathfinder {
	private static final int MAX_VERTICAL = 8;
	private static final int[][] HORIZONTAL = {
		{ 1, 0 },
		{ -1, 0 },
		{ 0, 1 },
		{ 0, -1 },
	};
	/** Same level first, then a conservative drop or one-block step up. */
	private static final int[] VERTICAL_ORDER = { 0, -1, 1 };

	private BoundedPathfinder() {
	}

	public record Cell(int x, int y, int z) {
	}

	public record Result(List<Cell> path, boolean complete, int expanded) {
	}

	@FunctionalInterface
	public interface Grid {
		boolean standable(int x, int y, int z);
	}

	@FunctionalInterface
	public interface Goal {
		boolean reached(int x, int y, int z);
	}

	/**
	 * Returns the best path found before the node budget is exhausted. A
	 * non-complete path still ends on a reachable standable cell, so callers
	 * can report an honest partial result instead of pretending to arrive.
	 */
	public static Result find(
		Cell start,
		Cell goalCell,
		Goal goal,
		Grid grid,
		int maxNodes,
		double maxRadius
	) {
		if (maxNodes <= 0) return null;
		if (!grid.standable(start.x, start.y, start.z)) return null;
		if (goal.reached(start.x, start.y, start.z)) {
			return new Result(List.of(start), true, 1);
		}

		PriorityQueue<OpenNode> open = new PriorityQueue<>(
			(left, right) -> {
				int score = Double.compare(left.estimatedTotal, right.estimatedTotal);
				return score != 0 ? score : Integer.compare(left.order, right.order);
			}
		);
		Map<Cell, Double> bestCost = new HashMap<>();
		Map<Cell, Cell> parent = new HashMap<>();
		Set<Cell> closed = new HashSet<>();
		bestCost.put(start, 0.0);
		open.add(new OpenNode(start, 0.0, heuristic(start, goalCell), 0));

		Cell best = start;
		double bestRemaining = heuristic(start, goalCell);
		int expanded = 0;
		int order = 1;

		while (!open.isEmpty() && expanded < maxNodes) {
			OpenNode current = open.poll();
			if (!closed.add(current.cell)) continue;
			expanded++;

			double remaining = heuristic(current.cell, goalCell);
			if (remaining < bestRemaining) {
				bestRemaining = remaining;
				best = current.cell;
			}
			if (goal.reached(current.cell.x, current.cell.y, current.cell.z)) {
				return new Result(reconstruct(parent, current.cell), true, expanded);
			}

			for (int[] direction : HORIZONTAL) {
				for (int dy : VERTICAL_ORDER) {
					int x = current.cell.x + direction[0];
					int y = current.cell.y + dy;
					int z = current.cell.z + direction[1];
					Cell next = new Cell(x, y, z);
					if (closed.contains(next)) continue;
					if (
						Math.hypot(x - start.x, z - start.z) > maxRadius
							|| Math.abs(y - start.y) > MAX_VERTICAL
					) {
						continue;
					}
					if (!grid.standable(x, y, z)) continue;

					double moveCost = 1.0 + (dy == 0 ? 0.0 : 0.25);
					double cost = current.cost + moveCost;
					Double known = bestCost.get(next);
					if (known != null && known <= cost) continue;
					bestCost.put(next, cost);
					parent.put(next, current.cell);
					open.add(
						new OpenNode(
							next,
							cost,
							cost + heuristic(next, goalCell),
							order++
						)
					);
				}
			}
		}

		if (best.equals(start)) return null;
		return new Result(reconstruct(parent, best), false, expanded);
	}

	private static List<Cell> reconstruct(Map<Cell, Cell> parent, Cell end) {
		List<Cell> path = new ArrayList<>();
		Cell current = end;
		while (current != null) {
			path.add(current);
			current = parent.get(current);
		}
		Collections.reverse(path);
		return path;
	}

	private static double heuristic(Cell cell, Cell goal) {
		double horizontal = Math.hypot(cell.x - goal.x, cell.z - goal.z);
		return horizontal + Math.abs(cell.y - goal.y) * 0.25;
	}

	private record OpenNode(Cell cell, double cost, double estimatedTotal, int order) {
	}
}
