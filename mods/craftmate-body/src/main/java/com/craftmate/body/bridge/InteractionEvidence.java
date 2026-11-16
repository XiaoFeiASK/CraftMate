package com.craftmate.body.bridge;

import java.util.Map;

/**
 * Pure comparisons for confirming an interaction after its native API has
 * been submitted. A positive API return means "the client accepted the
 * request", not "the world changed"; these helpers keep that distinction
 * testable without a live client.
 */
final class InteractionEvidence {
	/** How long to wait for an observable effect before reporting unknown. */
	static final int CONFIRM_TICKS = 20;
	private static final Map<String, String> WALL_PLACEMENT_VARIANTS = Map.of(
		"minecraft:torch",
		"minecraft:wall_torch",
		"minecraft:redstone_torch",
		"minecraft:redstone_wall_torch",
		"minecraft:soul_torch",
		"minecraft:soul_wall_torch"
	);

	private InteractionEvidence() {
	}

	/**
	 * A complete block observation. `state` includes properties, so opening a
	 * door or a chest is distinguishable even when the block ID is the same.
	 */
	record BlockSnapshot(
		String blockId,
		String state,
		boolean air,
		boolean replaceable,
		boolean fluid
	) {
	}

	record TargetSnapshot(int entityId, float health, boolean alive, boolean visible, double distance) {
	}

	/**
	 * Some items intentionally place a different block id depending on the
	 * clicked face. A torch on a wall is still the requested torch; comparing
	 * only the item id to the resulting block id rejects a real placement.
	 */
	static boolean placementMatches(String expectedBlock, String actualBlock) {
		if (expectedBlock == null || actualBlock == null) return false;
		if (expectedBlock.equals(actualBlock)) return true;
		return WALL_PLACEMENT_VARIANTS.get(expectedBlock) != null
			&& WALL_PLACEMENT_VARIANTS.get(expectedBlock).equals(actualBlock);
	}

	/**
	 * A placement is confirmed only when the previously replaceable cell now
	 * holds the requested block. A stack count change alone is not enough:
	 * the client can consume an item before the server accepts the placement.
	 */
	static boolean placementConfirmed(
		String expectedBlock,
		BlockSnapshot before,
		BlockSnapshot after,
		int beforeCount,
		int afterCount,
		boolean creative
	) {
		if (expectedBlock == null || after == null) return false;
		if (!placementMatches(expectedBlock, after.blockId()) || after.air()) return false;
		if (before != null && !before.replaceable()) return false;
		if (creative) return true;
		return afterCount < beforeCount;
	}

	/**
	 * A use is confirmed by a world/inventory effect. Merely opening a screen
	 * is not proof on its own for a block use, but it is observable; the
	 * caller reports that separately from a proven world change.
	 */
	static boolean useConfirmed(
		BlockSnapshot before,
		BlockSnapshot after,
		int beforeCount,
		int afterCount
	) {
		if (before == null || after == null) return false;
		if (beforeCount != afterCount) return true;
		return !before.state().equals(after.state());
	}

	/**
	 * An attack is only "hit" when the same entity lost health or died while
	 * remaining the same entity. A swing with no health change is a swing,
	 * not a hit; an entity that despawned is unconfirmed, not killed.
	 */
	static boolean attackConfirmed(TargetSnapshot before, TargetSnapshot after) {
		if (before == null || after == null) return false;
		if (before.entityId() != after.entityId()) return false;
		if (after.health() < before.health() - 0.001f) return true;
		return before.alive() && !after.alive();
	}

	/**
	 * A target that is gone, dead before the swing, out of range or no longer
	 * visible cannot be attacked. Returning a reason keeps the task from
	 * claiming a hit it never had a chance to make.
	 */
	static String attackBlocked(TargetSnapshot target) {
		if (target == null) return "target is no longer present";
		if (!target.visible()) return "target is no longer visible";
		if (!target.alive()) return "target is already dead";
		if (target.distance() > 3.0) return "target is out of reach";
		return null;
	}

	/**
	 * Vanilla attacks deal full damage only near a full charge. A body that
	 * clicks as fast as the tick loop would keep landing weak hits and then
	 * report a failure that looks like a target problem.
	 */
	static boolean attackReady(float strength) {
		return strength >= 0.9f;
	}

	/** A durability delta is evidence only for the same tool. */
	static boolean durabilityChanged(String toolBefore, String toolAfter, int before, int after) {
		if (toolBefore == null || toolAfter == null) return false;
		return toolBefore.equals(toolAfter) && after > before;
	}

	/**
	 * An item stack changing kind is a successful use (for example a bucket
	 * becoming an empty bucket); the same stack with no world change is not.
	 */
	static boolean itemChanged(String beforeItem, int beforeCount, String afterItem, int afterCount) {
		if (beforeItem == null || afterItem == null) return false;
		return !beforeItem.equals(afterItem) || beforeCount != afterCount;
	}
}
