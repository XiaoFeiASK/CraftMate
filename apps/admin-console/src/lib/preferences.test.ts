import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_PREFERENCES, PREFERENCE_STORAGE_KEY, parsePreferences } from "./preferences.ts";

assert.equal(PREFERENCE_STORAGE_KEY, "craftmate.preferences.v1");

describe("console preferences", () => {
  test("keeps a fully valid stored preference set", () => {
    const raw = JSON.stringify({
      theme: "dark",
      textScale: 125,
      reduceMotion: true,
      accent: "ocean",
    });
    assert.deepEqual(parsePreferences(raw), {
      theme: "dark",
      textScale: 125,
      reduceMotion: true,
      accent: "ocean",
    });
  });

  test("falls back per field instead of rejecting the whole object", () => {
    const raw = JSON.stringify({ theme: "neon", textScale: 110, reduceMotion: "yes" });
    assert.deepEqual(parsePreferences(raw), {
      ...DEFAULT_PREFERENCES,
      textScale: 110,
    });
  });

  test("returns defaults for missing or malformed storage", () => {
    assert.deepEqual(parsePreferences(null), DEFAULT_PREFERENCES);
    assert.deepEqual(parsePreferences("{not json"), DEFAULT_PREFERENCES);
    assert.deepEqual(parsePreferences("[]"), DEFAULT_PREFERENCES);
  });
});
