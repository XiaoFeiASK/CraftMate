package com.craftmate.body.bridge;

/**
 * Throttles the respawn packet while the death screen is still open. The
 * server owns the transition, so a packet can be lost or arrive while the
 * client is not ready. Retrying slowly is safer than either typing once and
 * hanging forever or sending every tick.
 */
final class RespawnRetry {
	static final long RETRY_MILLIS = 5_000L;

	private boolean requested;
	private long lastRequestedAt;

	boolean shouldRequest(
		boolean agentControlled,
		boolean deathScreen,
		boolean canRespawn,
		long now
	) {
		if (!agentControlled || !deathScreen || !canRespawn) {
			requested = false;
			return false;
		}
		if (requested && now - lastRequestedAt < RETRY_MILLIS) return false;
		requested = true;
		lastRequestedAt = now;
		return true;
	}

	void reset() {
		requested = false;
	}
}
