package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

class StarterHutTest {
	@Test
	void buildsASeventyOneCellFiveByFiveStarterHut() {
		BlockPos origin = new BlockPos(10, 64, -5);
		List<BlockPos> cells = GameActions.starterHutCells(origin);

		assertEquals(71, cells.size());
		assertEquals(cells.size(), new HashSet<>(cells).size());
		for (BlockPos cell : cells) {
			assertTrue(Math.abs(cell.getX() - origin.getX()) <= 2);
			assertTrue(Math.abs(cell.getZ() - origin.getZ()) <= 2);
			assertTrue(cell.getY() >= origin.getY());
			assertTrue(cell.getY() <= origin.getY() + 3);
		}
	}

	@Test
	void leavesATwoBlockDoorwayAndCoversTheInteriorWithARoof() {
		BlockPos origin = new BlockPos(10, 64, -5);
		Set<BlockPos> cells = new HashSet<>(GameActions.starterHutCells(origin));

		assertFalse(cells.contains(origin.offset(2, 0, 0)));
		assertFalse(cells.contains(origin.offset(2, 1, 0)));
		assertTrue(cells.contains(origin.offset(2, 2, 0)));
		assertFalse(cells.contains(origin));
		assertTrue(cells.contains(origin.offset(0, 3, 0)));
		for (int x = -2; x <= 2; x++) {
			for (int z = -2; z <= 2; z++) {
				assertTrue(cells.contains(origin.offset(x, 3, z)));
			}
		}
	}
}
