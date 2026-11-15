package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class BridgeSelfCheckTest {
	@Test
	void everyBridgeClassLoadsIncludingNestedTasks() {
		List<String> names = BridgeSelfCheck.classNames();
		assertTrue(names.size() > 30, "expected the full bridge package, got " + names.size());
		assertTrue(names.contains("com.craftmate.body.bridge.ToolSelection"));
		assertTrue(
			names.contains(
				"com.craftmate.body.bridge.GameActions$PlaceTask$SurfaceCandidate"
			),
			"nested placement candidates must be verified at startup"
		);
		List<String> missing = BridgeSelfCheck.verify();
		assertTrue(missing.isEmpty(), "missing bridge classes: " + missing);
	}

	@Test
	void toolSelectionIsNotOptional() {
		assertFalse(
			BridgeSelfCheck.classNames().contains("com.craftmate.body.bridge.DoesNotExist")
		);
	}
}
