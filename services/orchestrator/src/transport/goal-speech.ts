import type { Decision } from "@craftmate/contracts";

export interface GoalSpeechGateOptions {
  readonly minIntervalMs?: number;
  readonly repeatIntervalMs?: number;
  readonly now?: () => number;
}

/**
 * Autonomous goals settle a task every few seconds. Speaking every one of
 * those transitions would turn the voice channel into a command log, while
 * speaking none of them leaves the TTS service silent. This gate keeps the
 * natural middle ground: a new intention is voiced, repeated danger gets a
 * shorter cooldown, and an identical line is not looped.
 */
export class GoalSpeechGate {
  private readonly minIntervalMs: number;
  private readonly repeatIntervalMs: number;
  private readonly now: () => number;
  private lastSpokenAt = Number.NEGATIVE_INFINITY;
  private lastText = "";

  constructor(options: GoalSpeechGateOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 12_000;
    this.repeatIntervalMs = options.repeatIntervalMs ?? 45_000;
    this.now = options.now ?? Date.now;
  }

  /** Returns the text to speak, or null when this decision is throttled. */
  take(decision: Decision): string | null {
    if (decision.decision !== "EXECUTE") return null;
    const text = decision.speech.trim();
    if (text.length === 0) return null;
    const now = this.now();
    const elapsed = now - this.lastSpokenAt;
    const urgent =
      decision.intent === "danger" ||
      /低血量|撤离|威胁|苦力怕|僵尸|骷髅|着火|岩浆/u.test(decision.text);
    const minimum = urgent ? Math.min(5_000, this.minIntervalMs) : this.minIntervalMs;
    if (elapsed < minimum) return null;
    if (text === this.lastText && elapsed < this.repeatIntervalMs) return null;
    this.lastSpokenAt = now;
    this.lastText = text;
    return text;
  }
}
