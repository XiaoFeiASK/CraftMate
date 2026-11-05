package com.craftmate.body.stream;

import com.craftmate.body.CraftMateBodyClient;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.concurrent.Executors;
import java.util.concurrent.Executor;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import com.mojang.blaze3d.platform.NativeImage;

/**
 * Loopback-only JPEG frame source for optional local recording and debugging.
 *
 * <p>The admin console no longer consumes this stream (#55). It remains behind
 * {@link FrameDemand} so an external recorder can opt in without affecting
 * command ownership, liveness, or the console's first paint. When nothing asks
 * for frames, capture stays idle and this server costs one unused loopback
 * port.
 */
public final class FrameServer implements AutoCloseable {
	private static final String HOST = "127.0.0.1";
	private static final int DEFAULT_PORT = 4324;
	/** 20 fps: the console wants a live monitor, not a slideshow. */
	private static final long CAPTURE_PERIOD_MS = 50L;
	private static final int MAX_WIDTH = 960;
	/** The desktop shell and loopback dev servers are the only readers. */
	private static final java.util.Set<String> ALLOWED_ORIGINS = java.util.Set.of(
		"tauri://localhost",
		"http://tauri.localhost",
		"https://tauri.localhost"
	);

	private final HttpServer server;
	private final ScheduledExecutorService capture;
	private final Executor encoder;
	private final AtomicReference<byte[]> latest = new AtomicReference<>();
	private final AtomicBoolean grabbed = new AtomicBoolean();
	private final AtomicBoolean encoding = new AtomicBoolean();
	/** Open MJPEG responses. Frames are pushed, never polled. */
	private final java.util.Set<OutputStream> subscribers = java.util.concurrent.ConcurrentHashMap.newKeySet();
	private final Supplier<Boolean> capturing;
	private volatile long lastFrameAt;

	private FrameServer(HttpServer server, Supplier<Boolean> capturing) {
		this.server = server;
		this.capturing = capturing;
		this.capture = Executors.newSingleThreadScheduledExecutor(runnable -> {
			Thread thread = new Thread(runnable, "craftmate-frame-capture");
			thread.setDaemon(true);
			return thread;
		});
		this.encoder = Executors.newSingleThreadExecutor(runnable -> {
			Thread thread = new Thread(runnable, "craftmate-frame-encode");
			thread.setDaemon(true);
			return thread;
		});
	}

