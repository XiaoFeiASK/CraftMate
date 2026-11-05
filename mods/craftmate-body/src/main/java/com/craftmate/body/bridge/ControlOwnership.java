package com.craftmate.body.bridge;

/**
 * The body's local mirror of the server's ownership. The server is the only
 * authority that may grant or revoke agent control; the client only stores it.
 */
final class ControlOwnership {
	private boolean agentControlled;

	boolean agentControlled() {
		return agentControlled;
	}

	/**
	 * Apply an owner received from the server. Unknown values are rejected
	 * instead of being coerced to "not agent": a schema mistake must be visible
	 * in the log, not silently disable the body.
	 */
	void applyServerOwner(String owner) {
		switch (owner) {
			case "agent" -> agentControlled = true;
			case "operator", "none" -> agentControlled = false;
			default -> throw new IllegalArgumentException("unknown ownership " + owner);
		}
	}

	/**
	 * A local watchdog may only release inputs. It must not revoke the
	 * authoritative permission, because the next server frame still says
	 * "agent" and would otherwise never restore execution after a stall.
	 */
	void onLocalWatchdog() {
		// Intentionally does not change agentControlled.
	}
}
