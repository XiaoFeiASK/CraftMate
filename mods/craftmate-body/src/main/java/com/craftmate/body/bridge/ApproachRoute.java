package com.craftmate.body.bridge;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
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
		Set<BoundedPathfinder.Cell> candidates = interactionCells(client, target);
		if (candidates.isEmpty()) return null;
		BlockPos start = client.player.blockPosition();
		BoundedPathfinder.Result found = BoundedPathfinder.find(
			new BoundedPathfinder.Cell(start.getX(), start.getY(), start.getZ()),
			new BoundedPathfinder.Cell(target.getX(), target.getY(), target.getZ()),
			(x, y, z) -> GameActions.standingY(client, new BlockPos(x, y, z)) == y,
			(x, y, z) -> candidates.contains(new BoundedPathfinder.Cell(x, y, z)),
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
				if (GameActions.standingY(client, spot) != spot.getY()) continue;
				BlockState feet = client.level.getBlockState(spot);
				if (!feet.getFluidState().isEmpty()) continue;
				if (!client.level.getBlockState(spot.above()).getFluidState().isEmpty()) continue;
				double interactionDistance = Math.sqrt(
					Math.pow(spot.getX() + 0.5 - (target.getX() + 0.5), 2)
						+ Math.pow(spot.getY() + 0.5 - (target.getY() + 0.5), 2)
						+ Math.pow(spot.getZ() + 0.5 - (target.getZ() + 0.5), 2)
				);
				if (interactionDistance > client.player.blockInteractionRange() + 0.5) continue;
				cells.add(new BoundedPathfinder.Cell(spot.getX(), spot.getY(), spot.getZ()));
			}
		}
		return cells;
	}
}
