import type { Decision } from "@craftmate/contracts";
import type { Show } from "@craftmate/agent/application";

export interface SpeechHooks {
  /** Called after an action promise, if any, has been persisted. */
  speak(input: {
    readonly text: string;
    readonly decisionId: string;
    readonly commitmentId: string | null;
    readonly priority: Decision["priority"];
  }): void;
}

export interface SpeechOutcome {
  readonly commitmentId: string | null;
  readonly text: string;
}

/**
 * The only path from a planned decision to audio.
 *
 * Order is the invariant: reserve (commits to SQLite) → hand to Voice → Voice
 * marks spoken when actually playing. If Voice is missing or the reservation throws, nothing is said, and
 * the console still receives the decision with its speech text.
 */
export function speakDecision(
  show: Show,
  decision: Decision,
  voice: SpeechHooks | null,
): SpeechOutcome | null {
  const text = spokenText(decision.speech);
  if (text.length === 0) return null;
  // QUEUE can speak a model-generated explanation while retaining the "not
  // yet executed" decision and without carrying a skill.
  if (
    decision.decision !== "EXECUTE" &&
    decision.decision !== "ACK_ONLY" &&
    decision.decision !== "QUEUE"
  ) {
    return null;
  }

  // An operator takeover silences the agent without stopping the pipeline.
  if (show.snapshot().mode !== "agent" || !voice) return null;

  // A conversational reply or a queue explanation is not an action promise.
  const commitment = decision.decision === "EXECUTE" && decision.skill !== null
    ? show.reserveCommitment({ decision, utterance: text })
    : null;
  // The commitment stays "proposed" until Voice actually plays it. The Voice
  // service will emit events (speaking/spoken/failed) that drive the state.
  voice.speak({
    text,
    decisionId: decision.id,
    commitmentId: commitment?.id ?? null,
    priority: decision.priority,
  });
  return { commitmentId: commitment?.id ?? null, text };
}

/**
 * Internal coordinates and route bookkeeping are useful to the planner but
 * sound like a debug log when read aloud. Keep the decision itself intact and
 * remove only those parenthetical asides from the utterance.
 */
function spokenText(value: string): string {
  return value
    .replace(
      /[（(][^）)]*(?:[xyz]\s*=|坐标|第\s*\d+\s*阶|支线|复用|候选|分支)[^）)]*[）)]/giu,
      "",
    )
    .replace(/\s{2,}/gu, " ")
    .trim();
}
