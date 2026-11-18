package com.craftmate.body.bridge;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/** Selects the first solid block in front of several points on the body. */
public final class OcclusionProbe {
	private OcclusionProbe() {
	}

	public record Result(List<BlockPos> blocks) {
		public boolean occluded() {
			return !blocks.isEmpty();
		}
	}

	public static Result probe(
		Vec3 camera,
		AABB body,
		Predicate<BlockPos> solid,
		int cap
	) {
		return probe(camera, body, solid, cap, BlockPos.containing(camera));
	}

	/**
	 * The camera can sit inside a wall so the observation distance never
	 * collapses. Its own cell is not an occluder: the inside faces are
	 * back-facing and the first block beyond it is the one the viewer should
	 * see through.
	 */
	public static Result probe(
		Vec3 camera,
		AABB body,
		Predicate<BlockPos> solid,
		int cap,
		BlockPos ignored
	) {
		int limit = cap <= 0 ? 24 : cap;
		Set<BlockPos> found = new LinkedHashSet<>();
		Predicate<BlockPos> occluder = pos -> !pos.equals(ignored) && solid.test(pos);
		for (Vec3 sample : samples(body)) {
			BlockPos hit = VoxelRay.firstSolid(camera, sample, occluder);
			if (hit == null) continue;
			found.add(hit);
			if (found.size() >= limit) break;
		}
		return new Result(List.copyOf(found));
	}

	public static List<Vec3> samples(AABB body) {
		double centreX = (body.minX + body.maxX) * 0.5;
		double centreY = (body.minY + body.maxY) * 0.5;
		double centreZ = (body.minZ + body.maxZ) * 0.5;
		double halfWidth = Math.max(0.05, (body.maxX - body.minX) * 0.5 - 0.08);
		double lowerY = body.minY + 0.35;
		double upperY = body.maxY - 0.35;
		List<Vec3> samples = new ArrayList<>(9);
		samples.add(new Vec3(centreX, centreY, centreZ));
		samples.add(new Vec3(centreX - halfWidth, centreY, centreZ));
		samples.add(new Vec3(centreX + halfWidth, centreY, centreZ));
		samples.add(new Vec3(centreX - halfWidth, lowerY, centreZ));
		samples.add(new Vec3(centreX + halfWidth, lowerY, centreZ));
		samples.add(new Vec3(centreX - halfWidth, upperY, centreZ));
		samples.add(new Vec3(centreX + halfWidth, upperY, centreZ));
		samples.add(new Vec3(centreX, body.maxY - 0.15, centreZ));
		samples.add(new Vec3(centreX, body.minY + 0.2, centreZ));
		return samples;
	}
}
