export const COMMITMENT_STATUSES = [
  "proposed",
  "spoken",
  "accepted",
  "in_progress",
  "fulfilled",
  "expired",
  "broken",
  "cancelled",
] as const;

export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<CommitmentStatus> = new Set([
  "fulfilled",
  "expired",
  "broken",
  "cancelled",
]);

/**
 * The state machine is data, not a pile of if-statements, so illegal
 * transitions are impossible to introduce by accident.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<CommitmentStatus, readonly CommitmentStatus[]>> = {
  proposed: ["spoken", "cancelled", "expired"],
  spoken: ["accepted", "cancelled", "expired"],
  accepted: ["in_progress", "cancelled", "expired"],
  in_progress: ["fulfilled", "broken", "cancelled", "expired"],
  fulfilled: [],
  expired: [],
  broken: [],
  cancelled: [],
};

export const canTransition = (from: CommitmentStatus, to: CommitmentStatus): boolean =>
  ALLOWED_TRANSITIONS[from].includes(to);
