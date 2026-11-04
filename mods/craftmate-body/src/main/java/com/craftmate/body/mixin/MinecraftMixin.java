package com.craftmate.body.mixin;

import com.craftmate.body.bridge.GameActions;
import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

@Mixin(Minecraft.class)
public abstract class MinecraftMixin {
	@ModifyVariable(method = "continueAttack", at = @At("HEAD"), argsOnly = true)
	private boolean craftmate$keepMining(boolean continueAttack) {
		return continueAttack || GameActions.holdsMiningInput();
	}
}
