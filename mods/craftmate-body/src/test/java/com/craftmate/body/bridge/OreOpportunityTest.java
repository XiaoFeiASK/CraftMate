package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import org.junit.jupiter.api.Test;

class OreOpportunityTest {
	@Test
	void ironWinsOverAComparableCoalFace() {
		OreOpportunity.Candidate chosen = OreOpportunity.choose(List.of(
			new OreOpportunity.Candidate(0, "minecraft:coal_ore", 2.0),
			new OreOpportunity.Candidate(1, "minecraft:deepslate_iron_ore", 3.0)
		));
		assertEquals(1, chosen.index());
	}

	@Test
	void theNearestOreWinsWithinTheSamePriority() {
		OreOpportunity.Candidate chosen = OreOpportunity.choose(List.of(
			new OreOpportunity.Candidate(0, "minecraft:iron_ore", 8.0),
			new OreOpportunity.Candidate(1, "minecraft:deepslate_iron_ore", 2.0)
		));
		assertEquals(1, chosen.index());
	}

	@Test
	void aNearbyDiamondIsNotDeferredBehindACommonIronFace() {
		OreOpportunity.Candidate chosen = OreOpportunity.choose(List.of(
			new OreOpportunity.Candidate(0, "minecraft:deepslate_iron_ore", 6.0),
			new OreOpportunity.Candidate(1, "minecraft:diamond_ore", 2.0)
		));
		assertEquals(1, chosen.index());
	}

	@Test
	void nonOresAreNeverOpportunisticTargets() {
		assertNull(OreOpportunity.choose(List.of(
			new OreOpportunity.Candidate(0, "minecraft:stone", 1.0)
		)));
	}
}
