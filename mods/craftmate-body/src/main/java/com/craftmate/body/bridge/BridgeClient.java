package com.craftmate.body.bridge;

import com.craftmate.body.CraftMateBodyClient;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Path;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import net.minecraft.client.Minecraft;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;

/**
 * WebSocket lifecycle and command routing. It deliberately contains no
 * Minecraft calls; all game work is submitted to {@link MinecraftExecutor}.
 */
public final class BridgeClient {
	private static final URI DEFAULT_URI = URI.create("ws://127.0.0.1:4321/bridge");
	private static final String TOKEN_PROPERTY = "craftmate.bridge.token";
	private static final String URL_PROPERTY = "craftmate.bridge.url";
	private static final String TOKEN_ENV = "CRAFTMATE_BRIDGE_TOKEN";
	private static final String URL_ENV = "CRAFTMATE_BRIDGE_URL";

	private final URI uri;
	private final String token;
	private final MinecraftExecutor executor;
	private final ScheduledExecutorService heartbeats;
	private final Object sendLock = new Object();
	private final String taskPrefix = UUID.randomUUID().toString();
	private long nextTask;
	private final AtomicBoolean running = new AtomicBoolean(true);
	private volatile Socket socket;
	private volatile boolean agentControl;
	private volatile long lastServerFrameAt;
	private volatile boolean closing;
	private volatile long connectionGeneration;
	private volatile long nextReconnectAt;
	private volatile long heartbeatMs = 250L;
	private volatile long watchdogMs = 2_000L;
	private volatile boolean initialHandshake = false;
	private volatile int cachedTick;
	private volatile JsonObject cachedWorld;
	private volatile long worldGeneration;
	private final AtomicLong publishedWorldGeneration = new AtomicLong(-1);

	private BridgeClient(URI uri, String token) {
		this.uri = uri;
		this.token = token;
		this.executor = new MinecraftExecutor(Minecraft.getInstance());
		// Reflex events travel on the same socket as command results so the
		// orchestrator sees one ordered account of what happened to the body.
		GameActions.bindSender(this::send);
		this.heartbeats = Executors.newSingleThreadScheduledExecutor(runnable -> {
			Thread thread = new Thread(runnable, "craftmate-bridge-heartbeat");
			thread.setDaemon(true);
			return thread;
		});
		this.heartbeats.scheduleAtFixedRate(this::sendHeartbeat, 0L, 250L, TimeUnit.MILLISECONDS);
	}

	public static BridgeClient startDefault() {
		URI uri = URI.create(firstNonBlank(
			System.getProperty(URL_PROPERTY),
			System.getenv(URL_ENV),
			DEFAULT_URI.toString()
		));
		String token;
		try {
			token = firstNonBlank(
				System.getProperty(TOKEN_PROPERTY),
				System.getenv(TOKEN_ENV),
				BridgeToken.loadOrCreate(Path.of(System.getProperty("user.home"), ".craftmate", "bridge.token"))
			);
		} catch (IOException error) {
			throw new IllegalStateException("cannot read CraftMate bridge token", error);
		}
		BridgeClient bridge = new BridgeClient(uri, token);
		bridge.connect();
		return bridge;
	}

	public static URI defaultUri() {
		return DEFAULT_URI;
	}

	private void connect() {
		if (!running.get() || closing || socket != null) return;
		long generation = ++connectionGeneration;
		Socket next = new Socket(uri, generation);
		socket = next;
		next.connect();
		GameActions.showStatus(Minecraft.getInstance(), "正在连接 " + uri.getHost() + ":" + uri.getPort());
	}

	public void tick(Minecraft minecraft) {
		executor.drain();
		GameActions.startFrame();
		GameActions.update(minecraft);
		long now = System.currentTimeMillis();
		cachedTick = GameActions.tick(minecraft);
		cachedWorld = GameActions.snapshot(minecraft);
		worldGeneration++;
		Socket current = socket;
		if (current == null && running.get() && !closing && now >= nextReconnectAt) connect();
	}

	public void close() {
		running.set(false);
		closing = true;
		heartbeats.shutdownNow();
		agentControl = false;
		GameActions.stopLocally(Minecraft.getInstance());
		closeSocket(1000, "client stopping");
	}

