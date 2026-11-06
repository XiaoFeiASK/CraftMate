package com.craftmate.body.bridge;

/**
 * Viewer-facing brightness for the rendered world.
 *
 * <p>The body plays with normal survival lighting, but a dark cave or a
 * night-time recording is unreadable for an audience. This lifts only the
 * lightmap that the renderer samples; block data, mob spawning, vision checks
 * and every gameplay decision keep using the real light level.
 */
public final class AudienceLight {
	/**
	 * A gamma-style curve on the 0..255 lightmap channel. Values near black
	 * receive the largest lift, while full daylight remains untouched.
	 */
	private static final double LIGHT_GAMMA = 0.45;
	private static final int[] CURVE = buildCurve();

	private AudienceLight() {
	}

	/** Escape hatch for anyone who wants the raw render for a screenshot. */
	public static boolean enabled() {
		return !"false".equalsIgnoreCase(
			System.getenv().getOrDefault("CRAFTMATE_VIEWER_BRIGHTNESS", "true")
		);
	}

	public static int liftChannel(int channel) {
		return CURVE[channel & 0xFF];
	}

	/**
	 * LightTexture stores {@code 0xAABBGGRR}. Keep alpha; lift the three color
	 * bytes in place so the hue of sky light and torch light is preserved.
	 */
	public static int liftPixel(int pixel) {
		int alpha = pixel & 0xFF000000;
		int red = liftChannel(pixel);
		int green = liftChannel(pixel >>> 8);
		int blue = liftChannel(pixel >>> 16);
		return alpha | (blue << 16) | (green << 8) | red;
	}

	private static int[] buildCurve() {
		int[] curve = new int[256];
		for (int value = 0; value < curve.length; value++) {
			curve[value] = (int) Math.round(
				255.0 * Math.pow(value / 255.0, LIGHT_GAMMA)
			);
		}
		return curve;
	}
}
