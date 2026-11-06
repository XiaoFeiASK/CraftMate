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
	/**
	 * A placed station commonly sits one hillside or tree level above the
	 * body. Eight blocks was an arbitrary search-width guard, but it also
	 * rejected a real route to a crafting table thirteen blocks above the
	 * player, so every approach returned "no route" and the body froze while
	 * the planner retried the same craft. Sixteen still bounds the search;
	 * the node budget and radius remain the expensive guards.
	 */
	private static final int MAX_VERTICAL = 16;
	private static final int[][] HORIZONTAL = {
		{ 1, 0 },
		{ -1, 0 },
		{ 0, 1 },
		{ 0, -1 },
		{ 1, 1 },
		{ 1, -1 },
		{ -1, 1 },
		{ -1, -1 },
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

	/**
	 * Extra geometry the plain standability grid cannot express. A cell can be
	 * perfectly standable and still be impossible to enter: vanilla resolves
	 * horizontal movement per axis, so a diagonal through a closed corner
	 * wedges the body, and a one-block drop into a covered column stops the
	 * body against the lip. Both produced routes that were "valid" on paper
	 * while the player jumped against a wall forever.
	 */
	@FunctionalInterface
	public interface Traversal {
		boolean allowed(Cell from, Cell to);

		Traversal ANY = (from, to) -> true;
	}

	@FunctionalInterface
	public interface Goal {
		boolean reached(Cell cell);
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
		return find(start, goalCell, goal, grid, Traversal.ANY, maxNodes, maxRadius);
	}

	/**
	 * Same search with a movement predicate. Keeping the overload preserves
	 * the pure grid signature for tests and callers that only need
	 * standability.
	 */
	public static Result find(
		Cell start,
		Cell goalCell,
		Goal goal,
		Grid grid,
		Traversal traversal,
		int maxNodes,
		double maxRadius
	) {
		if (maxNodes <= 0) return null;
		// The start is where the body already stands, not a cell it plans to
		// enter, so it is never rejected. Requiring it to be standable meant a
		// body on a leaf canopy, a slab, or a ledge failed every search on its
		// first check and could not take a single step: navigation froze while
		// the planner kept re-issuing goto from the same position. Every
		// neighbour still passes the standability grid, so path index zero may
		// be a non-standable cell and callers must treat it as "where we are"
		// rather than as a destination.
		if (goal.reached(start)) {
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
			if (goal.reached(current.cell)) {
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
					if (!traversal.allowed(current.cell, next)) continue;

					double moveCost =
						(direction[0] != 0 && direction[1] != 0 ? 1.414 : 1.0)
							+ (dy == 0 ? 0.0 : 0.25);
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

	/**
	 * Removes intermediate points on a straight run. The walker only needs the
	 * next corner, not every block in a corridor; feeding it dense collinear
	 * points made steering jitter and swapped sprint on and off at cell
	 * boundaries. Corners and endpoints are preserved.
	 */
	public static List<Cell> compress(List<Cell> path) {
		if (path.size() < 3) return List.copyOf(path);
		List<Cell> result = new ArrayList<>();
		result.add(path.get(0));
		for (int index = 1; index < path.size() - 1; index++) {
			Cell previous = result.get(result.size() - 1);
			Cell current = path.get(index);
			Cell next = path.get(index + 1);
			int firstX = current.x() - previous.x();
			int firstY = current.y() - previous.y();
			int firstZ = current.z() - previous.z();
			int secondX = next.x() - current.x();
			int secondY = next.y() - current.y();
			int secondZ = next.z() - current.z();
			if (
				Integer.signum(firstX) == Integer.signum(secondX)
					&& Integer.signum(firstY) == Integer.signum(secondY)
					&& Integer.signum(firstZ) == Integer.signum(secondZ)
			) {
				continue;
			}
			result.add(current);
		}
		result.add(path.get(path.size() - 1));
		return List.copyOf(result);
	}

	private static double heuristic(Cell cell, Cell goal) {
		double horizontal = Math.hypot(cell.x - goal.x, cell.z - goal.z);
		return horizontal + Math.abs(cell.y - goal.y) * 0.25;
	}

	private record OpenNode(Cell cell, double cost, double estimatedTotal, int order) {
	}
}
