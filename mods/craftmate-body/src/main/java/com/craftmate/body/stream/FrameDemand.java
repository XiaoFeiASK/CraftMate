package com.craftmate.body.stream;

/**
 * Set while a console is actually watching, so the render thread never pays
 * for frame readback that nobody consumes.
 */
public final class FrameDemand {
	private FrameDemand() {
	}

	private static volatile long lastRequestAt = -1L;

	public static void touch() {
		lastRequestAt = System.currentTimeMillis();
	}

	public static boolean wanted() {
		long at = lastRequestAt;
		return at >= 0L && System.currentTimeMillis() - at < 5_000L;
	}
}