	private void onFrame(Socket source, JsonObject frame) {
		if (source != socket || closing) return;
		lastServerFrameAt = System.currentTimeMillis();
		String type = BridgeJson.string(frame, "type");
		switch (type) {
			case "welcome" -> {
				String owner = BridgeJson.string(frame, "owner");
				heartbeatMs = BridgeJson.integer(frame, "heartbeatMs");
				watchdogMs = BridgeJson.integer(frame, "watchdogMs");
				initialHandshake = "none".equals(owner)
					&& !GameActions.snapshot(Minecraft.getInstance()).get("inWorld").getAsBoolean();
				applyOwnership(source, owner, "桥接已连接 · " + owner);
				for (String skill : GameActions.skills()) {
					if (!contains(frame, skill)) {
						CraftMateBodyClient.LOGGER.warn("server did not negotiate {}; advertised locally", skill);
					}
				}
			}
			case "ownership" -> applyOwnership(source, BridgeJson.string(frame, "owner"), null);
			case "heartbeat" -> {
				initialHandshake = false;
				// The client must not self-grant agent control. Its heartbeat
				// merely reports the owner last granted by a server frame. The
				// heartbeat is already the liveness proof consumed above.
			}
			case "cancel" -> {
				executor.submit(() -> {
					if (source != socket || closing) return false;
					String id = frame.has("id") ? BridgeJson.string(frame, "id") : null;
					GameActions.cancel(Minecraft.getInstance(), id);
					return true;
				});
			}
			case "cmd" -> handleCommand(source, frame);
			case "error" -> CraftMateBodyClient.LOGGER.warn(
				"bridge rejected frame: {} {}",
				frame.has("code") ? frame.get("code") : "unknown",
				frame.has("detail") ? frame.get("detail") : ""
			);
			default -> CraftMateBodyClient.LOGGER.debug("ignored bridge frame {}", type);
		}
	}

	private void handleCommand(Socket source, JsonObject frame) {
		String id = BridgeJson.string(frame, "id");
		String op = BridgeJson.string(frame, "op");
		if (!agentControl) {
			send(reject(id, "E_PERMISSION", "agent control is not granted"));
			return;
		}
		if (!GameActions.ready(Minecraft.getInstance())) {
			send(reject(id, "E_PRECONDITION", "game screen is open or no world is loaded"));
			return;
		}
		if (executor.saturated()) {
			send(reject(id, "E_BUSY", "game executor queue is full"));
			return;
		}
		JsonObject args = BridgeJson.objectField(frame, "args");
		String taskId = taskPrefix + "-" + (++nextTask);
		executor.submit(() -> {
			if (source != socket || closing) {
				return GameActions.StartDecision.rejected("E_PERMISSION", "bridge connection changed");
			}
			return GameActions.start(Minecraft.getInstance(), taskId, op, args, this::send);
		}).whenComplete((decision, error) -> {
			if (source != socket || closing) return;
			if (error != null) {
				CraftMateBodyClient.LOGGER.warn("could not accept {}", id, error);
				send(reject(id, "E_INTERNAL", message(error)));
			} else if (!decision.accepted()) {
				send(reject(id, decision.code(), decision.detail()));
			} else {
				// The coordinator ignores result frames for an unadopted task.
				// Ack first, then allow the next client tick to emit progress
				// or an immediate terminal result.
				send(accepted(id, taskId));
			}
		});
	}

	private void applyOwnership(Socket source, String owner, String status) {
		executor.submit(() -> {
			if (source != socket || closing) return false;
			agentControl = "agent".equals(owner);
			if (!agentControl) GameActions.stopLocally(Minecraft.getInstance());
			if (status != null) GameActions.showStatus(Minecraft.getInstance(), status);
			return true;
		});
	}

	private void closeSocket(int code, String reason) {
		Socket current = socket;
		if (current == null) return;
		socket = null;
		try {
			current.close(code, reason);
			current.closeBlocking();
		} catch (InterruptedException interrupted) {
			Thread.currentThread().interrupt();
		}
	}

	private void send(JsonObject message) {
		Socket current = socket;
		if (current != null && current.isOpen()) {
			synchronized (sendLock) {
				current.send(BridgeJson.toJson(message));
			}
		}
	}

