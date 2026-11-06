package com.craftmate.body.bridge;

/**
 * Human-readable status labels stay at the presentation boundary. Skill IDs
 * remain stable English protocol values for planning, validation and storage.
 */
final class SkillLabels {
	private SkillLabels() {
	}

	static String displayName(String skill) {
		return switch (skill) {
			case "goto" -> "前往";
			case "follow" -> "跟随";
			case "flee" -> "逃离";
			case "look_at" -> "看向";
			case "mine_block" -> "挖掘";
			case "chop_tree" -> "砍树";
			case "collect_items" -> "拾取";
			case "craft" -> "合成";
			case "equip" -> "装备";
			case "eat" -> "进食";
			case "deposit" -> "存放";
			case "place_block" -> "放置方块";
			case "pillar_up" -> "垫高";
			case "build_schematic" -> "建造";
			case "attack" -> "攻击";
			case "use_block" -> "使用方块";
			case "sleep" -> "睡觉";
			case "say" -> "说话";
			case "emote" -> "表情";
			case "wait" -> "等待";
			default -> skill;
		};
	}
}
