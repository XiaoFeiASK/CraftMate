import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { isLoopbackAddress, loadOrCreateToken, tokenMatches } from "./index.ts";

describe("local auth token", () => {
  test("creates a private token once and reuses it", () => {
    const dir = mkdtempSync(join(tmpdir(), "craftmate-auth-"));
    const path = join(dir, "token");
    const first = loadOrCreateToken(path, {});
    const second = loadOrCreateToken(path, {});

    assert.equal(first, second);
    assert.equal(first.length, 64);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  test("an explicit environment token wins over the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "craftmate-auth-"));
    const path = join(dir, "token");
    writeFileSync(path, "file-token-that-is-long-enough-1234");
    assert.equal(loadOrCreateToken(path, { CRAFTMATE_TOKEN: "env-token" }), "env-token");
  });

  test("a short legacy token is rotated instead of silently reused", () => {
    const dir = mkdtempSync(join(tmpdir(), "craftmate-auth-"));
    const path = join(dir, "token");
    writeFileSync(path, "weak-token\n", { mode: 0o600 });

    const first = loadOrCreateToken(path, {});
    const second = loadOrCreateToken(path, {});

    assert.notEqual(first, "weak-token");
    assert.equal(first.length, 64);
    assert.equal(second.length, 64);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  test("token comparison is exact", () => {
    assert.equal(tokenMatches("abc", "abc"), true);
    assert.equal(tokenMatches("abc", "abd"), false);
    assert.equal(tokenMatches("abc", ""), false);
    assert.equal(tokenMatches("abc", undefined), false);
  });
});

describe("loopback guard", () => {
  test("accepts IPv4, IPv6 and mapped loopback only", () => {
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::1"), true);
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackAddress("192.168.1.2"), false);
    assert.equal(isLoopbackAddress("::ffff:192.168.1.2"), false);
    assert.equal(isLoopbackAddress(undefined), false);
  });
});
