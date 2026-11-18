package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.Test;

class OrbitalRigTest {
	private static final Vec3 EYE = new Vec3(10.0, 65.0, 10.0);
	private static final Vec3 BODY = new Vec3(10.0, 64.4, 10.0);

	@Test
	void startsBehindTheBodyAtTheConfiguredRadius() {
		OrbitalRig rig = new OrbitalRig();
		rig.initialize(0.0f, 0.0f, 8.0);

		OrbitalRig.Frame frame = rig.step(1.0f / 60.0f, EYE, BODY);

		assertEquals(10.0, frame.x(), 1.0e-6);
		assertEquals(65.0, frame.y(), 1.0e-6);
		assertEquals(2.0, frame.z(), 1.0e-6);
		assertEquals(0.0f, frame.yaw(), 1.0e-4f);
		assertTrue(frame.pitch() > 0.0f);
	}

	@Test
	void alwaysAimsAtTheBodyInsteadOfKeepingTheOrbitAngle() {
		OrbitalRig rig = new OrbitalRig();
		rig.initialize(35.0f, 20.0f, 7.0);

		OrbitalRig.Frame frame = rig.step(1.0f / 60.0f, EYE, BODY);

		assertEquals(
			OrbitalRig.aimYaw(frame.x(), frame.z(), BODY.x, BODY.z),
			frame.yaw(),
			1.0e-4f
		);
		assertEquals(
			OrbitalRig.aimPitch(frame.x(), frame.y(), frame.z(), BODY.x, BODY.y, BODY.z),
			frame.pitch(),
			1.0e-4f
		);
	}

	@Test
	void manualOrbitEasesInsteadOfSnapping() {
		OrbitalRig rig = new OrbitalRig();
		rig.initialize(0.0f, 0.0f, 8.0);
		rig.addOrbit(90.0f, 0.0f);

		OrbitalRig.Frame first = rig.step(1.0f / 60.0f, EYE, BODY);
		assertTrue(first.yaw() > 0.0f && first.yaw() < 20.0f);

		for (int frame = 0; frame < 240; frame++) {
			rig.step(1.0f / 60.0f, EYE, BODY);
		}
		assertEquals(90.0f, rig.yaw(), 0.5f);
	}

	@Test
	void programmaticLookTargetEasesTheOrbitToTheRequestedAngle() {
		OrbitalRig rig = new OrbitalRig();
		rig.initialize(0.0f, 0.0f, 8.0);
		rig.aimAt(-45.0f, 20.0f);

		rig.step(1.0f / 60.0f, EYE, BODY);
		assertTrue(rig.yaw() < 0.0f && rig.yaw() > -20.0f);

		for (int frame = 0; frame < 240; frame++) {
			rig.step(1.0f / 60.0f, EYE, BODY);
		}
		assertEquals(-45.0f, rig.yaw(), 0.5f);
		assertEquals(20.0f, rig.pitch(), 0.5f);
	}

	@Test
	void scrollAndOrbitRespectTheirLimits() {
		OrbitalRig rig = new OrbitalRig();
		rig.initialize(0.0f, 0.0f, 8.0);

		rig.addZoom(1_000.0);
		for (int frame = 0; frame < 240; frame++) {
			rig.step(1.0f / 60.0f, EYE, BODY);
		}
		assertEquals(OrbitalRig.MIN_RADIUS, rig.distance(), 1.0e-5);

		rig.addZoom(-1_000.0);
		for (int frame = 0; frame < 240; frame++) {
			rig.step(1.0f / 60.0f, EYE, BODY);
		}
		assertEquals(OrbitalRig.MAX_RADIUS, rig.distance(), 1.0e-5);

		rig.addOrbit(0.0f, 1_000.0f);
		for (int frame = 0; frame < 240; frame++) {
			rig.step(1.0f / 60.0f, EYE, BODY);
		}
		assertEquals(OrbitalRig.MAX_PITCH_DEGREES, rig.pitch(), 1.0e-4f);
	}
}
