package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

class PlanGuardEvaluatorTest {
	private static final class Facts implements PlanGuardEvaluator.Facts {
		int iron = 3;
		int visibleOre = 2;
		int health = 14;
		int food = 12;
		boolean night;
		boolean changed;
		boolean table = true;

		@Override
		public int inventory(String item) {
			return item.endsWith("iron_ingot") ? iron : 0;
		}

		@Override
		public int family(String family, String state) {
			return family.equals("block:iron_ore") && state.equals("visible") ? visibleOre : 0;
		}

		@Override
		public boolean stationReachable(String block) {
			return table && block.endsWith("crafting_table");
		}

		@Override
		public String dimension() {
			return "minecraft:overworld";
		}

		@Override
		public float health() {
			return health;
		}

		@Override
		public int food() {
			return food;
		}

		@Override
		public boolean night() {
			return night;
		}

		@Override
		public String worldVersion() {
			return "1:100";
		}

		@Override
		public boolean worldChanged() {
			return changed;
		}
	}

	private static JsonObject guard(String type) {
		JsonObject guard = new JsonObject();
		guard.addProperty("type", type);
		return guard;
	}

	@Test
	void inventoryAndResourceRangesUseObservedCounts() {
		Facts facts = new Facts();
		JsonObject inventory = guard("inventory");
		inventory.addProperty("item", "minecraft:iron_ingot");
		inventory.addProperty("min", 2);
		assertTrue(PlanGuardEvaluator.evaluate(inventory, facts).ok());

		inventory.addProperty("min", 4);
		assertFalse(PlanGuardEvaluator.evaluate(inventory, facts).ok());
	}

	@Test
	void targetFamilyStatesAreNotInterchangeable() {
		Facts facts = new Facts();
		JsonObject family = guard("target_family");
		family.addProperty("family", "block:iron_ore");
		family.addProperty("state", "visible");
		family.addProperty("min", 1);
		assertTrue(PlanGuardEvaluator.evaluate(family, facts).ok());

		family.addProperty("state", "reachable");
		assertFalse(PlanGuardEvaluator.evaluate(family, facts).ok());
	}

	@Test
	void stationDimensionHealthFoodAndTimeAreTypedChecks() {
		Facts facts = new Facts();
		JsonObject station = guard("station");
		station.addProperty("block", "minecraft:crafting_table");
		station.addProperty("reachable", true);
		assertTrue(PlanGuardEvaluator.evaluate(station, facts).ok());

		JsonObject dimension = guard("dimension");
		dimension.addProperty("id", "minecraft:the_nether");
		assertFalse(PlanGuardEvaluator.evaluate(dimension, facts).ok());

		JsonObject health = guard("health");
		health.addProperty("min", 18);
		assertFalse(PlanGuardEvaluator.evaluate(health, facts).ok());

		JsonObject food = guard("food");
		food.addProperty("max", 6);
		assertFalse(PlanGuardEvaluator.evaluate(food, facts).ok());

		JsonObject time = guard("time");
		time.addProperty("phase", "night");
		assertFalse(PlanGuardEvaluator.evaluate(time, facts).ok());
	}

	@Test
	void worldVersionEqualityAndChangeAreBothEvidenceBased() {
		Facts facts = new Facts();
		JsonObject equal = guard("world_version");
		equal.addProperty("equals", "1:100");
		assertTrue(PlanGuardEvaluator.evaluate(equal, facts).ok());

		equal.addProperty("equals", "1:101");
		assertFalse(PlanGuardEvaluator.evaluate(equal, facts).ok());

		facts.changed = true;
		JsonObject changed = guard("world_version");
		changed.addProperty("changed", true);
		assertTrue(PlanGuardEvaluator.evaluate(changed, facts).ok());
	}

	@Test
	void andOrNestingShortCircuitsAndUnknownGuardsFailClosed() {
		Facts facts = new Facts();
		JsonObject all = guard("all");
		JsonArray allChildren = new JsonArray();
		allChildren.add(inventoryGuard("minecraft:iron_ingot", 2));
		allChildren.add(inventoryGuard("minecraft:iron_ingot", 5));
		all.add("guards", allChildren);
		assertFalse(PlanGuardEvaluator.evaluate(all, facts).ok());

		JsonObject or = guard("or");
		JsonArray orChildren = new JsonArray();
		orChildren.add(inventoryGuard("minecraft:iron_ingot", 5));
		orChildren.add(inventoryGuard("minecraft:iron_ingot", 2));
		or.add("guards", orChildren);
		assertTrue(PlanGuardEvaluator.evaluate(or, facts).ok());

		assertFalse(PlanGuardEvaluator.evaluate(guard("arbitrary_predicate"), facts).ok());
	}

	private static JsonObject inventoryGuard(String item, int min) {
		JsonObject guard = guard("inventory");
		guard.addProperty("item", item);
		guard.addProperty("min", min);
		return guard;
	}
}
