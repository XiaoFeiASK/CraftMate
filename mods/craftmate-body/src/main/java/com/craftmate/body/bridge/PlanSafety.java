package com.craftmate.body.bridge;

/**
 * A plan may be cancelled immediately for operator takeover or a reflex, but
 * a voluntary handoff must first be at a state from which the next actor can
 * take over without inheriting a fall, a burn, or a half-open workbench.
 */
final class PlanSafety {
	private PlanSafety() {
	}

	record State(
		boolean onGround,
		boolean inLava,
		boolean suffocating,
		double fallDistance,
		boolean irreversibleOpen
	) {
	}

	static boolean canCancel(State state) {
		return state != null
			&& state.onGround()
			&& !state.inLava()
			&& !state.suffocating()
			&& state.fallDistance() <= 0.5
			&& !state.irreversibleOpen();
	}

	/**
	 * A forced cancel (operator or reflex) always wins. Its result records
	 * whether the body was at a safe boundary so a bad handoff is diagnosable.
	 */
	static String cancelDetail(State state, boolean forced) {
		if (canCancel(state)) return forced ? "cancelled at a safe boundary" : "cancelled";
		return forced
			? "forced cancel before a safe boundary"
			: "cancel deferred: body is not at a safe boundary";
	}
}