	private JsonObject heartbeat() {
		long generation = worldGeneration;
		long observed = publishedWorldGeneration.getAndSet(generation);
		return BridgeMessages.heartbeat(
			cachedTick,
			agentControl,
			generation == observed && !initialHandshake ? null : cachedWorld,
			generation
		);
	}

	/**
	 * Liveness belongs to the network connection, not the render thread. A
	 * temporary tick stall must not make the orchestrator conclude that the
	 * body disappeared and cancel an otherwise valid action. World snapshots
	 * are still produced only on the client thread and published through this
	 * volatile cache.
	 */
	private void sendHeartbeat() {
		if (closing) return;
		Socket current = socket;
		if (current == null || !current.isOpen()) return;
		long now = System.currentTimeMillis();
		if (
			(agentControl || initialHandshake)
				&& now - lastServerFrameAt >= watchdogMs
		) {
			agentControl = false;
			initialHandshake = false;
			CraftMateBodyClient.LOGGER.warn("CraftMate bridge heartbeat timed out; local control stopped");
			// Do not tear down a live TCP session because a frame was late.
			// The client thread may be busy generating chunks, and a close
			// here used to produce a disconnect/reconnect loop during startup.
			// The server stops granting control when it sees missed
			// heartbeats; a later server frame proves the session is healthy.
			lastServerFrameAt = now;
			executor.submit(() -> {
				if (current != socket) return false;
				GameActions.stopLocally(Minecraft.getInstance());
				return true;
			});
			return;
		}
		synchronized (sendLock) {
			current.send(BridgeJson.toJson(heartbeat()));
		}
	}

	private void sendHello() {
		send(BridgeMessages.hello(token, GameActions.capabilities(), GameActions.skills()));
	}

	private static boolean contains(JsonObject object, String name) {
		if (!object.has("skills") || !object.get("skills").isJsonArray()) return false;
		for (var item : object.getAsJsonArray("skills")) {
			if (item.isJsonPrimitive() && name.equals(item.getAsString())) return true;
		}
		return false;
	}

	private static JsonObject accepted(String id, String taskId) {
		return BridgeMessages.ack(id, taskId);
	}

	private static JsonObject reject(String id, String code, String detail) {
		return BridgeMessages.reject(id, code, detail);
	}

	private static String firstNonBlank(String... values) {
		for (String value : values) if (value != null && !value.isBlank()) return value.trim();
		return "";
	}

	private static String message(Throwable error) {
		String message = error.getMessage();
		return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
	}

	private final class Socket extends WebSocketClient {
		private final long generation;

		private Socket(URI uri, long generation) {
			super(uri);
			this.generation = generation;
			setConnectionLostTimeout(0);
		}

		@Override
		public void onOpen(ServerHandshake handshake) {
			if (this != socket || closing) {
				close(1000, "stale connection");
				return;
			}
			initialHandshake = false;
			lastServerFrameAt = System.currentTimeMillis();
			nextReconnectAt = 0L;
			sendHello();
			CraftMateBodyClient.LOGGER.info("connected to CraftMate bridge {}", uri);
		}

		@Override
		public void onMessage(String text) {
			try {
				onFrame(this, BridgeJson.object(text));
			} catch (RuntimeException error) {
				CraftMateBodyClient.LOGGER.warn("invalid bridge frame; closing", error);
				close(4400, "invalid frame");
			}
		}

		@Override
		public void onClose(int code, String reason, boolean remote) {
			CraftMateBodyClient.LOGGER.info("bridge disconnected ({}): {}", code, reason);
			if (this != socket) return;
			socket = null;
			nextReconnectAt = System.currentTimeMillis() + 2_000L;
			agentControl = false;
			initialHandshake = false;
			executor.submit(() -> {
				// A later connection may already have replaced this socket.
				// Its input must not be stopped by an old close callback.
				if (generation != connectionGeneration || socket != null) return false;
				GameActions.stopLocally(Minecraft.getInstance());
				GameActions.showStatus(Minecraft.getInstance(), "桥接已断开 · 等待重连");
				return true;
			});
		}

		@Override
		public void onError(Exception error) {
			CraftMateBodyClient.LOGGER.warn("bridge connection error", error);
		}
	}
}
