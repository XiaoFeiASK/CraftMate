package com.craftmate.body.bridge;

/**
 * Sleeping is proven by the player's own state, not by the fact that a click
 * was submitted. These comparisons keep the preconditions and the wake-up
 * evidence testable without a live client.
 */
final class SleepEvidence {
	private SleepEvidence() {
	}

	/**
	 * The reason a sleep request cannot do anything useful in the current
	 * world. Order matters: exploding beds are refused before any interaction
	 * could destroy the bed and hurt the body.
	 */
	static String blockedReason(
		boolean alreadySleeping,
		boolean bedFound,
		boolean occupied,
		boolean explodes,
		boolean canSleep
	) {
		if (alreadySleeping) return "player is already sleeping";
		if (!bedFound) return "no bed within 16 blocks";
		if (explodes) return "beds explode in this dimension";
		if (occupied) return "the bed is occupied";
		if (!canSleep) return "it is not night or a thunderstorm";
		return null;
	}

	/** Sleeping through a night advances the world day counter. */
	static boolean nextDayReached(int dayBefore, int dayAfter) {
		return dayAfter > dayBefore;
	}
}
