package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class PlanGuardNeedsTest {
	private static final Map<String, List<String>> FAMILIES = Map.of(
		"block:iron_ore",
		List.of("minecraft:iron_ore", "minecraft:deepslate_iron_ore"),
		"block:stone",
		List.of("minecraft:stone"),
		"block:mixed",
		List.of("minecraft:iron_ore", "minecraft:stone")
	);

	@Test
	void oreGuardRequestsTheFirstFamilyVariant() {
		PlanGuardNeeds.Need need = PlanGuardNeeds.oreNeed(
			guards(targetFamily("block:iron_ore", "visible")),
			FAMILIES::get
		);
		assertEquals("block:iron_ore", need.familyId());
		assertEquals("minecraft:iron_ore", need.blockId());
		assertEquals("visible", need.state());
	}

	@Test
	void nonOreAndMixedFamiliesNeverStartASurvey() {
		assertNull(
			PlanGuardNeeds.oreNeed(
				guards(targetFamily("block:stone", "visible")),
				FAMILIES::get
			)
		);
		assertNull(
			PlanGuardNeeds.oreNeed(
				guards(targetFamily("block:mixed", "visible")),
				FAMILIES::get
			)
		);
		assertNull(
			PlanGuardNeeds.oreNeed(
				guards(targetFamily("block:unknown", "visible")),
				FAMILIES::get
			)
		);
	}

	@Test
	void nestedAllNeedsTheStrongestStateAndNestedOrTheWeakest() {
		JsonObject all = new JsonObject();
		all.addProperty("type", "all");
		JsonArray allChildren = new JsonArray();
		allChildren.add(targetFamily("block:iron_ore", "observed"));
		allChildren.add(targetFamily("block:iron_ore", "reachable"));
		all.add("guards", allChildren);
		assertEquals(
			"reachable",
			PlanGuardNeeds.oreNeed(guards(all), FAMILIES::get).state()
		);

		JsonObject or = new JsonObject();
		or.addProperty("type", "or");
		JsonArray orChildren = new JsonArray();
		orChildren.add(targetFamily("block:iron_ore", "reachable"));
		orChildren.add(targetFamily("block:iron_ore", "observed"));
		or.add("guards", orChildren);
		assertEquals(
			"observed",
			PlanGuardNeeds.oreNeed(guards(or), FAMILIES::get).state()
		);
	}

	private static JsonArray guards(JsonObject guard) {
		JsonArray guards = new JsonArray();
		guards.add(guard);
		return guards;
	}

	private static JsonObject targetFamily(String family, String state) {
		JsonObject guard = new JsonObject();
		guard.addProperty("type", "target_family");
		guard.addProperty("family", family);
		guard.addProperty("state", state);
		guard.addProperty("min", 1);
		return guard;
	}
}
