package com.craftmate.body.bridge;

/**
 * Session facts describe what this body has already done. They survive a
 * reconnect in the same world, but not a death: the respawned body has lost
 * the food it carried and cannot rely on a meal eaten before dying.
 */
final class SessionFacts {
	private SessionFacts() {
	}

	static boolean resetConsumables(boolean alive, boolean samePlayer) {
		return !alive || !samePlayer;
	}
}
