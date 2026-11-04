package com.craftmate.body.bridge;

import com.google.gson.JsonObject;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.level.block.state.BlockState;

/**
 * The body's own danger sense. A human player lets go of the mouse and steps
 * back before deciding anything, and that must not wait for a model round
 * trip. This runs on the client thread every tick, ahead of any skill, and
 * reports one event per danger so the orchestrator can cancel queued work.
 *
 * It deliberately does not choose a destination: "where is safe" is a
 * navigation problem, not a reflex. It releases input, jumps out of lava or
 * water where that is the native escape, and leaves the follow-up to the
 * agent.
 */
final class Reflexes {
	/** Enough time to cancel a queued dig without repeating the alarm. */
	private static final int REPORT_COOLDOWN_TICKS = 20 * 3;
	/** One block from lava means the next step can be fatal. */
	private static final int LAVA_LOOKAHEAD = 2;
	private static final double CREEPER_DISTANCE_SQR = 3.0 * 3.0;
	private static final float LOW_HEALTH = 6.0f;

	private final Consumer<JsonObject> send;
	private final long[] lastReportedAt = new long[Kind.values().length];
	private int ticks;
	private boolean retreated;

	Reflexes(Consumer<JsonObject> send) {
		this.send = send;
	}

	/**
	 * Returns true when the body is in danger this tick. Callers must not
	 * advance a skill's state machine in that case: a walk that keeps pressing
	 * forward while standing in lava is worse than a cancelled task.
	 */
	boolean tick(Minecraft client) {
		ticks++;
		LocalPlayer player = client.player;
		if (player == null || client.level == null || !player.isAlive()) {
			retreated = false;
			return false;
		}

		boolean dangerous = false;
		if (player.isInLava() || nearLava(client, player)) {
			dangerous = true;
			report(Kind.LAVA, "站在岩浆里或离岩浆只有一格", player);
		}
		if (player.getHealth() <= LOW_HEALTH) {
			dangerous = true;
			report(Kind.LOW_HEALTH, "血量只剩 " + Math.round(player.getHealth()) + " 点", player);
		}
		if (player.fallDistance > 3.0f && !player.onGround() && !player.isFallFlying()) {
			dangerous = true;
			report(Kind.FALLING, "正在从高处下落", player);
		}
		if (player.isEyeInFluid(FluidTags.WATER) && player.getAirSupply() <= 120) {
			dangerous = true;
			report(Kind.DROWNING, "水下快没气了", player);
		}
		if (player.isOnFire()) {
			dangerous = true;
			report(Kind.ON_FIRE, "身上着火了", player);
		}
		if (player.getFoodData().getFoodLevel() <= 2) {
			dangerous = true;
			report(Kind.STARVING, "饿到快掉血了", player);
		}
		Entity creeper = nearestCreeper(client, player);
		if (creeper != null) {
			double distance = Math.sqrt(creeper.distanceToSqr(player));
			dangerous = true;
			report(Kind.CREEPER, "苦力怕离你 " + Math.round(distance) + " 格", player);
		}

		if (dangerous) {
			releaseInputs(player);
			escape(client, player);
			retreated = true;
		} else if (retreated) {
			retreated = false;
		}
		return dangerous;
	}

	/**
	 * Danger ends the current action, so the body must not keep holding a key
	 * or swinging after it reports. The client reads these flags every tick.
	 */
	private static void releaseInputs(LocalPlayer player) {
		if (player.input != null) {
			player.input.keyPresses = net.minecraft.world.entity.player.Input.EMPTY;
		}
		Minecraft client = Minecraft.getInstance();
		if (client.gameMode != null && client.gameMode.isDestroying()) {
			client.gameMode.stopDestroyBlock();
		}
	}

	/**
	 * Native escape only: jumping clears lava and swims up out of water. It
	 * never walks toward an invented safe spot, because the agent owns route
	 * choice and a reflex that guesses can walk off a cliff.
	 */
	private static void escape(Minecraft client, LocalPlayer player) {
		if (player.isInLava() || player.isEyeInFluid(FluidTags.WATER)) {
			if (player.onGround()) player.jumpFromGround();
		}
	}

	private static boolean nearLava(Minecraft client, LocalPlayer player) {
		BlockPos origin = player.blockPosition();
		for (BlockPos pos : BlockPos.betweenClosed(
			origin.offset(-LAVA_LOOKAHEAD, -2, -LAVA_LOOKAHEAD),
			origin.offset(LAVA_LOOKAHEAD, 1, LAVA_LOOKAHEAD)
		)) {
			BlockState state = client.level.getBlockState(pos);
			if (state.getFluidState().is(FluidTags.LAVA)) return true;
		}
		return false;
	}

	private static Entity nearestCreeper(Minecraft client, LocalPlayer player) {
		return client.level
			.getEntitiesOfClass(Creeper.class, player.getBoundingBox().inflate(CREEPER_DISTANCE_SQR))
			.stream()
			.filter(creeper -> creeper.isAlive() && creeper.distanceToSqr(player) <= CREEPER_DISTANCE_SQR)
			.findFirst()
			.orElse(null);
	}

	private void report(Kind kind, String detail, LocalPlayer player) {
		int index = kind.ordinal();
		if (ticks - lastReportedAt[index] < REPORT_COOLDOWN_TICKS) return;
		lastReportedAt[index] = ticks;
		send.accept(BridgeMessages.reflex(kind.wire, detail, player.getHealth()));
	}

	private enum Kind {
		LAVA("lava"),
		LOW_HEALTH("low_health"),
		FALLING("falling"),
		DROWNING("drowning"),
		ON_FIRE("on_fire"),
		STARVING("starving"),
		CREEPER("creeper");

		final String wire;

		Kind(String wire) {
			this.wire = wire;
		}
	}
}
