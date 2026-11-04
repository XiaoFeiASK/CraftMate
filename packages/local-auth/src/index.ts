import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TOKEN_ENV = "CRAFTMATE_TOKEN";
export const TOKEN_FILE_ENV = "CRAFTMATE_TOKEN_FILE";

/**
 * In-process cache. Separate processes race through the atomic create below,
 * but repeated calls inside one service must not rewrite the file.
 */
let cached: { path: string; token: string } | null = null;

/** Default shared secret location for local processes. */
export function defaultTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[TOKEN_FILE_ENV];
  if (explicit && explicit.length > 0) return explicit;
  return join(homedir(), ".craftmate", "ingress-token");
}

/**
 * Reads the shared token, creating one on first use. The file is local-only:
 * a directory that cannot be made private is treated as an error rather than
 * silently weakening the permission.
 */
export function loadOrCreateToken(
  path: string = defaultTokenPath(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env[TOKEN_ENV]?.trim();
  if (fromEnv) return fromEnv;
  if (cached?.path === path) return cached.token;

  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) {
      cached = { path, token: existing };
      return existing;
    }
    // A short token is not a usable secret. Rewrite in place so concurrent
    // readers cannot observe a missing file and create a second secret.
    const token = randomBytes(32).toString("hex");
    writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
    cached = { path, token };
    return token;
  }

  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    // `link` fails when a concurrent process won the race; the winner's token
    // is then authoritative for every service.
    linkSync(temporary, path);
  } catch {
    /* another process created the file first */
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* already removed */
    }
  }
  const winner = readFileSync(path, "utf8").trim();
  chmodSync(path, 0o600);
  cached = { path, token: winner };
  return winner;
}

/** Constant-time comparison that never throws on mismatched lengths. */
export function tokenMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || actual.length === 0) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Loopback includes IPv4-mapped IPv6, which Node reports on dual-stack hosts. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized.startsWith("127.")
  );
}
