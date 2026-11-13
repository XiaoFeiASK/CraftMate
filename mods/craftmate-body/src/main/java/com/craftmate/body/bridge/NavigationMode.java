package com.craftmate.body.bridge;

/**
 * Navigation authority for a single goto command.
 *
 * <p>Walking is deliberately non-destructive. Digging and recovery are
 * explicit escalation modes chosen by the planner, never by the walker after
 * an A* failure.
 */
enum NavigationMode {
	WALK("walk"),
	DIG("dig"),
	RECOVER("recover");

	private final String wireName;

	NavigationMode(String wireName) {
		this.wireName = wireName;
	}

	String wireName() {
		return wireName;
	}

	boolean mayDig() {
		return this != WALK;
	}

	boolean mayBuild() {
		return this == RECOVER;
	}

	boolean isWalk() {
		return this == WALK;
	}

	static NavigationMode parse(String value) {
		if (value == null || value.isBlank() || "walk".equalsIgnoreCase(value)) {
			return WALK;
		}
		if ("dig".equalsIgnoreCase(value)) return DIG;
		if ("recover".equalsIgnoreCase(value)) return RECOVER;
		throw new IllegalArgumentException("unknown goto mode " + value);
	}
}
