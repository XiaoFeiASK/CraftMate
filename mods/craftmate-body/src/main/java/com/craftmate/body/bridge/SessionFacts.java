package com.craftmate.body.bridge;

/**
 * Session facts describe what this body has already done. They survive a
 * reconnect in the same world, but not a death: meal progress belongs to the
 * current life even when keepInventory lets the respawned body keep its food.
 */
final class SessionFacts {
	private SessionFacts() {
	}

	static boolean resetConsumables(boolean alive, boolean samePlayer) {
		return !alive || !samePlayer;
	}
}
