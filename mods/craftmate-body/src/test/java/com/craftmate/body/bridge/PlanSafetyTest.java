package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class PlanSafetyTest {
	@Test
	void aSafeBoundaryRequiresGroundBalanceAndNoOpenMenu() {
		assertTrue(PlanSafety.canCancel(new PlanSafety.State(true, false, false, 0.0, false)));
	}

	@Test
	void fallingLavaSuffocationAndOpenMenusPreventVoluntaryCancel() {
		assertFalse(PlanSafety.canCancel(new PlanSafety.State(false, false, false, 0.0, false)));
		assertFalse(PlanSafety.canCancel(new PlanSafety.State(true, true, false, 0.0, false)));
		assertFalse(PlanSafety.canCancel(new PlanSafety.State(true, false, true, 0.0, false)));
		assertFalse(PlanSafety.canCancel(new PlanSafety.State(true, false, false, 2.0, false)));
		assertFalse(PlanSafety.canCancel(new PlanSafety.State(true, false, false, 0.0, true)));
	}

	@Test
	void forcedCancelIsAlwaysAllowedButReportsWhetherItWasSafe() {
		assertTrue(
			PlanSafety.cancelDetail(new PlanSafety.State(false, true, false, 3.0, false), true)
				.contains("forced")
		);
	}
}
