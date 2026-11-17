package com.craftmate.body.bridge;

/**
 * Pure ore naming and diagnostic rules. The body uses the same family rule for
 * target selection and observation reporting so a request for iron ore can
 * match both the stone and deepslate variants.
 */
final class OrePerception {
	static final String NOT_OBSERVED = "NOT_OBSERVED";
	static final String OBSERVED_NOT_PLANNED = "OBSERVED_NOT_PLANNED";
	static final String CANDIDATE_READY = "CANDIDATE_READY";

	private OrePerception() {
	}

	static boolean isOreId(String id) {
		return id != null
			&& (id.endsWith("_ore") || id.equals("minecraft:ancient_debris"));
	}

	/**
	 * Variant-free ore family: `deepslate_iron_ore` and `iron_ore` are the same
	 * resource for planning. Other prefixes keep their own family.
	 */
	static String family(String id) {
		if (id == null) return "";
		String shortId = id.startsWith("minecraft:") ? id.substring("minecraft:".length()) : id;
		if (shortId.startsWith("deepslate_")) {
			return shortId.substring("deepslate_".length());
		}
		return shortId;
	}

	static boolean matches(String requested, String observed) {
		return isOreId(requested)
			&& isOreId(observed)
			&& family(requested).equals(family(observed));
	}

	/**
	 * A survey only satisfies the state a guard actually asked for. Treating
	 * "visible" as "reachable" made a plan start a mine it could never walk to.
	 */
	static boolean satisfies(boolean visible, boolean reachable, String state) {
		return switch (state) {
			case "observed" -> true;
			case "visible" -> visible;
			case "reachable" -> reachable;
			default -> false;
		};
	}

	/**
	 * Reports the first broken link in the observation chain instead of
	 * pretending that "not selectable" means "not present".
	 */
	static String status(int observed, int exposed, int visible, int reachable) {
		if (observed <= 0) return NOT_OBSERVED;
		if (exposed <= 0) return OBSERVED_NOT_PLANNED;
		if (reachable <= 0) return OBSERVED_NOT_PLANNED;
		return CANDIDATE_READY;
	}

	static String reason(int observed, int exposed, int visible, int reachable) {
		if (observed <= 0) return "no ore of the requested family was observed";
		if (exposed <= 0) return "observed ore is fully encased; no exposed face";
		if (reachable <= 0) {
			return visible <= 0
				? "observed exposed faces are neither visible nor reachable"
				: "visible ore has no standable interaction route";
		}
		if (visible <= 0) {
			return "a reachable exposed face is available; the eye ray is partially occluded";
		}
		return "a reachable exposed face is available";
	}
}
