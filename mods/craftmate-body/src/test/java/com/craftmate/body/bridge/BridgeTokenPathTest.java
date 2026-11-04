package com.craftmate.body.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class BridgeTokenPathTest {
	@Test
	void resolvesTheHomeDirectoryOfTheOperatingSystemAccount() {
		String previous = System.getProperty("user.home");
		try {
			System.setProperty("user.home", "/tmp/game-directory");
			assertEquals(
				Path.of(System.getenv("HOME"), ".craftmate", "bridge.token"),
				BridgeClient.defaultTokenPath()
			);
		} finally {
			System.setProperty("user.home", previous);
		}
	}
}
