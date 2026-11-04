package com.craftmate.body.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.List;

/** Pure bridge frames, kept separate so wire semantics are easy to audit. */
final class BridgeMessages {
	private BridgeMessages() {
	}

	static JsonObject hello(String token, List<String> capabilities, List<String> skills) {
		JsonObject hello = base("hello");
		hello.addProperty("token", token);
		hello.addProperty("client", "craftmate-body-fabric/0.1.0");
		hello.add("capabilities", array(capabilities));
		hello.add("skills", array(skills));
		return hello;
	}

	static JsonObject heartbeat(int tick, boolean agent, JsonObject world, long worldGeneration) {
		JsonObject heartbeat = base("heartbeat");
		heartbeat.addProperty("tick", Math.max(0, tick));
		heartbeat.addProperty("owner", agent ? "agent" : "none");
		heartbeat.addProperty("worldGeneration", Math.max(0, worldGeneration));
		if (world != null) {
			heartbeat.add("world", world);
		} else {
			heartbeat.add("world", null);
		}
		return heartbeat;
	}

	static JsonObject ack(String id, String taskId) {
		JsonObject ack = base("ack");
		ack.addProperty("id", id);
		ack.addProperty("accepted", true);
		ack.addProperty("taskId", taskId);
		return ack;
	}

	static JsonObject reject(String id, String code, String detail) {
		JsonObject ack = base("ack");
		ack.addProperty("id", id);
		ack.addProperty("accepted", false);
		ack.addProperty("code", code);
		ack.addProperty("detail", detail);
		return ack;
	}

	static JsonObject result(String taskId, String status, String code, String detail) {
		return result(taskId, status, code, detail, null);
	}

	static JsonObject result(
		String taskId, String status, String code, String detail, JsonObject data
	) {
		JsonObject result = base("result");
		result.addProperty("taskId", taskId);
		result.addProperty("status", status);
		if (code != null) result.addProperty("code", code);
		if (detail != null && !detail.isBlank()) result.addProperty("detail", detail);
		if (data != null) result.add("data", data);
		return result;
	}

	static JsonObject progress(String taskId, String phase, int done, int total) {
		JsonObject progress = base("progress");
		progress.addProperty("taskId", taskId);
		progress.addProperty("phase", phase);
		progress.addProperty("done", done);
		progress.addProperty("total", total);
		return progress;
	}

	private static JsonObject base(String type) {
		JsonObject object = new JsonObject();
		object.addProperty("v", 1);
		object.addProperty("type", type);
		return object;
	}

	private static JsonArray array(List<String> values) {
		JsonArray array = new JsonArray();
		for (String value : values) array.add(value);
		return array;
	}
}
