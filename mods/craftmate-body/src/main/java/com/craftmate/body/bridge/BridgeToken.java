package com.craftmate.body.bridge;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

final class BridgeToken {
	private BridgeToken() {
	}

	static String loadOrCreate(Path path) throws IOException {
		if (Files.exists(path)) {
			return read(path);
		}
		Path parent = path.getParent();
		if (parent != null) {
			Files.createDirectories(parent);
		}
		String token = java.util.UUID.randomUUID().toString() + "-" + java.util.UUID.randomUUID();
		Files.writeString(path, token, StandardCharsets.UTF_8);
		try {
			Files.setPosixFilePermissions(path, java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
		} catch (UnsupportedOperationException ignored) {
			// Non-POSIX systems do not expose chmod; the file remains user-only
			// where the OS supports it.
		}
		return token;
	}

	private static String read(Path path) throws IOException {
		String token = Files.readString(path, StandardCharsets.UTF_8).trim();
		if (token.length() < 16) {
			throw new IOException("bridge token at " + path + " is too short");
		}
		return token;
	}
}
