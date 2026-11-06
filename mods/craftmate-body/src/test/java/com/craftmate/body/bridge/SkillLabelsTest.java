package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class SkillLabelsTest {
	@Test
	void translatesEveryExecutableSkill() {
		assertEquals("前往", SkillLabels.displayName("goto"));
		assertEquals("看向", SkillLabels.displayName("look_at"));
		assertEquals("挖掘", SkillLabels.displayName("mine_block"));
		assertEquals("砍树", SkillLabels.displayName("chop_tree"));
		assertEquals("拾取", SkillLabels.displayName("collect_items"));
		assertEquals("合成", SkillLabels.displayName("craft"));
		assertEquals("存放", SkillLabels.displayName("deposit"));
		assertEquals("说话", SkillLabels.displayName("say"));
		assertEquals("等待", SkillLabels.displayName("wait"));
		assertEquals("攻击", SkillLabels.displayName("attack"));
		assertEquals("装备", SkillLabels.displayName("equip"));
		assertEquals("进食", SkillLabels.displayName("eat"));
		assertEquals("使用方块", SkillLabels.displayName("use_block"));
		assertEquals("放置方块", SkillLabels.displayName("place_block"));
		assertEquals("垫高", SkillLabels.displayName("pillar_up"));
		assertEquals("睡觉", SkillLabels.displayName("sleep"));
	}

	@Test
	void keepsUnknownIdsVisibleForDiagnostics() {
		assertEquals("future_skill", SkillLabels.displayName("future_skill"));
	}
}
