package com.craftmate.body.bridge;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;
import net.minecraft.client.Minecraft;

/**
 * The network thread never touches Minecraft state. It submits immutable
 * actions here; the client thread drains them at the end of a tick.
 */
final class MinecraftExecutor {
	private static final int MAX_PENDING = 16;
	private final ConcurrentLinkedQueue<Runnable> queue = new ConcurrentLinkedQueue<>();
	private final AtomicBoolean pending = new AtomicBoolean();
	private final Minecraft minecraft;

	MinecraftExecutor(Minecraft minecraft) {
		this.minecraft = minecraft;
	}

	<T> CompletableFuture<T> submit(Supplier<T> action) {
		CompletableFuture<T> result = new CompletableFuture<>();
		if (!queue.offer(() -> {
			try {
				result.complete(action.get());
			} catch (Throwable error) {
				result.completeExceptionally(error);
			}
		})) {
			result.completeExceptionally(new IllegalStateException("game executor queue overflow"));
		}
		return result;
	}

	boolean saturated() {
		return queue.size() >= MAX_PENDING;
	}

	boolean ready() {
		return minecraft.isSameThread()
			? GameActions.ready(minecraft)
			: Boolean.TRUE.equals(pending.get());
	}

	void drain() {
		pending.set(GameActions.ready(minecraft));
		Runnable task;
		while ((task = queue.poll()) != null) {
			task.run();
		}
	}

	boolean onClientThread() {
		return minecraft.isSameThread();
	}
}
