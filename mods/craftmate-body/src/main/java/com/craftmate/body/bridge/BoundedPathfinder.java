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
	static final int DEFAULT_MAX_VERTICAL = 16;
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
	/**
	 * Vanilla takes no fall damage from a three-block drop, so a ledge is a
	 * legitimate move rather than a detour. Ordering the cheap vertical moves
	 * first keeps the search preferring flat ground while still letting it
	 * descend a ravine instead of reporting "no route" and walking twenty
	 * blocks around it.
	 */
	private static final int[] VERTICAL_ORDER = { 0, -1, 1, -2, -3 };

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
	 * A goal supplies both a termination predicate and an estimate of the
	 * remaining cost. Callers that only care about reaching a cell use
	 * {@link #DEFAULT}; a column or radius goal supplies its own so the search
	 * still heads toward the target instead of fanning out uniformly.
	 */
	public interface Heuristic {
		double estimate(Cell from, Cell goal);

		Heuristic DEFAULT = BoundedPathfinder::distanceHeuristic;
	}

	/**
	 * Costs one proven transition. The pathfinder never decides whether water,
	 * a drop or a block is dangerous; the caller prices those hazards and the
	 * search simply prefers the cheaper proven route.
	 */
	@FunctionalInterface
	public interface StepCost {
		double cost(Cell from, Cell to);

		StepCost DEFAULT = (from, to) ->
			(Math.abs(to.x - from.x) > 0 && Math.abs(to.z - from.z) > 0 ? 1.414 : 1.0)
				+ (to.y == from.y ? 0.0 : 0.25)
				// A fall is faster than a walk, but it should not beat a flat
				// path when both exist. The extra cost is a preference, not a
				// danger signal; callers price real hazards separately.
				+ Math.max(0, from.y - to.y) * 0.35;
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
		return find(
			start,
			goalCell,
			goal,
			grid,
			Traversal.ANY,
			maxNodes,
			maxRadius,
			DEFAULT_MAX_VERTICAL
		);
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
		return find(
			start,
			goalCell,
			goal,
			grid,
			traversal,
			StepCost.DEFAULT,
			maxNodes,
			maxRadius,
			DEFAULT_MAX_VERTICAL
		);
	}

	public static Result find(
		Cell start,
		Cell goalCell,
		Goal goal,
		Grid grid,
		Traversal traversal,
		StepCost stepCost,
		int maxNodes,
		double maxRadius
	) {
		return find(
			start,
			goalCell,
			goal,
			grid,
			traversal,
			stepCost,
			maxNodes,
			maxRadius,
			DEFAULT_MAX_VERTICAL
		);
	}

	/**
	 * A mine staircase can be dozens of blocks below the surface. The default
	 * sixteen-block vertical window made every deep return look like a dead
	 * end, so callers that know the requested height difference may widen the
	 * search. The caller still supplies a hard node budget; this parameter
	 * only prevents a legal staircase from being rejected by geometry.
	 */
	public static Result find(
		Cell start,
		Cell goalCell,
		Goal goal,
		Grid grid,
		Traversal traversal,
		int maxNodes,
		double maxRadius,
		int maxVertical
	) {
		return find(
			start,
			goalCell,
			goal,
			grid,
			traversal,
			StepCost.DEFAULT,
			maxNodes,
			maxRadius,
			maxVertical
		);
	}

	public static Result find(
		Cell start,
		Cell goalCell,
		Goal goal,
		Grid grid,
		Traversal traversal,
		StepCost stepCost,
		int maxNodes,
		double maxRadius,
		int maxVertical
	) {
		if (maxNodes <= 0) return null;
		return new Search(
			start,
			goalCell,
			goal,
			grid,
			traversal,
			stepCost,
			Heuristic.DEFAULT,
			maxNodes,
			maxRadius,
			maxVertical
		).run();
	}

	/**
	 * A resumable A* search. Each {@link #advance(int)} call expands at most
	 * `budget` nodes, so a caller can spread a long search over several client
	 * ticks instead of stalling the frame. The search only reads through the
	 * caller's grid/traversal callbacks, so it must be advanced on the thread
	 * that owns the level.
	 */
	public static final class Search {
		private final Cell start;
		private final Cell goalCell;
		private final Goal goal;
		private final Grid grid;
		private final Traversal traversal;
		private final StepCost stepCost;
		private final Heuristic heuristic;
		private final int maxNodes;
		private final int maxVertical;
		private final double maxRadius;
		private final PriorityQueue<OpenNode> open;
		private final Map<Cell, Double> bestCost = new HashMap<>();
		private final Map<Cell, Cell> parent = new HashMap<>();
		private final Set<Cell> closed = new HashSet<>();
		private Cell best;
		private double bestRemaining;
		private int expanded;
		private int order = 1;
		private Result result;
		private boolean finished;

		public Search(
			Cell start,
			Cell goalCell,
			Goal goal,
			Grid grid,
			Traversal traversal,
			StepCost stepCost,
			Heuristic heuristic,
			int maxNodes,
			double maxRadius,
			int maxVertical
		) {
			this.start = start;
			this.goalCell = goalCell;
			this.goal = goal;
			this.grid = grid;
			this.traversal = traversal;
			this.stepCost = stepCost;
			this.heuristic = heuristic;
			this.maxNodes = Math.max(1, maxNodes);
			this.maxRadius = maxRadius;
			this.maxVertical = Math.max(1, maxVertical);
			this.open = new PriorityQueue<>(
				(left, right) -> {
					int score = Double.compare(left.estimatedTotal, right.estimatedTotal);
					return score != 0 ? score : Integer.compare(left.order, right.order);
				}
			);
			this.best = start;
			this.bestRemaining = heuristic.estimate(start, goalCell);
			this.bestCost.put(start, 0.0);
			this.open.add(new OpenNode(start, 0.0, bestRemaining, 0));
			// The start is where the body already stands, not a cell it plans
			// to enter, so it is never rejected. Requiring it to be standable
			// meant a body on a leaf canopy, a slab, or a ledge failed every
			// search on its first check and could not take a single step.
			if (goal.reached(start)) {
				this.result = new Result(List.of(start), true, 1);
				this.finished = true;
			}
		}

		/** Expands at most {@code budget} nodes; null means "not finished". */
		public Result advance(int budget) {
			if (finished) return result;
			int remainingBudget = Math.max(1, budget);
			while (
				!open.isEmpty()
					&& expanded < maxNodes
					&& remainingBudget-- > 0
			) {
				OpenNode current = open.poll();
				if (!closed.add(current.cell)) continue;
				expanded++;

				double remaining = heuristic.estimate(current.cell, goalCell);
				if (remaining < bestRemaining) {
					bestRemaining = remaining;
					best = current.cell;
				}
				if (goal.reached(current.cell)) {
					result = new Result(reconstruct(parent, current.cell), true, expanded);
					finished = true;
					return result;
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
								|| Math.abs(y - start.y) > maxVertical
						) {
							continue;
						}
						if (!grid.standable(x, y, z)) continue;
						if (!traversal.allowed(current.cell, next)) continue;

						double moveCost = Math.max(
							0.01,
							stepCost.cost(current.cell, next)
						);
						double cost = current.cost + moveCost;
						Double known = bestCost.get(next);
						if (known != null && known <= cost) continue;
						bestCost.put(next, cost);
						parent.put(next, current.cell);
						open.add(
							new OpenNode(
								next,
								cost,
								cost + heuristic.estimate(next, goalCell),
								order++
							)
						);
					}
				}
			}

			if (open.isEmpty() || expanded >= maxNodes) {
				finished = true;
				if (best.equals(start)) {
					result = null;
				} else {
					result = new Result(reconstruct(parent, best), false, expanded);
				}
				return result;
			}
			return null;
		}

		/** Runs the whole search without a per-call budget. */
		public Result run() {
			while (!finished) {
				advance(maxNodes);
			}
			return result;
		}

		/** Best path found so far, even when the search is still running. */
		public Result partial() {
			if (result != null) return result;
			if (best.equals(start)) return null;
			return new Result(reconstruct(parent, best), false, expanded);
		}

		public boolean finished() {
			return finished;
		}

		public int expanded() {
			return expanded;
		}
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
					/*
					 * A staircase is not a straight walk. Compressing several
					 * one-block rises into one waypoint makes the walker aim at
					 * a cell three blocks above its head; it can only jump one
					 * block, so it wedges against the first step and reports
					 * E_STUCK. Keep enough points that every consecutive
					 * waypoint is still a legal one-block step.
					 */
					&& Math.abs(next.y() - previous.y()) <= 1
			) {
				continue;
			}
			result.add(current);
		}
		result.add(path.get(path.size() - 1));
		return List.copyOf(result);
	}

	private static double distanceHeuristic(Cell cell, Cell goal) {
		double horizontal = Math.hypot(cell.x - goal.x, cell.z - goal.z);
		return horizontal + Math.abs(cell.y - goal.y) * 0.25;
	}

	private record OpenNode(Cell cell, double cost, double estimatedTotal, int order) {
	}
}
