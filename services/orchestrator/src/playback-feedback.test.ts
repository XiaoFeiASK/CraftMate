import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Show, dafeiyu } from "@craftmate/agent";
import { CommitmentLedger } from "@craftmate/agent/commitment";
import type { Decision, VoiceSubtitle } from "@craftmate/contracts";
import { speakDecision } from "./transport/speech.ts";

const actionDecision = (outcome: Decision["outcome"] = null): Decision => ({
  id: "d-1",
  eventId: "evt-1",
  nickname: "观众",
  text: "砍木头",
  intent: "mine",
  decision: "EXECUTE",
  priority: "command",
  reason: "目标允许",
  score: 1,
  stage: "planned",
  skill: { name: "chop_tree", args: { count: 1 }, idempotencyKey: "tree-1" },
  speech: "我去砍一棵树。",
  audienceRef: "viewer:hashed",
  trace: null,
  at: 1_000,
  outcome,
});

function harness(): { show: Show; ledger: CommitmentLedger } {
  const ledger = new CommitmentLedger({ now: () => 1_000, newId: () => "promise-1" });
  const show = new Show({ persona: dafeiyu, ledger, clock: { now: () => 1_000, newId: () => "d-1" } });
  show.recordRuntimeDecision(actionDecision());
  return { show, ledger };
}

const subtitle = (state: VoiceSubtitle["state"]): VoiceSubtitle => ({
  id: `voice-${state}`,
  text: "我去砍一棵树。",
  state,
  decisionId: "d-1",
  commitmentId: "promise-1",
  code: null,
  detail: "",
  at: 1_100,
});

describe("playback and action commitment lifecycle", () => {
  test("only confirmed speech plus a successful action fulfills the promise", () => {
    const { show, ledger } = harness();
    speakDecision(show, actionDecision(), { speak: () => undefined });
    show.applyPlaybackFeedback(subtitle("speaking"));
    show.applyPlaybackFeedback(subtitle("spoken"));
    assert.equal(ledger.get("promise-1")?.status, "spoken");

    show.settleDecision("d-1", { status: "completed", outcome: null, at: 2_000 });
    assert.equal(ledger.get("promise-1")?.status, "fulfilled");
    assert.equal(show.snapshot().stats.openCommitments, 0);
  });

  test("completed action arriving before playback waits for playback evidence", () => {
    const { show, ledger } = harness();
    speakDecision(show, actionDecision(), { speak: () => undefined });
    show.settleDecision("d-1", { status: "completed", outcome: null, at: 2_000 });
    assert.equal(ledger.get("promise-1")?.status, "proposed");
    show.applyPlaybackFeedback(subtitle("speaking"));
    assert.equal(ledger.get("promise-1")?.status, "fulfilled");
  });

  test("a failed action closes as cancelled, never as fulfilled", () => {
    const { show, ledger } = harness();
    speakDecision(show, actionDecision(), { speak: () => undefined });
    show.applyPlaybackFeedback(subtitle("speaking"));
    show.settleDecision("d-1", {
      status: "failed",
      errorCode: "E_TOOL",
      outcome: null,
      at: 2_000,
    });
    assert.equal(ledger.get("promise-1")?.status, "cancelled");
    assert.equal(show.snapshot().stats.openCommitments, 0);
  });
});
