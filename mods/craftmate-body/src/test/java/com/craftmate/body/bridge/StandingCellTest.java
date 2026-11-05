package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class StandingCellTest {
	@Test
	void returnsTheRequestedLevelInsteadOfTheFloorBelowIt() {
		StandingCell.Column column = new StandingCell.Column() {
			@Override
			public boolean floorAt(int y) {
				return y == 64;
			}

			@Override
			public boolean headroomAt(int y) {
				return y == 64;
			}
		};
		assertEquals(64, StandingCell.firstStandable(64, 1, column));
	}

	@Test
	void allowsOneBlockStepUp() {
		StandingCell.Column column = new StandingCell.Column() {
			@Override
			public boolean floorAt(int y) {
				return y == 65;
			}

			@Override
			public boolean headroomAt(int y) {
				return y >= 65;
			}
		};
		assertEquals(65, StandingCell.firstStandable(64, 1, column));
	}

	@Test
	void reportsAGapOrWallWithoutInventingAFloor() {
		StandingCell.Column column = new StandingCell.Column() {
			@Override
			public boolean floorAt(int y) {
				return false;
			}

			@Override
			public boolean headroomAt(int y) {
				return true;
			}
		};
		assertEquals(Integer.MIN_VALUE, StandingCell.firstStandable(64, 1, column));
	}

	@Test
	void doesNotTreatTheFloorUnderThePlayerAsAStandingCell() {
		// This is the shaft case from the save: solid floor at y=62 for
		// feet y=63, free space at 63 and 64. A downward-first scan returned
		// 62 and rejected the body's own column.
		StandingCell.Column column = new StandingCell.Column() {
			@Override
			public boolean floorAt(int y) {
				return y == 63 || y == 64;
			}

			@Override
			public boolean headroomAt(int y) {
				return y >= 63;
			}
		};
		assertEquals(63, StandingCell.firstStandable(63, 1, column));
	}
}
