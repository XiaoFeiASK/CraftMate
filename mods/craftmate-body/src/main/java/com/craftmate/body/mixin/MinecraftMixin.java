package com.craftmate.body.mixin;

import com.craftmate.body.bridge.GameActions;
import net.minecraft.client.Minecraft;
import net.minecraft.world.phys.BlockHitResult;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.ModifyVariable;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Minecraft.class)
public abstract class MinecraftMixin {
	@ModifyVariable(method = "continueAttack", at = @At("HEAD"), argsOnly = true)
	private boolean craftmate$keepMining(boolean continueAttack) {
		return continueAttack || GameActions.holdsMiningInput();
	}

	/**
	 * Vanilla recalculates the crosshair hit from the camera at the start of
	 * every tick, which overwrites the synthetic hit a task assigned at the end
	 * of the previous tick. Without this, vanilla and the task could take turns
	 * starting to destroy two different blocks and neither would ever break.
	 */
	@Inject(method = "continueAttack", at = @At("HEAD"))
	private void craftmate$mineTaskTarget(boolean continueAttack, CallbackInfo info) {
		BlockHitResult hit = GameActions.taskMiningHit();
		if (hit != null) ((Minecraft) (Object) this).hitResult = hit;
	}
}
