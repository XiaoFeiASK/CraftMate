package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.Test;

class OcclusionProbeTest {
	private static final AABB BODY = new AABB(0.2, 0.0, 0.2, 0.8, 1.8, 0.8);

	@Test
	void bodySamplesCoverTorsoLimbsAndEnds() {
		assertEquals(9, OcclusionProbe.samples(BODY).size());
	}

	@Test
	void wallBetweenCameraAndBodyIsCollected() {
		OcclusionProbe.Result result = OcclusionProbe.probe(
			new Vec3(0.5, 0.9, 3.5),
			BODY,
			pos -> pos.getZ() == 2,
			24
		);
		assertTrue(result.occluded());
		assertTrue(result.blocks().stream().allMatch(pos -> pos.getZ() == 2));
	}

	@Test
	void clearLineProducesNoOccluders() {
		OcclusionProbe.Result result = OcclusionProbe.probe(
			new Vec3(0.5, 0.9, 3.5),
			BODY,
			pos -> false,
			24
		);
		assertFalse(result.occluded());
		assertEquals(List.of(), result.blocks());
	}

	@Test
	void capLimitsTheOverlayWork() {
		OcclusionProbe.Result result = OcclusionProbe.probe(
			new Vec3(0.5, 0.9, 3.5),
			BODY,
			pos -> true,
			1
		);
		assertEquals(1, result.blocks().size());
	}

	@Test
	void cameraInsideAWallIgnoresItsOwnCell() {
		Vec3 camera = new Vec3(0.5, 0.9, 2.5);
		OcclusionProbe.Result result = OcclusionProbe.probe(
			camera,
			BODY,
			pos -> pos.getZ() == 2 || pos.getZ() == 1,
			24
		);
		assertTrue(result.occluded());
		assertFalse(result.blocks().contains(net.minecraft.core.BlockPos.containing(camera)));
	}
}
