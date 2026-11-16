package com.craftmate.body.bridge;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Body-local memory for exact targets that just exhausted their route budget.
 * It only suppresses repeated searches for the same coordinate; exploration
 * and a changed world can still choose a different destination.
 */
final class UnreachableTargets {
	private static final int MAX_ENTRIES = 64;
	private final Map<Long, Long> blockedUntil = new HashMap<>();
	private final long ttlMs;

	UnreachableTargets(long ttlMs) {
		this.ttlMs = Math.max(1_000L, ttlMs);
	}

	void block(long key, long nowMs) {
		if (blockedUntil.size() >= MAX_ENTRIES) prune(nowMs);
		blockedUntil.put(key, nowMs + ttlMs);
	}

	void unblock(long key) {
		blockedUntil.remove(key);
	}

	boolean blocked(long key, long nowMs) {
		Long until = blockedUntil.get(key);
		if (until == null) return false;
		if (until > nowMs) return true;
		blockedUntil.remove(key);
		return false;
	}

	private void prune(long nowMs) {
		Iterator<Map.Entry<Long, Long>> iterator = blockedUntil.entrySet().iterator();
		while (iterator.hasNext()) {
			Map.Entry<Long, Long> entry = iterator.next();
			if (entry.getValue() <= nowMs) iterator.remove();
		}
		while (blockedUntil.size() >= MAX_ENTRIES) {
			Long oldest = null;
			for (Map.Entry<Long, Long> entry : blockedUntil.entrySet()) {
				if (oldest == null || entry.getValue() < blockedUntil.get(oldest)) {
					oldest = entry.getKey();
				}
			}
			if (oldest == null) return;
			blockedUntil.remove(oldest);
		}
	}
}
