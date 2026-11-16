package com.craftmate.body.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * Evaluates the contract's closed guard whitelist. There is deliberately no
 * expression parser here: a plan may only ask questions the body can answer
 * from its own observation, and an unknown guard fails closed.
 */
final class PlanGuardEvaluator {
	static final String E_PLAN_GUARD = "E_PLAN_GUARD";

	private PlanGuardEvaluator() {
	}

	record Result(boolean ok, String code, String detail) {
		static Result pass() {
			return new Result(true, null, null);
		}

		static Result fail(String detail) {
			return new Result(false, E_PLAN_GUARD, detail);
		}
	}

	/**
	 * Facts are already observed by the caller. In particular a family count
	 * is not inferred from "the body is near the right biome" and a station
	 * answer is not inferred from a remembered coordinate.
	 */
	interface Facts {
		int inventory(String item);

		int family(String family, String state);

		boolean stationReachable(String block);

		String dimension();

		float health();

		int food();

		boolean night();

		String worldVersion();

		boolean worldChanged();
	}

	static Result evaluate(JsonObject guard, Facts facts) {
		if (guard == null) return Result.fail("guard is not an object");
		String type = string(guard, "type");
		if (type == null) return Result.fail("guard is missing type");
		return switch (type) {
			case "inventory" -> inventory(guard, facts);
			case "target_family" -> targetFamily(guard, facts);
			case "station" -> station(guard, facts);
			case "dimension" -> dimension(guard, facts);
			case "health" -> health(guard, facts);
			case "food" -> food(guard, facts);
			case "time" -> time(guard, facts);
			case "world_version" -> worldVersion(guard, facts);
			case "all" -> all(guard, facts);
			case "or" -> or(guard, facts);
			default -> Result.fail("unknown guard type: " + type);
		};
	}

	static Result evaluateAll(JsonArray guards, Facts facts) {
		if (guards == null) return Result.pass();
		for (JsonElement element : guards) {
			if (!element.isJsonObject()) return Result.fail("guard is not an object");
			Result result = evaluate(element.getAsJsonObject(), facts);
			if (!result.ok()) return result;
		}
		return Result.pass();
	}

	private static Result inventory(JsonObject guard, Facts facts) {
		String item = string(guard, "item");
		if (item == null) return Result.fail("inventory guard is missing item");
		int count = facts.inventory(item);
		return range("inventory " + item + "=" + count, count, guard);
	}

	private static Result targetFamily(JsonObject guard, Facts facts) {
		String family = string(guard, "family");
		String state = string(guard, "state");
		if (family == null || state == null) {
			return Result.fail("target_family guard is missing family/state");
		}
		int count = facts.family(family, state);
		int min = integer(guard, "min", 1);
		if (count < min) {
			return Result.fail(
				"target family " + family + " has " + count + " " + state
					+ " instances, needs " + min
			);
		}
		return Result.pass();
	}

	private static Result station(JsonObject guard, Facts facts) {
		String block = string(guard, "block");
		if (block == null) return Result.fail("station guard is missing block");
		boolean reachable = facts.stationReachable(block);
		boolean wanted = bool(guard, "reachable", true);
		if (reachable != wanted) {
			return Result.fail(
				"station " + block + (wanted ? " is not reachable" : " is unexpectedly reachable")
			);
		}
		return Result.pass();
	}

	private static Result dimension(JsonObject guard, Facts facts) {
		String id = string(guard, "id");
		if (id == null) return Result.fail("dimension guard is missing id");
		String current = facts.dimension();
		if (!id.equals(current)) {
			return Result.fail("dimension is " + current + ", expected " + id);
		}
		return Result.pass();
	}

	private static Result health(JsonObject guard, Facts facts) {
		return range("health=" + facts.health(), facts.health(), guard);
	}

	private static Result food(JsonObject guard, Facts facts) {
		return range("food=" + facts.food(), facts.food(), guard);
	}

	private static Result time(JsonObject guard, Facts facts) {
		String phase = string(guard, "phase");
		if (phase == null) return Result.fail("time guard is missing phase");
		boolean night = facts.night();
		if (("night".equals(phase) && !night) || ("day".equals(phase) && night)) {
			return Result.fail("time phase is " + (night ? "night" : "day") + ", expected " + phase);
		}
		return Result.pass();
	}

	private static Result worldVersion(JsonObject guard, Facts facts) {
		boolean changed = facts.worldChanged();
		if (guard.has("changed")) {
			boolean mustChange = guard.get("changed").getAsBoolean();
			if (mustChange != changed) {
				return Result.fail(
					mustChange
						? "world version did not change as required"
						: "world changed since the plan was compiled"
				);
			}
		} else if (changed) {
			return Result.fail("world changed since the plan was compiled");
		}
		String equals = string(guard, "equals");
		if (equals != null) {
			if (changed) {
				return Result.fail("world changed since the plan was compiled");
			}
			String current = facts.worldVersion();
			if (!equals.equals(current)) {
				return Result.fail("world version is " + current + ", expected " + equals);
			}
		}
		return Result.pass();
	}

	private static Result all(JsonObject guard, Facts facts) {
		JsonArray children = array(guard, "guards");
		if (children == null || children.size() == 0) {
			return Result.fail("all guard has no children");
		}
		return evaluateAll(children, facts);
	}

	private static Result or(JsonObject guard, Facts facts) {
		JsonArray children = array(guard, "guards");
		if (children == null || children.size() == 0) {
			return Result.fail("or guard has no children");
		}
		String firstFailure = null;
		for (JsonElement element : children) {
			if (!element.isJsonObject()) return Result.fail("guard is not an object");
			Result result = evaluate(element.getAsJsonObject(), facts);
			if (result.ok()) return result;
			if (firstFailure == null) firstFailure = result.detail();
		}
		return Result.fail(firstFailure == null ? "no alternative matched" : firstFailure);
	}

	private static Result range(String label, double value, JsonObject guard) {
		if (guard.has("min")) {
			double min = guard.get("min").getAsDouble();
			if (value < min) return Result.fail(label + " is below minimum " + min);
		}
		if (guard.has("max")) {
			double max = guard.get("max").getAsDouble();
			if (value > max) return Result.fail(label + " is above maximum " + max);
		}
		return Result.pass();
	}

	private static String string(JsonObject object, String key) {
		if (!object.has(key) || object.get(key).isJsonNull()) return null;
		try {
			return object.get(key).getAsString();
		} catch (RuntimeException error) {
			return null;
		}
	}

	private static int integer(JsonObject object, String key, int fallback) {
		if (!object.has(key) || object.get(key).isJsonNull()) return fallback;
		try {
			return object.get(key).getAsInt();
		} catch (RuntimeException error) {
			return fallback;
		}
	}

	private static boolean bool(JsonObject object, String key, boolean fallback) {
		if (!object.has(key) || object.get(key).isJsonNull()) return fallback;
		try {
			return object.get(key).getAsBoolean();
		} catch (RuntimeException error) {
			return fallback;
		}
	}

	private static JsonArray array(JsonObject object, String key) {
		if (!object.has(key) || !object.get(key).isJsonArray()) return null;
		return object.getAsJsonArray(key);
	}
}
