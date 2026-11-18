package com.craftmate.body.render;

import com.craftmate.body.bridge.ThirdPersonCamera;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.Tesselator;
import com.mojang.blaze3d.vertex.VertexConsumer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import net.minecraft.client.Camera;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.LevelRenderer;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import org.lwjgl.opengl.GL11;

/**
 * Re-draws the camera-facing faces of blocks covering the local body with a
 * translucent block shader. The body itself was rendered opaque in the entity
 * pass, so the result is visible through a translucent wall, not a ghost body.
 */
public final class OccluderOverlay {
	private OccluderOverlay() {
	}

	public static void render(Camera camera, float partialTick) {
		if (!ThirdPersonCamera.overlayVisible()) return;
		float alpha = ThirdPersonCamera.overlayAlpha();
		List<BlockPos> blocks = ThirdPersonCamera.occluders();
		if (alpha <= 0.003f || blocks.isEmpty()) return;
		Minecraft client = Minecraft.getInstance();
		Level level = client.level;
		if (level == null) return;
		Vec3 cameraPosition = camera.getPosition();
		List<BlockPos> sorted = new ArrayList<>(blocks);
		sorted.sort(
			Comparator.comparingDouble(
				pos -> -Vec3.atCenterOf(pos).distanceToSqr(cameraPosition)
			)
		);

		PoseStack pose = new PoseStack();
		pose.mulPose(camera.rotation());
		MultiBufferSource.BufferSource buffers = MultiBufferSource.immediate(
			Tesselator.getInstance().getBuilder()
		);
		MultiBufferSource translucent = type -> new AlphaVertexConsumer(
			buffers.getBuffer(RenderType.translucent()),
			alpha
		);

		RenderSystem.enableBlend();
		RenderSystem.defaultBlendFunc();
		RenderSystem.enableDepthTest();
		RenderSystem.depthFunc(GL11.GL_LEQUAL);
		RenderSystem.depthMask(false);
		for (BlockPos pos : sorted) {
			BlockState state = level.getBlockState(pos);
			if (!com.craftmate.body.bridge.CameraProbe.isOpaqueSolid(level, pos)) continue;
			pose.pushPose();
			pose.translate(
				pos.getX() - cameraPosition.x,
				pos.getY() - cameraPosition.y,
				pos.getZ() - cameraPosition.z
			);
			client.getBlockRenderer().renderSingleBlock(
				state,
				pose,
				translucent,
				LevelRenderer.getLightColor(level, pos),
				OverlayTexture.NO_OVERLAY
			);
			pose.popPose();
		}
		buffers.endBatch();
		RenderSystem.setShaderColor(1.0f, 1.0f, 1.0f, 1.0f);
		RenderSystem.depthMask(true);
		RenderSystem.depthFunc(GL11.GL_LEQUAL);
		RenderSystem.disableBlend();
	}

	/**
	 * ModelBlockRenderer supplies the vertex colour but not an alpha. Baking
	 * the fade into every vertex keeps the translucency independent of which
	 * shader RenderType selects when the buffer is flushed.
	 */
	private static final class AlphaVertexConsumer implements VertexConsumer {
		private final VertexConsumer delegate;
		private final float alpha;

		private AlphaVertexConsumer(VertexConsumer delegate, float alpha) {
			this.delegate = delegate;
			this.alpha = alpha;
		}

		@Override
		public VertexConsumer vertex(double x, double y, double z) {
			delegate.vertex(x, y, z);
			return this;
		}

		@Override
		public VertexConsumer color(int red, int green, int blue, int channelAlpha) {
			delegate.color(red, green, blue, Math.round(channelAlpha * alpha));
			return this;
		}

		@Override
		public VertexConsumer color(float red, float green, float blue, float channelAlpha) {
			delegate.color(red, green, blue, channelAlpha * alpha);
			return this;
		}

		@Override
		public VertexConsumer uv(float u, float v) {
			delegate.uv(u, v);
			return this;
		}

		@Override
		public VertexConsumer overlayCoords(int u, int v) {
			delegate.overlayCoords(u, v);
			return this;
		}

		@Override
		public VertexConsumer uv2(int u, int v) {
			delegate.uv2(u, v);
			return this;
		}

		@Override
		public VertexConsumer normal(float x, float y, float z) {
			delegate.normal(x, y, z);
			return this;
		}

		@Override
		public void endVertex() {
			delegate.endVertex();
		}

		@Override
		public void defaultColor(int red, int green, int blue, int channelAlpha) {
			delegate.defaultColor(red, green, blue, Math.round(channelAlpha * alpha));
		}

		@Override
		public void unsetDefaultColor() {
			delegate.unsetDefaultColor();
		}
	}
}