	public static FrameServer start(Supplier<Boolean> capturing) {
		int port = Integer.getInteger(
			"craftmate.frames.port",
			Integer.parseInt(System.getenv().getOrDefault("CRAFTMATE_FRAME_PORT", "" + DEFAULT_PORT))
		);
		try {
			HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getByName(HOST), port), 0);
			FrameServer frames = new FrameServer(server, capturing);
			server.createContext("/frame.jpg", frames::serveFrame);
			server.createContext("/stream.mjpg", frames::serveStream);
			server.createContext("/health", frames::serveHealth);
			server.setExecutor(Executors.newCachedThreadPool(runnable -> {
				Thread thread = new Thread(runnable, "craftmate-frame-http");
				thread.setDaemon(true);
				return thread;
			}));
			server.start();
			frames.capture.scheduleAtFixedRate(frames::tick, 0L, CAPTURE_PERIOD_MS, TimeUnit.MILLISECONDS);
			CraftMateBodyClient.LOGGER.info("CraftMate frames listening on http://{}:{}/frame.jpg", HOST, port);
			return frames;
		} catch (IOException error) {
			CraftMateBodyClient.LOGGER.warn("CraftMate frame server unavailable; console keeps the demo clip", error);
			return null;
		}
	}

	@Override
	public void close() {
		capture.shutdownNow();
		if (encoder instanceof java.util.concurrent.ExecutorService service) service.shutdownNow();
		server.stop(0);
	}

	private boolean fresh() {
		return System.currentTimeMillis() - lastFrameAt < 2_000L;
	}

	private void serveFrame(HttpExchange exchange) throws IOException {
		try {
			FrameDemand.touch();
			allowOrigin(exchange);
			exchange.getResponseHeaders().set("cache-control", "no-store");
			byte[] frame = latest.get();
			if (frame == null || !fresh()) {
				// The first request arrives before the render thread has
				// produced a frame; holding the connection briefly avoids a
				// visible poster flash on every console refresh.
				awaitFirstFrame();
				frame = latest.get();
			}
			if (frame == null || !fresh()) {
				exchange.sendResponseHeaders(503, -1);
				return;
			}
			exchange.getResponseHeaders().set("content-type", "image/jpeg");
			exchange.sendResponseHeaders(200, frame.length);
			try (OutputStream body = exchange.getResponseBody()) {
				body.write(frame);
			}
		} finally {
			exchange.close();
		}
	}

	private void awaitFirstFrame() {
		long deadline = System.currentTimeMillis() + 1_500L;
		while (latest.get() == null && System.currentTimeMillis() < deadline) {
			try {
				Thread.sleep(50L);
			} catch (InterruptedException interrupted) {
				Thread.currentThread().interrupt();
				return;
			}
		}
	}

	private void serveHealth(HttpExchange exchange) throws IOException {
		try {
			FrameDemand.touch();
			allowOrigin(exchange);
			boolean ok = latest.get() != null && fresh();
			byte[] payload = ("{\"ok\":" + ok + "}").getBytes();
			exchange.getResponseHeaders().set("content-type", "application/json");
			exchange.getResponseHeaders().set("cache-control", "no-store");
			exchange.sendResponseHeaders(ok ? 200 : 503, payload.length);
			try (OutputStream body = exchange.getResponseBody()) {
				body.write(payload);
			}
		} finally {
			exchange.close();
		}
	}

	/**
	 * MJPEG over one long-lived response. The browser paints each part as it
	 * arrives, so there is no per-frame fetch, blob URL or decode round trip.
	 */
	private void serveStream(HttpExchange exchange) throws IOException {
		FrameDemand.touch();
		allowOrigin(exchange);
		exchange.getResponseHeaders().set(
			"content-type", "multipart/x-mixed-replace; boundary=frame"
		);
		exchange.getResponseHeaders().set("cache-control", "no-store, no-cache, must-revalidate");
		exchange.getResponseHeaders().set("pragma", "no-cache");
		exchange.sendResponseHeaders(200, 0);
		OutputStream body = exchange.getResponseBody();
		subscribers.add(body);
		try {
			// Keep capture alive for as long as the console is watching.
			while (!Thread.currentThread().isInterrupted()) {
				FrameDemand.touch();
				Thread.sleep(1_000L);
			}
		} catch (InterruptedException interrupted) {
			Thread.currentThread().interrupt();
		} finally {
			subscribers.remove(body);
			try {
				body.close();
			} catch (IOException ignored) {
				// The client already went away.
			}
			exchange.close();
		}
	}

	private void publish(byte[] frame, long capturedAt) {
		byte[] header = (
			"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + frame.length
				+ "\r\nX-Captured-At: " + capturedAt + "\r\n\r\n"
		).getBytes();
		for (OutputStream body : subscribers) {
			try {
				body.write(header);
				body.write(frame);
				body.write("\r\n".getBytes());
				body.flush();
			} catch (IOException gone) {
				subscribers.remove(body);
			}
		}
	}

	private static void allowOrigin(HttpExchange exchange) {
		String origin = exchange.getRequestHeaders().getFirst("origin");
		if (origin != null && (ALLOWED_ORIGINS.contains(origin) || loopbackOrigin(origin))) {
			exchange.getResponseHeaders().set("access-control-allow-origin", origin);
			exchange.getResponseHeaders().set("vary", "origin");
		}
	}

	/** `http://localhost:<port>` / `http://127.0.0.1:<port>` only. */
	private static boolean loopbackOrigin(String origin) {
		return origin.startsWith("http://localhost:")
			|| origin.startsWith("http://127.0.0.1:");
	}

	/**
	 * Capture only while the console asks for it, and only when nothing else
	 * has a GPU readback in flight. The capture runs on the render thread
	 * because it touches the main framebuffer.
	 */
	private void tick() {
		if (!capturing.get() || !FrameDemand.wanted() || !grabbed.compareAndSet(false, true)) return;
		Minecraft client = Minecraft.getInstance();
		client.execute(() -> {
			try {
				if (client.level == null || client.player == null || client.getWindow() == null) {
					grabbed.set(false);
					return;
				}
				// Downscale on the GPU readback when the window is large; JPEG
				// encoding then happens off the render thread.
				int factor = client.getWindow().getWidth() > MAX_WIDTH * 2 ? 2 : 1;
				Screenshot.takeScreenshot(client.getMainRenderTarget(), factor, image -> {
					grabbed.set(false);
					if (!encoding.compareAndSet(false, true)) {
						image.close();
						return;
					}
					encoder.execute(() -> {
						long capturedAt = System.currentTimeMillis();
						try (image) {
							byte[] frame = encode(image);
							latest.set(frame);
							lastFrameAt = capturedAt;
							publish(frame, capturedAt);
						} catch (IOException error) {
							CraftMateBodyClient.LOGGER.debug("CraftMate frame encode failed", error);
						} finally {
							encoding.set(false);
						}
					});
				});
			} catch (RuntimeException error) {
				grabbed.set(false);
				CraftMateBodyClient.LOGGER.debug("CraftMate frame capture failed", error);
			}
		});
	}

	private static byte[] encode(NativeImage image) throws IOException {
		int width = image.getWidth();
		int height = image.getHeight();
		if (width <= 0 || height <= 0) throw new IOException("empty frame");

		BufferedImage output = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
		output.setRGB(0, 0, width, height, image.getPixels(), 0, width);
		BufferedImage scaled = output;
		if (width > MAX_WIDTH) {
			int targetHeight = Math.max(1, (int) Math.round(height * (MAX_WIDTH / (double) width)));
			scaled = new BufferedImage(MAX_WIDTH, targetHeight, BufferedImage.TYPE_INT_RGB);
			java.awt.Graphics2D graphics = scaled.createGraphics();
			graphics.setRenderingHint(
				java.awt.RenderingHints.KEY_INTERPOLATION,
				java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR
			);
			graphics.drawImage(
				output.getScaledInstance(MAX_WIDTH, targetHeight, java.awt.Image.SCALE_SMOOTH),
				0, 0, null
			);
			graphics.dispose();
		}

		ByteArrayOutputStream bytes = new ByteArrayOutputStream(256 * 1024);
		ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
		try (ImageOutputStream stream = ImageIO.createImageOutputStream(bytes)) {
			writer.setOutput(stream);
			ImageWriteParam params = writer.getDefaultWriteParam();
			if (params.canWriteCompressed()) {
				params.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
				params.setCompressionQuality(0.72f);
			}
			writer.write(null, new IIOImage(scaled, null, null), params);
		} finally {
			writer.dispose();
		}
		return bytes.toByteArray();
	}
}
