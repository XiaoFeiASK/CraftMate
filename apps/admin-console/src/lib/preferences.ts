import { useCallback, useEffect, useMemo, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";
export type TextScale = 100 | 110 | 125;
export type Accent = "pine" | "blossom" | "ocean" | "plum";

export interface Preferences {
  readonly theme: ThemeMode;
  readonly textScale: TextScale;
  /** Turns off the scene, card, and drawer entrance animations. */
  readonly reduceMotion: boolean;
  readonly accent: Accent;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  textScale: 100,
  reduceMotion: false,
  accent: "pine",
};

export const PREFERENCE_STORAGE_KEY = "craftmate.preferences.v1";

const THEMES: readonly ThemeMode[] = ["system", "light", "dark"];
const SCALES: readonly TextScale[] = [100, 110, 125];
const ACCENTS: readonly Accent[] = ["pine", "blossom", "ocean", "plum"];

/**
 * Tolerates every kind of stored junk: an older build, a hand-edited value, or
 * a quota error must never stop the console from starting.
 */
export function parsePreferences(raw: string | null): Preferences {
  if (!raw) return DEFAULT_PREFERENCES;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (typeof value !== "object" || value === null) return DEFAULT_PREFERENCES;

  const candidate = value as Partial<Record<keyof Preferences, unknown>>;
  return {
    theme: THEMES.includes(candidate.theme as ThemeMode)
      ? (candidate.theme as ThemeMode)
      : DEFAULT_PREFERENCES.theme,
    textScale: SCALES.includes(candidate.textScale as TextScale)
      ? (candidate.textScale as TextScale)
      : DEFAULT_PREFERENCES.textScale,
    reduceMotion:
      typeof candidate.reduceMotion === "boolean"
        ? candidate.reduceMotion
        : DEFAULT_PREFERENCES.reduceMotion,
    accent: ACCENTS.includes(candidate.accent as Accent)
      ? (candidate.accent as Accent)
      : DEFAULT_PREFERENCES.accent,
  };
}

export function applyPreferences(preferences: Preferences): void {
  const root = document.documentElement;
  root.dataset.themeMode = preferences.theme;
  root.dataset.theme =
    preferences.theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preferences.theme;
  root.dataset.accent = preferences.accent;
  root.dataset.reduceMotion = String(preferences.reduceMotion);
  root.style.setProperty("--ui-scale", String(preferences.textScale / 100));
}

export interface PreferenceStore {
  readonly preferences: Preferences;
  readonly update: (patch: Partial<Preferences>) => void;
  readonly reset: () => void;
}

export function usePreferences(): PreferenceStore {
  const [preferences, setPreferences] = useState<Preferences>(() => readStored());

  // Applying during render, not only in the effect, keeps the first paint in
  // the stored theme instead of flashing light before hydration.
  if (typeof document !== "undefined" && typeof window !== "undefined") {
    applyPreferences(preferences);
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(PREFERENCE_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Private mode or a full quota: the choice still applies for this run.
    }
  }, [preferences]);

  // "Follow system" is resolved here rather than in CSS so the rest of the
  // stylesheet only ever has to know about the two concrete themes.
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = (): void => applyPreferences(preferences);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [preferences]);

  const update = useCallback((patch: Partial<Preferences>) => {
    setPreferences((current) => ({ ...current, ...patch }));
  }, []);

  const reset = useCallback(() => setPreferences(DEFAULT_PREFERENCES), []);

  return useMemo(() => ({ preferences, update, reset }), [preferences, update, reset]);
}

function readStored(): Preferences {
  try {
    return parsePreferences(window.localStorage.getItem(PREFERENCE_STORAGE_KEY));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}
