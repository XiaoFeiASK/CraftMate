package com.craftmate.body.bridge;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.VoxelShape;

/**
 * Builds the hit packet for a known block without routing the action through
 * the camera crosshair. The body plans with coordinates and reach; rotation
 * is only an audience-facing presentation concern.
 */
final class BlockInteraction {
	private static final double FACE_INSET = 0.02;
	/**
	 * A tunnel wall exposes only part of an ore face: the centre ray can clip
	 * the corner of the stair above it while the lower half is plainly
	 * visible. Sampling the face instead of trusting one point keeps a close
	 * ore from being labelled "encased" or "not visible" in exactly the
	 * vertical shafts the body mines.
	 */
	private static final double[] FACE_SAMPLES = { 0.18, 0.5, 0.82 };

	private BlockInteraction() {
	}

	static Vec3 point(Vec3 eye, BlockPos target) {
		double cx = target.getX() + 0.5;
		double cy = target.getY() + 0.5;
		double cz = target.getZ() + 0.5;
		double dx = eye.x - cx;
		double dy = eye.y - cy;
		double dz = eye.z - cz;
		double ax = Math.abs(dx);
		double ay = Math.abs(dy);
		double az = Math.abs(dz);
		if (ay >= ax && ay >= az) {
			return new Vec3(
				cx,
				dy >= 0 ? target.getY() + 1.0 - FACE_INSET : target.getY() + FACE_INSET,
				cz
			);
		}
		if (ax >= az) {
			return new Vec3(
				dx >= 0 ? target.getX() + 1.0 - FACE_INSET : target.getX() + FACE_INSET,
				cy,
				cz
			);
		}
		return new Vec3(
			cx,
			cy,
			dz >= 0 ? target.getZ() + 1.0 - FACE_INSET : target.getZ() + FACE_INSET
		);
	}

	/** A ready-to-send hit on the face nearest the eye. */
	static BlockHitResult hit(Vec3 eye, BlockPos target) {
		Vec3 point = point(eye, target);
		return new BlockHitResult(point, face(point, target), target, false);
	}

	/** A hit whose face is selected by the caller, used for placement. */
	static BlockHitResult hit(BlockPos target, Direction face) {
		return new BlockHitResult(facePoint(target, face), face, target, false);
	}

	/**
	 * Prefer an exposed face nearest the eye. This keeps synthetic mining and
	 * interaction packets grounded in the block's actual geometry instead of
	 * the direction the rendered camera happens to be pointing.
	 */
	static BlockHitResult nearestExposedHit(
		net.minecraft.world.level.BlockGetter level,
		Vec3 eye,
		BlockPos target
	) {
		Direction best = nearestExposedFace(level, eye, target);
		if (best != null) return hit(target, best);
		return hit(eye, target);
	}

	/**
	 * Prefer an exposed face whose click point is actually visible from the
	 * eye. Adjacency alone is not enough: a chest embedded in a wall can have
	 * its bottom face open while the chest itself hides that face from the
	 * player. Clicking the hidden face sends a use packet the server accepts,
	 * but the body then stands there reporting that no container screen ever
	 * opened.
	 */
	static BlockHitResult visibleExposedHit(
		net.minecraft.world.level.BlockGetter level,
		Entity viewer,
		Vec3 eye,
		BlockPos target
	) {
		BlockHitResult visible = visibleExposedSample(level, viewer, eye, target);
		if (visible != null) return visible;
		return nearestExposedHit(level, eye, target);
	}

	/**
	 * Returns an exposed face whose click point is visible from the eye, or
	 * null when every exposed point is behind terrain. Adjacency and a centre
	 * ray are both insufficient for a block with several faces.
	 */
	static Direction visibleExposedFace(
		net.minecraft.world.level.BlockGetter level,
		Entity viewer,
		Vec3 eye,
		BlockPos target
	) {
		BlockHitResult visible = visibleExposedSample(level, viewer, eye, target);
		return visible == null ? null : visible.getDirection();
	}

