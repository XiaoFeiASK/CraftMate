package com.craftmate.body.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.List;
import java.util.function.Function;

/**
 * Finds the ore observation a typed guard needs before it can be evaluated.
 * This is deliberately a pure function: the body must not start a speculative
 * cave sweep for an unrelated guard, and plan tests can exercise the all/or
 * nesting without a Minecraft client.
 */
final class PlanGuardNeeds {
	record Need(String familyId, String blockId, String state) {
	}

	private PlanGuardNeeds() {
	}

	static Need oreNeed(
		JsonArray guards,
		Function<String, List<String>> idsForFamily
	) {
		if (guards == null) return null;
		Need best = null;
		for (var element : guards) {
			if (!element.isJsonObject()) continue;
			Need need = oreNeed(element.getAsJsonObject(), idsForFamily);
			if (need == null) continue;
			if (best == null || rank(need.state()) > rank(best.state())) best = need;
		}
		return best;
	}

	private static Need oreNeed(
		JsonObject guard,
		Function<String, List<String>> idsForFamily
	) {
		String type = string(guard, "type");
		if ("target_family".equals(type)) {
			String familyId = string(guard, "family");
			String state = string(guard, "state");
			if (
				familyId == null ||
				state == null ||
				rank(state) < 0
			) {
				return null;
			}
			List<String> ids = idsForFamily.apply(familyId);
			if (
				ids == null ||
				ids.isEmpty() ||
				!ids.stream().allMatch(OrePerception::isOreId)
			) {
				return null;
			}
			return new Need(familyId, ids.get(0), state);
		}
		if ("all".equals(type) || "or".equals(type)) {
			if (!guard.has("guards") || !guard.get("guards").isJsonArray()) return null;
			Need best = null;
			for (var element : guard.getAsJsonArray("guards")) {
				if (!element.isJsonObject()) continue;
				Need need = oreNeed(element.getAsJsonObject(), idsForFamily);
				if (need == null) continue;
				if (
					best == null ||
					("all".equals(type) && rank(need.state()) > rank(best.state())) ||
					("or".equals(type) && rank(need.state()) < rank(best.state()))
				) {
					best = need;
				}
			}
			return best;
		}
		return null;
	}

	private static int rank(String state) {
		return switch (state) {
			case "observed" -> 0;
			case "visible" -> 1;
			case "reachable" -> 2;
			default -> -1;
		};
	}

	private static String string(JsonObject object, String key) {
		if (!object.has(key) || object.get(key).isJsonNull()) return null;
		try {
			return object.get(key).getAsString();
		} catch (RuntimeException error) {
			return null;
		}
	}
}
