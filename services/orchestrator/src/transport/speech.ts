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
 * Order is the invariant: reserve (commits to SQLite) → mark spoken → hand to
 * Voice. If Voice is missing or the reservation throws, nothing is said, and
 * the console still receives the decision with its speech text.
 */
export function speakDecision(
  show: Show,
  decision: Decision,
  voice: SpeechHooks | null,
): SpeechOutcome | null {
  const text = decision.speech.trim();
  if (text.length === 0) return null;
  if (decision.decision !== "EXECUTE" && decision.decision !== "ACK_ONLY") return null;

  // An operator takeover silences the agent without stopping the pipeline.
  if (show.snapshot().mode !== "agent" || !voice) return null;

  const commitment = show.reserveCommitment({ decision, utterance: text });
  show.ledger.transition(commitment.id, "spoken", "handed to voice");
  voice.speak({
    text,
    decisionId: decision.id,
    commitmentId: commitment.id,
    priority: decision.priority,
  });
  return { commitmentId: commitment.id, text };
}
