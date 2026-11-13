package com.craftmate.body.bridge;

import java.io.IOException;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Loads every top-level bridge class during mod initialization.
 *
 * <p>Fabric loads classes lazily. Replacing the mod jar while the client is
 * still running used to surface a missing {@code ToolSelection} only when a
 * mining task first touched it, which looked like a random E_INTERNAL in the
 * decision log. Loading the whole package up front turns a corrupt or
 * half-installed jar into one explicit startup error.
 */
public final class BridgeSelfCheck {
	private static final Logger LOGGER = LoggerFactory.getLogger("craftmate-body-selfcheck");
	private static final String BRIDGE_PACKAGE = "com/craftmate/body/bridge/";

	private BridgeSelfCheck() {
	}

	/** Returns every top-level bridge class name that failed to load. */
	public static List<String> verify() {
		List<String> missing = new ArrayList<>();
		ClassLoader loader = BridgeSelfCheck.class.getClassLoader();
		for (String name : classNames()) {
			try {
				Class.forName(name, false, loader);
			} catch (Throwable error) {
				missing.add(name);
				LOGGER.error(
					"bridge self-check failed to load {}: {}",
					name,
					error.toString()
				);
			}
		}
		return List.copyOf(missing);
	}

	/** Package scan works for both a built jar and a Gradle classes directory. */
	public static List<String> classNames() {
		try {
			Path location = Path.of(
				BridgeSelfCheck.class.getProtectionDomain().getCodeSource().getLocation().toURI()
			);
			List<String> names = Files.isDirectory(location)
				? directoryClassNames(location)
				: jarClassNames(location);
			names.sort(String::compareTo);
			return List.copyOf(names);
		} catch (IOException | URISyntaxException error) {
			LOGGER.warn("bridge self-check could not enumerate classes: {}", error.toString());
			return List.of();
		}
	}

	private static List<String> directoryClassNames(Path root) throws IOException {
		Path bridge = root.resolve(BRIDGE_PACKAGE);
		if (!Files.isDirectory(bridge)) return List.of();
		List<String> names = new ArrayList<>();
		try (Stream<Path> files = Files.list(bridge)) {
			files.filter(Files::isRegularFile)
				.map((file) -> file.getFileName().toString())
				.filter((name) -> name.endsWith(".class") && !name.contains("$"))
				.forEach((name) -> names.add(
					"com.craftmate.body.bridge." + name.substring(0, name.length() - 6)
				));
		}
		return names;
	}

	private static List<String> jarClassNames(Path jarPath) throws IOException {
		List<String> names = new ArrayList<>();
		try (JarFile jar = new JarFile(jarPath.toFile())) {
			Enumeration<JarEntry> entries = jar.entries();
			while (entries.hasMoreElements()) {
				JarEntry entry = entries.nextElement();
				String name = entry.getName();
				if (
					entry.isDirectory()
						|| !name.startsWith(BRIDGE_PACKAGE)
						|| !name.endsWith(".class")
						|| name.contains("$")
				) {
					continue;
				}
				names.add(
					"com.craftmate.body.bridge." + name.substring(
						BRIDGE_PACKAGE.length(),
						name.length() - 6
					)
				);
			}
		}
		return names;
	}
}
