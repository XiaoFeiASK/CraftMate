package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

class TrunkSelectionTest {
	@Test
	void rootWalksDownAConnectedColumn() {
		Set<BlockPos> logs = Set.of(
			new BlockPos(10, 70, -4),
			new BlockPos(10, 71, -4),
			new BlockPos(10, 72, -4)
		);
		assertEquals(
			new BlockPos(10, 70, -4),
			TrunkSelection.root(new BlockPos(10, 72, -4), logs::contains)
		);
	}

	@Test
	void rootsPreferTheLowestTreeBeforeDistance() {
		BlockPos origin = new BlockPos(0, 64, 0);
		List<BlockPos> logs = List.of(
			// A nearby canopy log at y=80.
			new BlockPos(3, 80, 0),
			new BlockPos(3, 79, 0),
			// A farther trunk whose base is on the ground.
			new BlockPos(20, 66, 0),
			new BlockPos(20, 67, 0),
			new BlockPos(20, 68, 0)
		);
		List<BlockPos> roots = TrunkSelection.roots(logs, logs::contains, origin);
		assertEquals(new BlockPos(20, 66, 0), roots.get(0));
		assertEquals(new BlockPos(3, 79, 0), roots.get(1));
	}

	@Test
	void rootsCollapseSeveralLogsFromOneTree() {
		BlockPos origin = new BlockPos(0, 64, 0);
		List<BlockPos> logs = List.of(
			new BlockPos(4, 70, 0),
			new BlockPos(4, 71, 0),
			new BlockPos(4, 72, 0)
		);
		assertEquals(
			List.of(new BlockPos(4, 70, 0)),
			TrunkSelection.roots(logs, logs::contains, origin)
		);
	}

	@Test
	void rootsCrossAnAirGapToFindTheGroundSegment() {
		BlockPos origin = new BlockPos(0, 64, 0);
		List<BlockPos> logs = List.of(
			new BlockPos(6, 78, 2),
			new BlockPos(6, 76, 2),
			// y=77 is air after an earlier chop.
			new BlockPos(6, 70, 2)
		);
		assertEquals(
			List.of(new BlockPos(6, 70, 2)),
			TrunkSelection.roots(logs, logs::contains, origin)
		);
	}
}
