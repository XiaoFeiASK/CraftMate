package com.craftmate.body.bridge;

import java.util.Comparator;
import java.util.List;

/**
 * Orders valuable ores that happen to be exposed while the body is already
 * cutting a staircase or branch. The body should take one that is inside its
 * current interaction reach before moving on, rather than making the planner
 * notice it only after the camera has already passed.
 */
final class OreOpportunity {
	private OreOpportunity() {
	}

	record Candidate(int index, String id, double distanceSquared) {
	}

	static Candidate choose(List<Candidate> candidates) {
		return candidates.stream()
			.filter(candidate -> priority(candidate.id()) < 100)
			.min(
				Comparator
					.comparingInt((Candidate candidate) -> priority(candidate.id()))
					.thenComparingDouble(Candidate::distanceSquared)
			)
			.orElse(null);
	}

	/**
	 * Iron and diamond outrank fuel and decorative ores. Copper and quartz are
	 * still collected when they are directly beside the cut, but never make
	 * the body turn away from an iron face.
	 */
	static int priority(String id) {
		String family = OrePerception.family(id);
		return switch (family) {
			// Iron and diamond are both progression-critical. Equal priority
			// lets the distance tiebreak take whichever face is actually in
			// front of the body instead of always walking past a diamond face
			// to chase a common deepslate iron block.
			case "iron_ore", "diamond_ore", "ancient_debris" -> 0;
			case "emerald_ore" -> 1;
			case "gold_ore" -> 2;
			case "redstone_ore", "lapis_ore" -> 3;
			case "coal_ore" -> 4;
			case "copper_ore", "quartz_ore" -> 5;
			default -> 100;
		};
	}
}
