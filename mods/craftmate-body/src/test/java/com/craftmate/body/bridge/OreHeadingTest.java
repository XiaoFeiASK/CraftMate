package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

class OreHeadingTest {
	@Test
	void theDominantAxisPointsAtTheOre() {
		assertArrayEquals(new int[] { 1, 0 }, OreHeading.toward(10.5, 10.5, 13, 11));
		assertArrayEquals(new int[] { 0, 1 }, OreHeading.toward(10.5, 10.5, 11, 13));
		assertArrayEquals(new int[] { -1, 0 }, OreHeading.toward(10.5, 10.5, 7, 10));
		assertArrayEquals(new int[] { 0, -1 }, OreHeading.toward(10.5, 10.5, 10, 7));
	}

	@Test
	void aBodyAlreadyOnTheOreColumnHasNoHeading() {
		assertNull(OreHeading.toward(10.2, 10.4, 10, 10));
	}
}
