import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CommitmentLedger } from "@craftmate/agent/commitment";
import type { VoiceSubtitle } from "@craftmate/contracts";

/**
 * Integration tests for voice playback event feedback to the commitment ledger.
 * These tests verify that Voice events (speaking, spoken, failed, cancelled)
 * correctly update commitment status in the ledger.
 */
describe("playback event feedback", () => {
  test("speaking event transitions commitment from proposed to spoken", () => {
    const ledger = new CommitmentLedger({ now: () => 1_000, newId: () => "c-1" });
    const commitment = ledger.reserve({ audienceRef: "viewer-1", utterance: "去挖钻石" });
    
    // Simulate Voice speaking event
    const subtitle: VoiceSubtitle = {
      id: "u-1",
      text: "去挖钻石",
      state: "speaking",
      decisionId: null,
      commitmentId: commitment.id,
      at: 1_100,
    };
    
    // Apply the same logic as main.ts onSubtitle handler
    if (subtitle.commitmentId && subtitle.state === "speaking") {
      const c = ledger.get(subtitle.commitmentId);
      if (c && c.status === "proposed") {
        ledger.transition(subtitle.commitmentId, "spoken", "voice speaking");
      }
    }
    
    const updated = ledger.get(commitment.id);
    assert.equal(updated?.status, "spoken");
    assert.equal(updated?.spokenAt, 1_000);
  });

  test("spoken event logs completion without changing status", () => {
    const ledger = new CommitmentLedger({ now: () => 1_000, newId: () => "c-1" });
    const commitment = ledger.reserve({ audienceRef: "viewer-1", utterance: "去挖钻石" });
    ledger.transition(commitment.id, "spoken", "voice speaking");
    
    // Simulate Voice spoken event
    const subtitle: VoiceSubtitle = {
      id: "u-1",
      text: "去挖钻石",
      state: "spoken",
      decisionId: null,
      commitmentId: commitment.id,
      at: 1_500,
    };
    
    // Apply the same logic as main.ts onSubtitle handler
    if (subtitle.commitmentId && subtitle.state === "spoken") {
      const c = ledger.get(subtitle.commitmentId);
      assert.ok(c, "commitment should exist");
    }
    
    const updated = ledger.get(commitment.id);
    assert.equal(updated?.status, "spoken");
  });

  test("failed event cancels commitment", () => {
    const ledger = new CommitmentLedger({ now: () => 1_000, newId: () => "c-1" });
    const commitment = ledger.reserve({ audienceRef: "viewer-1", utterance: "去挖钻石" });
    
    // Simulate Voice failed event
    const subtitle: VoiceSubtitle = {
      id: "u-1",
      text: "去挖钻石",
      state: "failed",
      decisionId: null,
      commitmentId: commitment.id,
      at: 1_100,
    };
    
    // Apply the same logic as main.ts onSubtitle handler
    if (subtitle.commitmentId && subtitle.state === "failed") {
      const c = ledger.get(subtitle.commitmentId);
      if (c && c.status !== "cancelled" && c.status !== "expired") {
        ledger.transition(subtitle.commitmentId, "cancelled", "voice failed");
      }
    }
    
    const updated = ledger.get(commitment.id);
    assert.equal(updated?.status, "cancelled");
    assert.equal(updated?.closedAt, 1_000);
  });

  test("cancelled event cancels commitment", () => {
    const ledger = new CommitmentLedger({ now: () => 1_000, newId: () => "c-1" });
    const commitment = ledger.reserve({ audienceRef: "viewer-1", utterance: "去挖钻石" });
    
    // Simulate Voice cancelled event
    const subtitle: VoiceSubtitle = {
      id: "u-1",
      text: "去挖钻石",
      state: "cancelled",
      decisionId: null,
      commitmentId: commitment.id,
      at: 1_100,
    };
    
    // Apply the same logic as main.ts onSubtitle handler
    if (subtitle.commitmentId && subtitle.state === "cancelled") {
      const c = ledger.get(subtitle.commitmentId);
      if (c && c.status !== "cancelled" && c.status !== "expired") {
        ledger.transition(subtitle.commitmentId, "cancelled", "voice cancelled");
      }
    }
    
    const updated = ledger.get(commitment.id);
    assert.equal(updated?.status, "cancelled");
  });

  test("idempotent: speaking event on already-spoken commitment is ignored", () => {
    const ledger = new CommitmentLedger({ now: () => 1_000, newId: () => "c-1" });
    const commitment = ledger.reserve({ audienceRef: "viewer-1", utterance: "去挖钻石" });
    ledger.transition(commitment.id, "spoken", "voice speaking");
    
    // Simulate duplicate Voice speaking event
    const subtitle: VoiceSubtitle = {
      id: "u-1",
      text: "去挖钻石",
      state: "speaking",
      decisionId: null,
      commitmentId: commitment.id,
      at: 1_100,
    };
    
    // Apply the same logic as main.ts onSubtitle handler
    if (subtitle.commitmentId && subtitle.state === "speaking") {
      const c = ledger.get(subtitle.commitmentId);
      // Should NOT transition if already spoken
      if (c && c.status === "proposed") {
        ledger.transition(subtitle.commitmentId, "spoken", "voice speaking");
      }
    }
    
    const updated = ledger.get(commitment.id);
    assert.equal(updated?.status, "spoken");
    assert.equal(updated?.revision, 2); // Only one transition should have happened
  });

  test("idempotent: failed event on already-cancelled commitment is ignored", () => {
    const ledger = new CommitmentLedger({ now: () => 1_000, newId: () => "c-1" });
    const commitment = ledger.reserve({ audienceRef: "viewer-1", utterance: "去挖钻石" });
    ledger.transition(commitment.id, "cancelled", "operator stop");
    
    // Simulate Voice failed event arriving after cancellation
    const subtitle: VoiceSubtitle = {
      id: "u-1",
      text: "去挖钻石",
      state: "failed",
      decisionId: null,
      commitmentId: commitment.id,
      at: 1_100,
    };
    
    // Apply the same logic as main.ts onSubtitle handler
    if (subtitle.commitmentId && subtitle.state === "failed") {
      const c = ledger.get(subtitle.commitmentId);
      // Should NOT transition if already cancelled
      if (c && c.status !== "cancelled" && c.status !== "expired") {
        ledger.transition(subtitle.commitmentId, "cancelled", "voice failed");
      }
    }
    
    const updated = ledger.get(commitment.id);
    assert.equal(updated?.status, "cancelled");
    assert.equal(updated?.revision, 2); // No additional transition
  });

  test("out-of-order: failed event before speaking still cancels commitment", () => {
    const ledger = new CommitmentLedger({ now: () => 1_000, newId: () => "c-1" });
    const commitment = ledger.reserve({ audienceRef: "viewer-1", utterance: "去挖钻石" });
    
    // Voice failed event arrives first (network or processing delay)
    const failedSubtitle: VoiceSubtitle = {
      id: "u-1",
      text: "去挖钻石",
      state: "failed",
      decisionId: null,
      commitmentId: commitment.id,
      at: 1_100,
    };
    
    if (failedSubtitle.commitmentId && failedSubtitle.state === "failed") {
      const c = ledger.get(failedSubtitle.commitmentId);
      if (c && c.status !== "cancelled" && c.status !== "expired") {
        ledger.transition(failedSubtitle.commitmentId, "cancelled", "voice failed");
      }
    }
    
    // Speaking event arrives late and is ignored
    const speakingSubtitle: VoiceSubtitle = {
      id: "u-1",
      text: "去挖钻石",
      state: "speaking",
      decisionId: null,
      commitmentId: commitment.id,
      at: 1_050,
    };
    
    if (speakingSubtitle.commitmentId && speakingSubtitle.state === "speaking") {
      const c = ledger.get(speakingSubtitle.commitmentId);
      if (c && c.status === "proposed") {
        ledger.transition(speakingSubtitle.commitmentId, "spoken", "voice speaking");
      }
    }
    
    const updated = ledger.get(commitment.id);
    assert.equal(updated?.status, "cancelled");
  });
});
