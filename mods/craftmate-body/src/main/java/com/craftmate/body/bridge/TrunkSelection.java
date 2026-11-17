package com.craftmate.body.bridge;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;

/**
 * Chopping the top of a trunk is a common way to lose the logs: the drop
 * lands on leaves and the body cannot reach it from a safe standing cell.
 * A player chops the lowest exposed log first, so the drop falls beside the
 * feet. These helpers keep that ordering independent of distance.
 */
final class TrunkSelection {
	private static final int MAX_TRUNK_DEPTH = 48;

	private TrunkSelection() {
	}

	/** Lowest connected log in the same vertical column. */
	static BlockPos root(BlockPos log, Predicate<BlockPos> isLog) {
		BlockPos current = log;
		for (int depth = 0; depth < MAX_TRUNK_DEPTH; depth++) {
			BlockPos below = current.below();
			if (!isLog.test(below)) break;
			current = below;
		}
		return current;
	}

	/**
	 * Unique trunk columns, lowest log first. A felled or naturally broken
	 * trunk can have an air gap between two log segments; walking only the
	 * contiguous column selected the upper segment and repeated the canopy
	 * drop failure. Grouping by x/z and taking the minimum y reaches the
	 * ground segment directly. Distance only breaks ties between trees at
	 * the same height.
	 */
	static List<BlockPos> roots(
		Collection<BlockPos> logs,
		Predicate<BlockPos> isLog,
		BlockPos origin
	) {
		Map<Long, BlockPos> lowestByColumn = new LinkedHashMap<>();
		for (BlockPos log : logs) {
			long column = ((long) log.getX() << 32) ^ (log.getZ() & 0xffffffffL);
			BlockPos existing = lowestByColumn.get(column);
			if (existing == null || log.getY() < existing.getY()) {
				lowestByColumn.put(column, log);
			}
		}
		List<BlockPos> ordered = new ArrayList<>(lowestByColumn.values());
		ordered.sort(
			Comparator.comparingInt((BlockPos root) -> root.getY())
				.thenComparingDouble(root -> root.distSqr(origin))
		);
		return ordered;
	}
}