	private static BlockHitResult visibleExposedSample(
		net.minecraft.world.level.BlockGetter level,
		Entity viewer,
		Vec3 eye,
		BlockPos target
	) {
		BlockHitResult visible = null;
		double bestDistance = Double.POSITIVE_INFINITY;
		for (Direction direction : Direction.values()) {
			BlockPos neighbour = target.relative(direction);
			if (!openForInteraction(level.getBlockState(neighbour))) continue;
			for (double u : FACE_SAMPLES) {
				for (double v : FACE_SAMPLES) {
					Vec3 point = faceSample(target, direction, u, v);
					BlockHitResult clip = clip(level, viewer, eye, point);
					/*
					 * Any hit on the target proves that a point of this
					 * exposed block is visible. The returned hit carries the
					 * face the ray actually entered, so callers never send a
					 * synthetic hit for the hidden sample point.
					 */
					if (
						clip.getType() != net.minecraft.world.phys.HitResult.Type.BLOCK ||
						!clip.getBlockPos().equals(target)
					) {
						continue;
					}
					double distance = eye.distanceToSqr(point);
					if (distance < bestDistance) {
						bestDistance = distance;
						visible = clip;
					}
				}
			}
		}
		return visible;
	}

	private static BlockHitResult clip(
		net.minecraft.world.level.BlockGetter level,
		Entity viewer,
		Vec3 from,
		Vec3 to
	) {
		CollisionContext context =
			viewer == null ? CollisionContext.empty() : CollisionContext.of(viewer);
		return net.minecraft.world.level.BlockGetter.traverseBlocks(
			from,
			to,
			context,
			(collision, pos) -> {
				BlockState state = level.getBlockState(pos);
				VoxelShape shape = ClipContext.Block.VISUAL.get(
					state,
					level,
					pos,
					collision
				);
				return shape.isEmpty() ? null : shape.clip(from, to, pos);
			},
			collision -> BlockHitResult.miss(
				to,
				Direction.UP,
				BlockPos.containing(to)
			)
		);
	}

	static Direction nearestExposedFace(
		net.minecraft.world.level.BlockGetter level,
		Vec3 eye,
		BlockPos target
	) {
		Direction best = null;
		double bestDistance = Double.POSITIVE_INFINITY;
		for (Direction direction : Direction.values()) {
			BlockPos neighbour = target.relative(direction);
			if (!openForInteraction(level.getBlockState(neighbour))) continue;
			double distance = eye.distanceToSqr(facePoint(target, direction));
			if (distance < bestDistance) {
				bestDistance = distance;
				best = direction;
			}
		}
		return best;
	}

	static boolean hasExposedFace(Level level, BlockPos target) {
		for (Direction direction : Direction.values()) {
			if (openForInteraction(level.getBlockState(target.relative(direction)))) return true;
		}
		return false;
	}

	static boolean openForInteraction(BlockState state) {
		/*
		 * Leaves block the eye ray even though they do not block movement.
		 * Treating them as an open face made an escape task target the top
		 * face of a leaf that had another leaf above it; every synthetic
		 * destroy packet was rejected and the body stood under the tree for
		 * fifteen seconds per retry. A player must clear the outer leaf first,
		 * so interaction geometry has to use the same rule.
		 */
		return !state.blocksMotion();
	}

	static Direction face(Vec3 point, BlockPos target) {
		if (point.y >= target.getY() + 0.9) return Direction.UP;
		if (point.y <= target.getY() + 0.1) return Direction.DOWN;
		if (point.x >= target.getX() + 0.9) return Direction.EAST;
		if (point.x <= target.getX() + 0.1) return Direction.WEST;
		if (point.z >= target.getZ() + 0.9) return Direction.SOUTH;
		return Direction.NORTH;
	}

	static Vec3 facePoint(BlockPos target, Direction face) {
		return faceSample(target, face, 0.5, 0.5);
	}

	private static Vec3 faceSample(
		BlockPos target,
		Direction face,
		double u,
		double v
	) {
		return switch (face) {
			case UP -> new Vec3(
				target.getX() + u,
				target.getY() + 1.0 - FACE_INSET,
				target.getZ() + v
			);
			case DOWN -> new Vec3(
				target.getX() + u,
				target.getY() + FACE_INSET,
				target.getZ() + v
			);
			case EAST -> new Vec3(
				target.getX() + 1.0 - FACE_INSET,
				target.getY() + u,
				target.getZ() + v
			);
			case WEST -> new Vec3(
				target.getX() + FACE_INSET,
				target.getY() + u,
				target.getZ() + v
			);
			case SOUTH -> new Vec3(
				target.getX() + u,
				target.getY() + v,
				target.getZ() + 1.0 - FACE_INSET
			);
			case NORTH -> new Vec3(
				target.getX() + u,
				target.getY() + v,
				target.getZ() + FACE_INSET
			);
		};
	}
}
