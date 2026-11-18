package com.craftmate.body.bridge;

import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;

/** Small pure voxel walker used by camera clearance and occlusion probes. */
public final class VoxelRay {
	private VoxelRay() {
	}

	public static BlockPos firstSolid(Vec3 from, Vec3 to, Predicate<BlockPos> solid) {
		double dx = to.x - from.x;
		double dy = to.y - from.y;
		double dz = to.z - from.z;
		if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1.0e-9) {
			BlockPos start = BlockPos.containing(from);
			return solid.test(start) ? start : null;
		}
		int x = floor(from.x);
		int y = floor(from.y);
		int z = floor(from.z);
		int stepX = dx > 0.0 ? 1 : dx < 0.0 ? -1 : 0;
		int stepY = dy > 0.0 ? 1 : dy < 0.0 ? -1 : 0;
		int stepZ = dz > 0.0 ? 1 : dz < 0.0 ? -1 : 0;
		double deltaX = stepX == 0 ? Double.POSITIVE_INFINITY : Math.abs(1.0 / dx);
		double deltaY = stepY == 0 ? Double.POSITIVE_INFINITY : Math.abs(1.0 / dy);
		double deltaZ = stepZ == 0 ? Double.POSITIVE_INFINITY : Math.abs(1.0 / dz);
		double maxX = boundary(from.x, x, stepX, dx);
		double maxY = boundary(from.y, y, stepY, dy);
		double maxZ = boundary(from.z, z, stepZ, dz);
		if (solid.test(new BlockPos(x, y, z))) return new BlockPos(x, y, z);
		for (int guard = 0; guard < 512; guard++) {
			double next = Math.min(maxX, Math.min(maxY, maxZ));
			if (next > 1.0) return null;
			if (maxX == next) {
				x += stepX;
				maxX += deltaX;
			}
			if (maxY == next) {
				y += stepY;
				maxY += deltaY;
			}
			if (maxZ == next) {
				z += stepZ;
				maxZ += deltaZ;
			}
			BlockPos position = new BlockPos(x, y, z);
			if (solid.test(position)) return position;
		}
		return null;
	}

	private static double boundary(double from, int cell, int step, double delta) {
		if (step == 0) return Double.POSITIVE_INFINITY;
		if (step > 0) return (cell + 1.0 - from) / delta;
		return (cell - from) / delta;
	}

	private static int floor(double value) {
		int whole = (int) value;
		return value < whole ? whole - 1 : whole;
	}
}
