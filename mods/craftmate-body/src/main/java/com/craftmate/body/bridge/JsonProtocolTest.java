package com.craftmate.body.bridge;

import com.google.gson.JsonObject;

/**
 * Small dependency-free checks that can run without launching Minecraft.
 * The Gradle build's Java compilation is the current verification boundary;
 * these helpers keep wire validation assertable in a future test source set.
 */
final class JsonProtocolTest {
	private JsonProtocolTest() {
	}

	static void verify() {
		JsonObject frame = BridgeJson.object("{\"type\":\"welcome\",\"skills\":[\"wait\"]}");
		if (!"welcome".equals(BridgeJson.string(frame, "type"))) {
			throw new AssertionError("type parsing failed");
		}
		if (!"wait".equals(frame.getAsJsonArray("skills").get(0).getAsString())) {
			throw new AssertionError("skills parsing failed");
		}
	}
}
