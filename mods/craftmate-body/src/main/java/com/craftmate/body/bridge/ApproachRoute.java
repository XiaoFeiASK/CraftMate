package com.craftmate.body.bridge;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import com.craftmate.body.CraftMateBodyClient;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/**
 * Chooses a standable cell adjacent to a target block and a bounded route to
 * it. The interaction cell is checked with the same collision, headroom and
 * fluid rules as movement, so "visible across a ravine" cannot become a
 * mining destination.
 */
final class ApproachRoute {
	private static final int MAX_NODES = 3_000;
	private static final double MAX_RADIUS = 56.0;

	private ApproachRoute() {
	}

	record Route(List<Vec3> waypoints, Vec3 destination, boolean complete) {
	}

	static Route to(Minecraft client, BlockPos target) {
		Set<BoundedPathfinder.Cell> candidates = new HashSet<>(
			openInteractionCells(client, target)
		);
		if (candidates.isEmpty()) return null;
		BlockPos start = client.player.blockPosition();
		BoundedPathfinder.Result found = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(start.getX(), start.getY(), start.getZ()),
			new BoundedPathfinder.Cell(target.getX(), target.getY(), target.getZ()),
			(cell) -> candidates.contains(cell),
			(x, y, z) -> GameActions.standableAt(client, new BlockPos(x, y, z)),
			GameActions.traversal(client),
			MAX_NODES,
			MAX_RADIUS
		);
		if (found == null) return null;
		List<Vec3> points = new ArrayList<>();
		for (BoundedPathfinder.Cell cell : found.path()) {
			points.add(new Vec3(cell.x() + 0.5, cell.y(), cell.z() + 0.5));
		}
		Vec3 destination = points.get(points.size() - 1);
		return new Route(points, destination, found.complete());
	}

	/**
	 * Entities move while the body walks, so a route cannot end on the
	 * animal's own cell (it is not even standable). Any standing cell within
	 * a couple of blocks is a valid attack position; using that as the A*
	 * goal lets the search reach a distant animal instead of exhausting its
	 * node budget on the exact centre and falling back to a straight line.
	 */
	static Route toEntity(
		Minecraft client,
		Vec3 target,
		int maxNodes,
		double maxRadius
	) {
		BlockPos center = BlockPos.containing(target);
		BlockPos start = client.player.blockPosition();
		BoundedPathfinder.Result found = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(start.getX(), start.getY(), start.getZ()),
			new BoundedPathfinder.Cell(center.getX(), center.getY(), center.getZ()),
			(cell) -> withinEntityReach(center, cell.x(), cell.y(), cell.z()),
			(x, y, z) -> GameActions.standableAt(client, new BlockPos(x, y, z)),
			GameActions.traversal(client),
			maxNodes,
			maxRadius
		);
		if (found == null) {
			CraftMateBodyClient.LOGGER.info(
				"no approach route start={},{},{} target={},{},{} radius={} nodes={}",
				start.getX(), start.getY(), start.getZ(),
				center.getX(), center.getY(), center.getZ(),
				maxRadius, maxNodes
			);
			return null;
		}
		// A partial route ends on the closest cell the budget could reach,
		// not on an attack position. Returning it made the approach walk
		// straight at an animal it had not actually found a way to reach.
		if (!found.complete()) {
			CraftMateBodyClient.LOGGER.info(
				"partial approach route start={},{},{} target={},{},{} expanded={} last={},{},{}",
				start.getX(), start.getY(), start.getZ(),
				center.getX(), center.getY(), center.getZ(),
				found.expanded(),
				found.path().get(found.path().size() - 1).x(),
				found.path().get(found.path().size() - 1).y(),
				found.path().get(found.path().size() - 1).z()
			);
			return null;
		}
		List<Vec3> points = new ArrayList<>();
		for (BoundedPathfinder.Cell cell : found.path()) {
			points.add(new Vec3(cell.x() + 0.5, cell.y(), cell.z() + 0.5));
		}
		Vec3 destination = points.get(points.size() - 1);
		return new Route(points, destination, found.complete());
	}

	/**
	 * A mob's hitbox is taller than a block, so a two-block vertical window
	 * keeps the feet at head or hoof level while the horizontal bound is the
	 * attack range. This is a pure predicate so the geometry is unit tested.
	 */
	static boolean withinEntityReach(BlockPos center, int x, int y, int z) {
		double horizontal = Math.hypot(x - center.getX(), z - center.getZ());
		return horizontal <= ENTITY_ATTACK_RADIUS
			&& y >= center.getY() - 1
			&& y <= center.getY() + 1;
	}

	/**
	 * A route that cannot reach an attack position must not be used to
	 * steer movement. The old code fell back to walking in a straight line
	 * at the animal, which walked into terrain and never shortened the
	 * distance while still reporting progress ticks.
	 */
	static boolean usableForApproach(Route route) {
		return route != null && route.complete() && !route.waypoints().isEmpty();
	}

	static final double ENTITY_ATTACK_RADIUS = 2.5;

	/**
	 * A trunk often has no standable cardinal neighbour because the canopy or
	 * a slope covers it, yet a diagonal cell can still see and reach the log.
	 * Vanilla uses the player's eye-to-block interaction distance, not a
	 * cardinal adjacency rule. Consider all eight horizontal cells and accept
	 * the best route to any cell that can actually target the block.
	 */
	static Route nearestReachable(
		Minecraft client,
		BlockPos target,
		int maxNodes,
		double maxRadius
	) {
		BlockPos start = client.player.blockPosition();
		List<BoundedPathfinder.Cell> candidates = openInteractionCells(client, target);
		if (candidates.isEmpty()) {
			return null;
		}
		BoundedPathfinder.Cell startCell = new BoundedPathfinder.Cell(
			start.getX(),
			start.getY(),
			start.getZ()
		);
		candidates.sort(
			Comparator.comparingDouble(
				cell -> Math.hypot(cell.x() - startCell.x(), cell.z() - startCell.z())
			)
		);
		for (BoundedPathfinder.Cell cell : candidates) {
			if (
				Math.hypot(cell.x() - startCell.x(), cell.z() - startCell.z()) > maxRadius
					|| Math.abs(cell.y() - startCell.y()) > 8
			) continue;
			BoundedPathfinder.Result found = BoundedPathfinder.find(
				startCell,
				new BoundedPathfinder.Cell(target.getX(), target.getY(), target.getZ()),
				(candidate) -> candidate.equals(cell),
				(x, y, z) -> GameActions.standableAt(client, new BlockPos(x, y, z)),
				GameActions.traversal(client),
				maxNodes,
				maxRadius
			);
			if (found == null || !found.complete()) continue;
			List<Vec3> points = new ArrayList<>();
			for (BoundedPathfinder.Cell point : found.path()) {
				points.add(new Vec3(point.x() + 0.5, point.y(), point.z() + 0.5));
			}
			return new Route(points, points.get(points.size() - 1), true);
		}
		return null;
	}

	/**
	 * A* treats every safe interaction cell as a goal, so it can choose the
	 * cheapest walk instead of failing on the nearest-but-unreachable cell.
	 */
	static Set<BoundedPathfinder.Cell> interactionCells(Minecraft client, BlockPos target) {
		Set<BoundedPathfinder.Cell> cells = new HashSet<>();
		// A log's usable face can be one block above or below its centre. Look
		// at all neighbouring cells rather than only its own feet level.
		for (int dy = -1; dy <= 1; dy++) {
			BlockPos level = target.above(dy);
			for (Direction direction : Direction.Plane.HORIZONTAL) {
				BlockPos spot = level.relative(direction);
				if (!GameActions.standableAt(client, spot)) continue;
				BlockState feet = client.level.getBlockState(spot);
				if (!feet.getFluidState().isEmpty()) continue;
				if (!client.level.getBlockState(spot.above()).getFluidState().isEmpty()) continue;
				double interactionDistance = Math.sqrt(
					Math.pow(spot.getX() + 0.5 - (target.getX() + 0.5), 2)
						+ Math.pow(spot.getY() + 0.5 - (target.getY() + 0.5), 2)
						+ Math.pow(spot.getZ() + 0.5 - (target.getZ() + 0.5), 2)
				);
				if (interactionDistance > 4.5 + 0.5) continue;
				cells.add(new BoundedPathfinder.Cell(spot.getX(), spot.getY(), spot.getZ()));
			}
		}
		return cells;
	}

	/**
	 * Interaction candidates are not limited to cardinal neighbours. For a
	 * log above the player, a diagonal cell at the same level can be within
	 * the body's block interaction range and have a clear face, while the
	 * four cardinal cells are leaves or a vertical wall.
	 */
	static List<BoundedPathfinder.Cell> openInteractionCells(
		Minecraft client,
		BlockPos target
	) {
		List<BoundedPathfinder.Cell> cells = new ArrayList<>();
		// A tree's lowest log can sit several blocks above the player when the
		// trunk starts on a slope. Cover the standable ground under that
		// column instead of only the log's own three-block band.
		for (int dy = -4; dy <= 2; dy++) {
			for (int dx = -2; dx <= 2; dx++) {
				for (int dz = -2; dz <= 2; dz++) {
					if (dx == 0 && dz == 0 && dy == 0) continue;
					BlockPos spot = target.offset(dx, dy, dz);
					if (!GameActions.standableAt(client, spot)) continue;
					BlockState feet = client.level.getBlockState(spot);
					if (!feet.getFluidState().isEmpty()) continue;
					if (!client.level.getBlockState(spot.above()).getFluidState().isEmpty()) continue;
					if (!canTargetFrom(client, spot, target)) continue;
					cells.add(new BoundedPathfinder.Cell(spot.getX(), spot.getY(), spot.getZ()));
				}
			}
		}
		return cells;
	}

	private static boolean canTargetFrom(Minecraft client, BlockPos spot, BlockPos target) {
		Vec3 eye = new Vec3(
			spot.getX() + 0.5,
			spot.getY() + client.player.getEyeHeight(),
			spot.getZ() + 0.5
		);
		// A block is hittable on any visible face, not only through its
		// centre. A tall trunk's centre can be outside reach while its lower
		// face is a normal ground-level hit; probing the centre made every
		// tall tree look unreachable even from its base.
		for (double y : new double[] { 0.2, 0.5, 0.8 }) {
			if (InteractionReach.withinReach(
				eye.x, spot.getY(), eye.z, client.player.getEyeHeight(),
				target.getX() + 0.5, target.getY() + y, target.getZ() + 0.5, 4.5
			)) {
				return true;
			}
		}
		return false;
	}

}
