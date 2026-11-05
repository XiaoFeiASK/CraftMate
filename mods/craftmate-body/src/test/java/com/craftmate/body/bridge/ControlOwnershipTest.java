package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ControlOwnershipTest {
	@Test
	void appliesTheServersOwner() {
		ControlOwnership control = new ControlOwnership();
		assertFalse(control.agentControlled());
		control.applyServerOwner("agent");
		assertTrue(control.agentControlled());
		control.applyServerOwner("operator");
		assertFalse(control.agentControlled());
		control.applyServerOwner("agent");
		assertTrue(control.agentControlled());
		control.applyServerOwner("none");
		assertFalse(control.agentControlled());
	}

	@Test
	void aLocalWatchdogDoesNotRevokeServerAuthority() {
		ControlOwnership control = new ControlOwnership();
		control.applyServerOwner("agent");
		control.onLocalWatchdog();
		assertTrue(control.agentControlled());
	}

	@Test
	void rejectsUnknownOwnersInsteadOfGuessing() {
		ControlOwnership control = new ControlOwnership();
		assertThrows(IllegalArgumentException.class, () -> control.applyServerOwner("self"));
	}
}
