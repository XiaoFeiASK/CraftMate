package com.craftmate.body.bridge;

import com.google.gson.JsonObject;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.projectile.AbstractArrow;
import net.minecraft.world.item.AxeItem;
import net.minecraft.world.item.DiggerItem;
import net.minecraft.world.item.SwordItem;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

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
	/**
	 * A hostile already in bow range ends the current skill. The response is
	 * deliberately short: a reflex is allowed to dodge, not to freeze the
	 * body for the rest of the fight. After this window the planner gets to
	 * choose attack or retreat with a fresh observation.
	 */
	private static final int THREAT_RESPONSE_TICKS = 20 * 2;
	private static final int THREAT_RETRY_TICKS = 20 * 4;
	private static final double THREAT_DISTANCE = 7.0;
	/**
	 * A creeper at nine blocks is not a fuse. The old through-wall range kept
	 * the threat response pinned every tick, so every goto, swim and mine was
	 * cancelled while the creeper stood on the far bank. Five blocks is close
	 * enough that the next second matters; farther away the planner can move.
	 */
	private static final double CREEPER_DISTANCE = 5.0;
	/** Only a genuinely adjacent mob keeps extending the reflex window. */
	private static final double THREAT_PIN_DISTANCE = 4.0;
	private static final double ARROW_DISTANCE = 10.0;
	private static final double MELEE_DISTANCE = 3.25;
	private static final float LOW_HEALTH = 6.0f;
	/**
	 * Low health is a condition, not an event. Re-reporting it every report
	 * cooldown would keep the runtime's danger window permanently open and
	 * prevent the recovery task (eating) from ever running. Alert once on
	 * entry, then reset only after health has recovered with hysteresis.
	 */
	private static final float LOW_HEALTH_CLEAR = 8.0f;
	/**
	 * A jump or a one-block step starts with a short fall distance, and a
	 * client tick can observe it before landing. Only a fall that would
	 * actually hurt (more than three blocks) is a reflex. Keeping this below
	 * the damage threshold means a normal mining/approach jump is not
	 * cancelled as "falling".
	 */
	private static final float FALL_DAMAGE_DISTANCE = 3.0f;
	/** Ignore a single airborne frame caused by jump/step-up physics. */
	private static final float IGNORE_MOMENTARY_FALL = 0.75f;
	/** A stale fallDistance with near-zero vertical motion is not a fall. */
	private static final double REAL_FALL_SPEED = -0.1;

	private final Consumer<JsonObject> send;
	private final long[] lastReportedAt = new long[Kind.values().length];
	private int ticks;
	private boolean retreated;
	private boolean lowHealthReported;
	private int threatResponseUntil;
	private int nextThreatAt;

	Reflexes(Consumer<JsonObject> send) {
		this.send = send;
	}

	/**
	 * Returns true when the body is in danger this tick. Callers must not
	 * advance a skill's state machine in that case: a walk that keeps pressing
	 * forward while standing in lava is worse than a cancelled task.
	 */
	boolean tick(Minecraft client, boolean agentControlled, boolean emergencyAction) {
		ticks++;
		if (!agentControlled) {
			// Reflex movement shares the same key mappings as the operator.
			// A nearby mob or a campfire must never steer a human player's
			// camera or release a key they are holding.
			retreated = false;
			return false;
		}
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
			if (!lowHealthReported) {
				lowHealthReported = true;
				dangerous = true;
				report(Kind.LOW_HEALTH, "血量只剩 " + Math.round(player.getHealth()) + " 点", player);
			}
		} else if (player.getHealth() > LOW_HEALTH_CLEAR) {
			lowHealthReported = false;
		}
		if (
			player.fallDistance > FALL_DAMAGE_DISTANCE
				&& player.getDeltaMovement().y < REAL_FALL_SPEED
				&& !player.onGround()
				&& !player.isFallFlying()
		) {
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
		// Hunger is a condition, not an immediate hazard. Treating it as a
		// reflex cancelled every climb, hunt and eat attempt as soon as the
		// bar reached two, so the body could never fix the starvation it was
		// reporting. The survival planner owns this decision; only lava,
		// falling, drowning, fire and mobs are immediate enough to preempt.
		/*
		 * A task the planner chose as its danger response (attack, pillar,
		 * emergency shaft or seal) must be allowed to finish. The reflex
		 * still guards lava, falls, fire and drowning, but it must not cancel
		 * the exact action that answers the mob. Without this the body
		 * strafed beside a zombie while every dig and attack was cancelled,
		 * and the live run lost nine tasks in a row before dying.
		 */
		if (emergencyAction) {
			threatResponseUntil = 0;
			nextThreatAt = 0;
		}
		Entity threat = emergencyAction ? null : nearestThreat(client, player);
		AbstractArrow arrow = emergencyAction ? null : incomingArrow(client, player);
		// A mob within seven blocks is not a two-second event. Extending the
		// response window while the same threat survives keeps the body
		// strafing, closing, or retreating every tick; the old fixed window
		// left a two-second gap where the planner owned the body but the
		// reflex immediately cancelled its first action. That gap read as
		// "walk, stop, stare at the zombie, die".
		if (
			threat != null &&
				threat.distanceToSqr(player) <=
					THREAT_PIN_DISTANCE * THREAT_PIN_DISTANCE
		) {
			threatResponseUntil = Math.max(threatResponseUntil, ticks + 4);
		}
		if ((threat != null || arrow != null) && ticks >= nextThreatAt) {
			threatResponseUntil = Math.max(threatResponseUntil, ticks + THREAT_RESPONSE_TICKS);
			nextThreatAt = ticks + THREAT_RETRY_TICKS;
			if (threat != null) {
				double distance = Math.sqrt(threat.distanceToSqr(player));
				report(
					Kind.THREAT,
					threat.getName().getString() + "离你 " + Math.round(distance) + " 格",
					player
				);
			} else if (arrow != null) {
				report(
					Kind.THREAT,
					"箭矢朝你飞来，距离 " + Math.round(Math.sqrt(arrow.distanceToSqr(player))) + " 格",
					player
				);
			}
		}
		if (ticks < threatResponseUntil) {
			dangerous = true;
		}

		if (dangerous) {
			releaseInputs(player);
			if (ticks < threatResponseUntil) {
				evade(client, player, threat, arrow);
			} else {
				escape(client, player);
			}
			retreated = true;
		} else if (retreated) {
			retreated = false;
			client.options.keyJump.setDown(false);
			if (player.input != null) player.input.tick(false, 1.0f);
		}
		return dangerous;
	}

	/**
	 * Danger ends the current action, so the body must not keep holding a key
	 * or swinging after it reports. The client reads these flags every tick.
	 */
	private static void releaseInputs(LocalPlayer player) {
		if (player.input != null) {
			player.input.up = false;
			player.input.down = false;
			player.input.left = false;
			player.input.right = false;
			player.input.jumping = false;
			player.input.shiftKeyDown = false;
			player.input.forwardImpulse = 0;
			player.input.leftImpulse = 0;
		}
		Minecraft client = Minecraft.getInstance();
		// Release the actual key mappings too, so vanilla does not rebuild a
		// forward move on the next frame after the reflex reports danger.
		GameActions.releaseWalkInput(client);
		GameActions.releaseMiningInput(client);
	}

	/**
	 * Native escape only: jumping clears lava and swims up out of water. It
	 * never walks toward an invented safe spot, because the agent owns route
	 * choice and a reflex that guesses can walk off a cliff.
	 */
	private static void escape(Minecraft client, LocalPlayer player) {
		// `jumpFromGround` only works on solid ground. A body that fell into
		// water has no ground to jump from, so the old escape released every
		// key and sank until it drowned. Vanilla swims upward while the jump
		// key is held; keep it held every dangerous tick and the normal input
		// path will carry the body to the surface.
		if (player.isInWater() || player.isEyeInFluid(FluidTags.WATER)) {
			client.options.keyJump.setDown(true);
			if (player.input != null) player.input.tick(false, 1.0f);
			return;
		}
		if (player.isInLava() || player.isEyeInFluid(FluidTags.LAVA)) {
			client.options.keyJump.setDown(true);
			if (player.input != null) player.input.tick(false, 1.0f);
		}
	}

	/**
	 * Keep the camera on the attacker so a close mob can be punched while the
	 * body strafes. A creeper and incoming arrow are never traded against:
	 * those two signals always ask for lateral or backward movement.
	 */
	private void evade(
		Minecraft client,
		LocalPlayer player,
		Entity threat,
		AbstractArrow arrow
	) {
		int side = (ticks / 20) % 2 == 0 ? 1 : -1;
		boolean swimming =
			player.isInWater() || player.isEyeInFluid(FluidTags.WATER);
		if (threat != null) {
			int weapon = bestWeaponSlot(player);
			boolean unarmed = weapon < 0;
			if (weapon >= 0) player.getInventory().selected = weapon;
			double distance = Math.sqrt(threat.distanceToSqr(player));
			Vec3 target = threat.getBoundingBox().getCenter();
			Vec3 direction = target.subtract(player.getEyePosition()).normalize();
			player.setYRot((float) Math.toDegrees(Math.atan2(-direction.x, direction.z)));
			player.setXRot(
				(float) Math.toDegrees(-Math.asin(Math.max(-1.0, Math.min(1.0, direction.y))))
			);
			// A fist loses a trade against every hostile. Turning around and
			// sprinting away is both more human and more survivable than
			// strafing backward while punching, especially after a respawn
			// with an empty inventory at night.
			if (unarmed || player.getHealth() < 12.0f || threat instanceof Creeper) {
				Vec3 away = player.position().subtract(target);
				if (away.lengthSqr() > 1.0e-4) {
					away = away.normalize();
					player.setYRot(
						(float) Math.toDegrees(Math.atan2(-away.x, away.z))
					);
					player.setXRot(0.0f);
				}
				GameActions.setCombatMove(client, side, false, true, true);
				if (swimming) client.options.keyJump.setDown(true);
				if (player.horizontalCollision && player.onGround()) {
					player.jumpFromGround();
				}
				return;
			}
			if (
				distance <= MELEE_DISTANCE
					&& player.getAttackStrengthScale(0.5f) >= 0.9f
			) {
				client.gameMode.attack(player, threat);
				player.swing(net.minecraft.world.InteractionHand.MAIN_HAND);
			}
			// A healthy body closes the gap while strafing instead of orbiting
			// forever at 3.7 blocks. Skeletons are weakest at melee range and
			// the old reflex only attacked inside 3.25, so it paced in bow
			// range until it was shot. Retreat/creeper still backs away.
			GameActions.setCombatMove(
				client,
				side,
				false,
				distance > MELEE_DISTANCE * 0.85,
				true
			);
			if (swimming) client.options.keyJump.setDown(true);
			if (player.horizontalCollision && player.onGround()) player.jumpFromGround();
			return;
		}
		// An arrow is dodged sideways, not by backing into its previous path.
		GameActions.setCombatMove(client, side, false, false, true);
		if (swimming) client.options.keyJump.setDown(true);
		if (player.horizontalCollision && player.onGround()) player.jumpFromGround();
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

	private static int bestWeaponSlot(LocalPlayer player) {
		int best = -1;
		int bestScore = 0;
		for (int slot = 0; slot < 9; slot++) {
			var stack = player.getInventory().getItem(slot);
			if (stack.isEmpty()) continue;
			int score = stack.getItem() instanceof SwordItem
				? 100
				: stack.getItem() instanceof AxeItem
					? 80
					: stack.getItem() instanceof DiggerItem
						? 40
						: 0;
			if (score > bestScore) {
				bestScore = score;
				best = slot;
			}
		}
		return best;
	}

	private static Entity nearestThreat(Minecraft client, LocalPlayer player) {
		return client.level
			.getEntitiesOfClass(
				Monster.class,
				player.getBoundingBox().inflate(9.0)
			)
			.stream()
			.filter(entity -> {
				if (!entity.isAlive()) return false;
				// A creeper can walk up behind the body and detonate without
				// ever entering the narrow forward view. Treat its proximity
				// as the danger signal even through foliage or a wall; a
				// false-positive sprint is cheaper than a lethal explosion.
				double range = entity instanceof Creeper ? CREEPER_DISTANCE : THREAT_DISTANCE;
				if (entity.distanceToSqr(player) > range * range) return false;
				return entity instanceof Creeper || player.hasLineOfSight(entity);
			})
			.findFirst()
			.orElse(null);
	}

	private static AbstractArrow incomingArrow(Minecraft client, LocalPlayer player) {
		Vec3 chest = player.position().add(0, 1, 0);
		return client.level
			.getEntitiesOfClass(
				AbstractArrow.class,
				player.getBoundingBox().inflate(ARROW_DISTANCE)
			)
			.stream()
			.filter(arrow ->
				arrow.isAlive()
					&& !arrow.onGround()
					&& arrow.getOwner() != player
					&& arrow.distanceToSqr(player) <= ARROW_DISTANCE * ARROW_DISTANCE
					&& arrow.getDeltaMovement().dot(chest.subtract(arrow.position())) > 0
			)
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
		THREAT("threat");

		final String wire;

		Kind(String wire) {
			this.wire = wire;
		}
	}
}
