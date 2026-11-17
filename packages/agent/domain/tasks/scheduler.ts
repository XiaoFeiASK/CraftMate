import type { FailureCategory, TaskNode, TaskPriority } from "./task-tree.ts";

const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
  operator: 0,
  reflex: 1,
  survival: 2,
  goal: 3,
  optional: 4,
};

export interface TargetObservation {
  readonly key: string;
  /** Higher is better. */
  readonly score: number;
  readonly at: number;
}

/**
 * Target hysteresis: an invalid current target changes immediately; a live
 * target only changes after a challenger wins twice by at least 20%.
 */
export class TargetHysteresis {
  private current: TargetObservation | null = null;
  private challenger: TargetObservation | null = null;
  private challengerWins = 0;
  private readonly improvement: number;
  private readonly requiredWins: number;

  constructor(improvement = 0.2, requiredWins = 2) {
    this.improvement = improvement;
    this.requiredWins = requiredWins;
  }

  observe(candidate: TargetObservation | null, currentValid = true): TargetObservation | null {
    if (!currentValid) {
      this.current = candidate;
      this.challenger = null;
      this.challengerWins = 0;
      return this.current;
    }
    if (candidate === null) return this.current;
    if (this.current === null) {
      this.current = candidate;
      return this.current;
    }
    if (candidate.key === this.current.key) {
      this.current = candidate;
      this.challenger = null;
      this.challengerWins = 0;
      return this.current;
    }
    const threshold = Math.abs(this.current.score) * this.improvement;
    if (candidate.score - this.current.score < threshold) {
      this.challenger = null;
      this.challengerWins = 0;
      return this.current;
    }
    if (this.challenger?.key !== candidate.key) {
      this.challenger = candidate;
      this.challengerWins = 1;
      return this.current;
    }
    this.challenger = candidate;
    this.challengerWins++;
    if (this.challengerWins >= this.requiredWins) {
      this.current = candidate;
      this.challenger = null;
      this.challengerWins = 0;
    }
    return this.current;
  }

  invalidate(): void {
    this.current = null;
    this.challenger = null;
    this.challengerWins = 0;
  }

  get target(): TargetObservation | null {
    return this.current;
  }
}

/**
 * The scheduler chooses one active node by priority, then tree order. It
 * never ticks a skill or executes game work itself.
 */
export class TaskScheduler {
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  choose(nodes: readonly TaskNode[]): TaskNode | null {
    const runnable = nodes.filter(
      (node) =>
        node.state === "active" ||
        node.state === "pending",
    );
    return (
      [...runnable].sort(
        (left, right) =>
          PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id),
      )[0] ?? null
    );
  }

  shouldPreempt(current: TaskNode | null, candidate: TaskNode): boolean {
    if (current === null) return true;
    return this.preemptsByPriority(current.priority, candidate.priority);
  }

  /** Priority-only form used before a candidate node has been materialised. */
  preemptsByPriority(current: TaskPriority, candidate: TaskPriority): boolean {
    return PRIORITY_RANK[candidate] < PRIORITY_RANK[current];
  }

  blockedUntil(_category: FailureCategory): number {
    return this.now();
  }
}
