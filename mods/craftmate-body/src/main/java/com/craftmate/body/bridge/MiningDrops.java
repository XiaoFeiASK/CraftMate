package com.craftmate.body.bridge;

import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;

/**
 * A broken block and its inventory drop are often different item ids (stone
 * becomes cobblestone, iron ore becomes raw iron). Pickup confirmation must
 * follow the drop, not merely accept any leaf or apple that happened to land
 * beside the body.
 */
final class MiningDrops {
	private MiningDrops() {
	}

	static Set<String> expectedFor(BlockState state) {
		ResourceLocation id = BuiltInRegistries.BLOCK.getKey(state.getBlock());
		String item = BuiltInRegistries.ITEM.getKey(state.getBlock().asItem()).toString();
		return expectedFor(
			id.toString(),
			item,
			state.is(BlockTags.LOGS),
			state.is(BlockTags.LEAVES)
		);
	}

	/**
	 * Pure mapping kept separate from the live registry so the common block
	 * conversions remain unit-testable. Unknown blocks use their normal item
	 * form; leaves intentionally accept any leaf-related drop.
	 */
	static Set<String> expectedFor(
		String blockId,
		String defaultItem,
		boolean log,
		boolean leaves
	) {
		if (log) return Set.of(blockId);
		if (leaves) return Set.of();
		return switch (blockId) {
			case "minecraft:stone" -> Set.of("minecraft:cobblestone");
			case "minecraft:deepslate" -> Set.of("minecraft:cobbled_deepslate");
			case "minecraft:grass_block", "minecraft:podzol", "minecraft:mycelium" ->
				Set.of("minecraft:dirt");
			case "minecraft:gravel" -> Set.of("minecraft:gravel", "minecraft:flint");
			case "minecraft:snow_block" -> Set.of("minecraft:snowball");
			case "minecraft:clay" -> Set.of("minecraft:clay_ball");
			case "minecraft:coal_ore", "minecraft:deepslate_coal_ore" ->
				Set.of("minecraft:coal");
			case "minecraft:iron_ore", "minecraft:deepslate_iron_ore" ->
				Set.of("minecraft:raw_iron");
			case "minecraft:copper_ore", "minecraft:deepslate_copper_ore" ->
				Set.of("minecraft:raw_copper");
			case "minecraft:gold_ore", "minecraft:deepslate_gold_ore" ->
				Set.of("minecraft:raw_gold");
			case "minecraft:redstone_ore", "minecraft:deepslate_redstone_ore" ->
				Set.of("minecraft:redstone");
			case "minecraft:lapis_ore", "minecraft:deepslate_lapis_ore" ->
				Set.of("minecraft:lapis_lazuli");
			case "minecraft:diamond_ore", "minecraft:deepslate_diamond_ore" ->
				Set.of("minecraft:diamond");
			case "minecraft:emerald_ore", "minecraft:deepslate_emerald_ore" ->
				Set.of("minecraft:emerald");
			case "minecraft:nether_quartz_ore" -> Set.of("minecraft:quartz");
			case "minecraft:nether_gold_ore" -> Set.of("minecraft:gold_nugget");
			case "minecraft:melon" -> Set.of("minecraft:melon_slice");
			default ->
				defaultItem == null || defaultItem.isBlank() || "minecraft:air".equals(defaultItem)
					? Set.of()
					: Set.of(defaultItem);
		};
	}

	static boolean matches(ItemStack stack, Set<String> expected) {
		if (expected.isEmpty()) return true;
		if (stack.isEmpty()) return false;
		String item = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
		return expected.contains(item);
	}

	/** Keeps only the drops this block can produce; an empty set means any. */
	static Map<String, Integer> restrict(
		Map<String, Integer> gains,
		Set<String> expected
	) {
		if (expected.isEmpty()) return gains;
		Map<String, Integer> selected = new TreeMap<>();
		for (var entry : gains.entrySet()) {
			if (expected.contains(entry.getKey()) && entry.getValue() > 0) {
				selected.put(entry.getKey(), entry.getValue());
			}
		}
		return selected;
	}
}
