import type { Decision } from "@craftmate/contracts";
import type { Show } from "@craftmate/agent/application";

export interface SpeechHooks {
  /** Called only after the commitment row is durable. */
  speak(input: {
    readonly text: string;
    readonly decisionId: string;
    readonly commitmentId: string;
    readonly priority: Decision["priority"];
  }): void;
}

export interface SpeechOutcome {
  readonly commitmentId: string;
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
  const text = decision.speech.trim();
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

  const commitment = show.reserveCommitment({ decision, utterance: text });
  // The commitment stays "proposed" until Voice actually plays it. The Voice
  // service will emit events (speaking/spoken/failed) that drive the state.
  voice.speak({
    text,
    decisionId: decision.id,
    commitmentId: commitment.id,
    priority: decision.priority,
  });
  return { commitmentId: commitment.id, text };
}
