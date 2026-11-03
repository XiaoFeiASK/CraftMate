import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const TOKEN_BYTES = 32;

export interface BridgeTokenOptions {
  /** Absolute path, or a user-directory override for tests. */
  readonly file?: string;
  /** Test hook for creating a fresh token in a temporary directory. */
  readonly home?: string;
}

/**
 * Reads the bridge token, creating it on first use with 0600 permissions.
 * One token belongs to one body; never reuse `/control` or `/ingress` tokens.
 */
export function loadOrCreateBridgeToken(options: BridgeTokenOptions = {}): string {
  const file =
    options.file ?? join(options.home ?? homedir(), ".craftmate", "bridge.token");
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length < 16) throw new Error(`bridge token at ${file} is too short`);
    return existing;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}
