package com.craftmate.body.bridge;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/** JSON is an outer wire format only; skill payloads stay dynamic. */
final class BridgeJson {
	private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

	private BridgeJson() {
	}

	static JsonObject object(String text) {
		JsonElement parsed = GSON.fromJson(text, JsonElement.class);
		if (parsed == null || !parsed.isJsonObject()) {
			throw new IllegalArgumentException("bridge frame must be a JSON object");
		}
		return parsed.getAsJsonObject();
	}

	static String string(JsonObject value, String name) {
		JsonElement found = value.get(name);
		if (found == null || !found.isJsonPrimitive() || !found.getAsJsonPrimitive().isString()) {
			throw new IllegalArgumentException("missing string field " + name);
		}
		return found.getAsString();
	}

	static int integer(JsonObject value, String name) {
		JsonElement found = value.get(name);
		if (found == null || !found.isJsonPrimitive() || !found.getAsJsonPrimitive().isNumber()) {
			throw new IllegalArgumentException("missing integer field " + name);
		}
		return found.getAsInt();
	}

	static JsonObject objectField(JsonObject value, String name) {
		JsonElement found = value.get(name);
		if (found == null || !found.isJsonObject()) {
			throw new IllegalArgumentException("missing object field " + name);
		}
		return found.getAsJsonObject();
	}

	static String toJson(JsonElement value) {
		return GSON.toJson(value);
	}
}
