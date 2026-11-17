package com.craftmate.body.bridge;

/**
 * A navigation target is a region plus a distance estimate, not just a cell.
 * "Reach the village gate", "get within two blocks of this chest" and "walk to
 * that column" share one search but differ only in what counts as arrival.
 *
 * <p>The body still plans cell by cell; the goal only decides when the search
 * may stop and which direction looks promising. This mirrors the goal concept
 * proven by Baritone without its process/strategy layer.
 */
final class NavGoal {
	enum Kind {
		POINT,
		NEAR,
		COLUMN,
	}

	private final Kind kind;
	private final BoundedPathfinder.Cell centre;
	private final int radius;

	private NavGoal(Kind kind, BoundedPathfinder.Cell centre, int radius) {
		this.kind = kind;
		this.centre = centre;
		this.radius = Math.max(0, radius);
	}

	static NavGoal point(BoundedPathfinder.Cell cell) {
		return new NavGoal(Kind.POINT, cell, 0);
	}

	static NavGoal near(BoundedPathfinder.Cell cell, int radius) {
		int bounded = Math.max(0, Math.min(8, radius));
		return new NavGoal(bounded == 0 ? Kind.POINT : Kind.NEAR, cell, bounded);
	}

	static NavGoal column(BoundedPathfinder.Cell cell, int radius) {
		return new NavGoal(Kind.COLUMN, cell, Math.max(1, Math.min(8, radius)));
	}

	Kind kind() {
		return kind;
	}

	BoundedPathfinder.Cell centre() {
		return centre;
	}

	boolean reached(BoundedPathfinder.Cell cell) {
		int horizontal = Math.max(
			Math.abs(cell.x() - centre.x()),
			Math.abs(cell.z() - centre.z())
		);
		if (horizontal > radius) return false;
		return kind == Kind.COLUMN || Math.abs(cell.y() - centre.y()) <= 1;
	}

	/**
	 * Remaining cost in the pathfinder's own units. Inside the radius the
	 * estimate is only the height difference, so a flat approach does not keep
	 * pushing toward the centre cell after arrival is already satisfied.
	 */
	double estimate(BoundedPathfinder.Cell cell) {
		double horizontal = Math.hypot(
			cell.x() - centre.x(),
			cell.z() - centre.z()
		);
		double outside = Math.max(0.0, horizontal - radius);
		double vertical = kind == Kind.COLUMN
			? 0.0
			: Math.abs(cell.y() - centre.y()) * 0.25;
		return outside + vertical;
	}
}
