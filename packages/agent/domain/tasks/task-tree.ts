export const TASK_STATES = [
  "pending",
  "active",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "invalidated",
  "paused",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_PRIORITIES = [
  "operator",
  "reflex",
  "survival",
  "goal",
  "optional",
] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_NODE_KINDS = [
  "goal",
  "stage",
  "milestone",
  "task",
  "skill",
  "interrupt",
] as const;
export type TaskNodeKind = (typeof TASK_NODE_KINDS)[number];

export const TASK_NODE_MODES = ["sequence", "selector"] as const;
export type TaskNodeMode = (typeof TASK_NODE_MODES)[number];

export const TASK_TRIGGERS = ["danger", "tool-lost", "operator"] as const;
export type TaskTrigger = (typeof TASK_TRIGGERS)[number];

export type FailureCategory =
  | "precondition"
  | "unreachable"
  | "not_observed"
  | "evidence_conflict"
  | "world_changed"
  | "danger"
  | "operator"
  | "timeout"
  | "internal";

export interface TaskNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: TaskNodeKind;
  readonly mode: TaskNodeMode | null;
  readonly handler: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly trigger: TaskTrigger | null;
  readonly intent: string;
  readonly targetFamily: string;
  readonly quantity: number;
  readonly preconditions: readonly string[];
  readonly successEvidence: readonly string[];
  readonly priority: TaskPriority;
  readonly state: TaskState;
  readonly sourceKey: string;
  readonly fallbackNodeId: string | null;
  readonly failureCategory: FailureCategory | null;
  readonly failureDetail: string | null;
  readonly failureCount: number;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TaskTreeSnapshot {
  readonly schemaVersion: 2;
  readonly rootId: string;
  readonly cursorId: string;
  readonly pausedCursorId: string | null;
  readonly nodes: readonly TaskNode[];
  readonly failures: readonly {
    readonly sourceKey: string;
    readonly count: number;
    readonly blockedUntil: number;
    readonly lastCategory: FailureCategory;
    readonly evidence: string;
  }[];
  readonly updatedAt: number;
}

export interface AddTaskInput {
  readonly id?: string;
  readonly kind?: TaskNodeKind;
  readonly mode?: TaskNodeMode | null;
  readonly handler?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly trigger?: TaskTrigger | null;
  readonly intent: string;
  readonly targetFamily: string;
  readonly quantity?: number;
  readonly preconditions?: readonly string[];
  readonly successEvidence?: readonly string[];
  readonly priority?: TaskPriority;
  readonly sourceKey?: string;
  readonly fallbackNodeId?: string | null;
  readonly parentId?: string | null;
  readonly reason?: string | null;
}

/**
 * A TaskTree owns intent and progress, not tick execution. Only the current
 * branch is expanded; completing a node reveals its next child instead of
 * materialising a whole static script graph.
 */
export class TaskTree {
  private readonly nodes = new Map<string, TaskNode>();
  private readonly failures = new Map<
    string,
    {
      count: number;
      blockedUntil: number;
      lastCategory: FailureCategory;
      evidence: string;
    }
  >();
  private rootId = "";
  private cursorId = "";
  private pausedCursorId: string | null = null;
  private serial = 0;
  private updatedAt: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.updatedAt = now();
  }

  static restore(snapshot: TaskTreeSnapshot, now: () => number = Date.now): TaskTree {
    if (snapshot.schemaVersion !== 2) {
      throw new Error(`unsupported task tree schema ${String(snapshot.schemaVersion)}`);
    }
    const tree = new TaskTree(now);
    for (const node of snapshot.nodes) tree.nodes.set(node.id, node);
    for (const failure of snapshot.failures) {
      tree.failures.set(failure.sourceKey, {
        count: failure.count,
        blockedUntil: failure.blockedUntil,
        lastCategory: failure.lastCategory,
        evidence: failure.evidence,
      });
    }
    tree.rootId = snapshot.rootId;
    tree.cursorId = snapshot.cursorId;
    tree.pausedCursorId = snapshot.pausedCursorId;
    tree.serial = snapshot.nodes.length;
    tree.updatedAt = snapshot.updatedAt;
    return tree;
  }

  createRoot(input: AddTaskInput): TaskNode {
    const node = this.create(input, null);
    this.rootId = node.id;
    this.cursorId = node.id;
    return this.activate(node.id);
  }

  add(input: AddTaskInput): TaskNode {
    const parentId = input.parentId ?? this.cursorId;
    return this.create(input, parentId);
  }

  /**
   * Expands only the active branch. The first child becomes the cursor; later
   * siblings wait without being counted as active work.
   */
  expand(parentId: string, inputs: readonly AddTaskInput[]): readonly TaskNode[] {
    const parent = this.require(parentId);
    const created = inputs.map((input) => this.create(input, parentId));
    if (this.cursorId === parent.id && created[0] !== undefined) {
      this.activate(created[0].id);
    }
    return created;
  }

  /**
   * Records a planned AND/OR branch without moving the cursor. The body still
   * receives one compiled job; the attached nodes explain its prerequisites
   * and let a later settlement mark the whole branch as proven.
   */
  attach(parentId: string, inputs: readonly AddTaskInput[]): readonly TaskNode[] {
    this.require(parentId);
    return inputs.map((input) => this.create(input, parentId));
  }

  /** Completes one task and every planned child attached beneath it. */
  completeBranch(id: string, evidence: readonly string[] = []): TaskNode {
    const root = this.require(id);
    if (root.successEvidence.length > 0 && evidence.length === 0) {
      throw new Error(`task ${id} requires success evidence`);
    }
    const now = this.touch();
    const update = (node: TaskNode): void => {
      if (node.state === "invalidated") return;
      this.nodes.set(node.id, {
        ...node,
        state: "succeeded",
        successEvidence: [...new Set([...node.successEvidence, ...evidence])],
        updatedAt: now,
      });
      for (const child of this.childrenOf(node.id)) update(child);
    };
    update(root);
    this.advanceCursor(id);
    return this.nodes.get(id)!;
  }

  activate(id: string): TaskNode {
    const node = this.require(id);
    if (node.state === "succeeded" || node.state === "invalidated") {
      throw new Error(`cannot activate ${node.state} task ${id}`);
    }
    this.nodes.set(id, {
      ...node,
      state: "active",
      updatedAt: this.touch(),
    });
    this.cursorId = id;
    return this.nodes.get(id)!;
  }

  complete(id: string, evidence: readonly string[] = []): TaskNode {
    const node = this.require(id);
    if (node.successEvidence.length > 0 && evidence.length === 0) {
      throw new Error(`task ${id} requires success evidence`);
    }
    this.nodes.set(id, {
      ...node,
      state: "succeeded",
      successEvidence: [...new Set([...node.successEvidence, ...evidence])],
      updatedAt: this.touch(),
    });
    this.advanceCursor(id);
    return this.nodes.get(id)!;
  }

  /**
   * Two failures of the same source in one session blacklist that source and
   * move to the fallback. The node itself stays visible with its evidence.
   */
  fail(
    id: string,
    category: FailureCategory,
    detail: string,
    options: { readonly blacklistMs?: number } = {},
  ): { readonly node: TaskNode; readonly blacklisted: boolean } {
    const node = this.require(id);
    const now = this.touch();
    const prior = this.failures.get(node.sourceKey);
    const count = (prior?.count ?? 0) + 1;
    const blacklisted = count >= 2;
    this.failures.set(node.sourceKey, {
      count,
      blockedUntil: blacklisted ? now + (options.blacklistMs ?? 10 * 60_000) : 0,
      lastCategory: category,
      evidence: detail,
    });
    const state: TaskState = blacklisted ? "failed" : "blocked";
    this.nodes.set(id, {
      ...node,
      state,
      failureCategory: category,
      failureDetail: detail,
      failureCount: count,
      updatedAt: now,
    });
    if (blacklisted) {
      const fallback = node.fallbackNodeId === null ? null : this.nodes.get(node.fallbackNodeId);
      if (fallback !== undefined && fallback !== null && fallback.state !== "succeeded") {
        this.activate(fallback.id);
      } else {
        this.advanceCursor(id);
      }
    }
    return { node: this.nodes.get(id)!, blacklisted };
  }

  /** Invalidate one branch without disturbing committed sibling evidence. */
  invalidate(id: string, reason: string): TaskNode {
    const node = this.require(id);
    const now = this.touch();
    const update = (candidate: TaskNode): void => {
      if (candidate.state === "succeeded") return;
      this.nodes.set(candidate.id, {
        ...candidate,
        state: "invalidated",
        failureDetail: reason,
        updatedAt: now,
      });
      for (const child of this.childrenOf(candidate.id)) update(child);
    };
    update(node);
    if (this.cursorId === id || this.isDescendant(this.cursorId, id)) this.advanceCursor(id);
    return this.nodes.get(id)!;
  }

  /**
   * Pushes a survival task on top of the current tree. The old cursor is
   * restored when the preempting branch completes or is abandoned.
   */
  preempt(input: AddTaskInput): TaskNode {
    const parent = this.cursorId === "" ? null : this.cursorId;
    this.pausedCursorId = parent;
    const task = this.create({ ...input, priority: input.priority ?? "survival" }, parent);
    this.activate(task.id);
    return task;
  }

  /** Restores the cursor interrupted by the last preemption. */
  resumeAfterPreemption(): TaskNode | null {
    const paused = this.pausedCursorId;
    this.pausedCursorId = null;
    if (paused === null || paused === "") return null;
    const node = this.nodes.get(paused);
    if (node === undefined) return null;
    return this.activate(node.id);
  }

  pause(id = this.cursorId): TaskNode {
    const node = this.require(id);
    this.nodes.set(id, { ...node, state: "paused", updatedAt: this.touch() });
    return this.nodes.get(id)!;
  }

  waiting(id: string, reason = ""): TaskNode {
    const node = this.require(id);
    this.nodes.set(id, {
      ...node,
      state: "waiting",
      failureDetail: reason,
      updatedAt: this.touch(),
    });
    return this.nodes.get(id)!;
  }

  get(id: string): TaskNode | null {
    return this.nodes.get(id) ?? null;
  }

  get current(): TaskNode | null {
    return this.cursorId === "" ? null : this.nodes.get(this.cursorId) ?? null;
  }

  get root(): TaskNode | null {
    return this.rootId === "" ? null : this.nodes.get(this.rootId) ?? null;
  }

  get cursor(): string {
    return this.cursorId;
  }

  get pausedCursor(): string | null {
    return this.pausedCursorId;
  }

  get activePath(): readonly TaskNode[] {
    const path: TaskNode[] = [];
    let node = this.current;
    while (node !== null) {
      path.unshift(node);
      node = node.parentId === null ? null : this.nodes.get(node.parentId) ?? null;
    }
    return path;
  }

  sourceBlocked(sourceKey: string): boolean {
    const failure = this.failures.get(sourceKey);
    return failure !== undefined && failure.blockedUntil > this.now();
  }

  children(id: string): readonly TaskNode[] {
    return this.childrenOf(id);
  }

  /**
   * Marks a node without advancing the cursor. The tree runner owns cursor
   * movement; legacy callers keep using complete/fail for their linear flow.
   */
  mark(
    id: string,
    state: TaskState,
    options: {
      readonly evidence?: readonly string[];
      readonly reason?: string | null;
      readonly failureCategory?: FailureCategory | null;
      readonly failureDetail?: string | null;
      readonly trigger?: TaskTrigger | null;
    } = {},
  ): TaskNode {
    const node = this.require(id);
    const now = this.touch();
    this.nodes.set(id, {
      ...node,
      state,
      successEvidence:
        options.evidence === undefined
          ? node.successEvidence
          : [...new Set([...node.successEvidence, ...options.evidence])],
      reason: options.reason === undefined ? node.reason : options.reason,
      failureCategory:
        options.failureCategory === undefined
          ? node.failureCategory
          : options.failureCategory,
      failureDetail:
        options.failureDetail === undefined
          ? node.failureDetail
          : options.failureDetail,
      trigger: options.trigger === undefined ? node.trigger : options.trigger,
      updatedAt: now,
    });
    return this.nodes.get(id)!;
  }

  /** Resets a failed/blocked node for one retry without losing its evidence. */
  reset(id: string, reason: string | null = null): TaskNode {
    return this.mark(id, "pending", { reason });
  }

  /**
   * A body reconnect is a real world change: it may have respawned, moved, or
   * returned after a mod reload. Failed and blocked branches become retryable
   * again, otherwise one transient bridge fault would strand the whole goal
   * tree for the rest of its version. Succeeded evidence is never touched.
   */
  reviveFailures(reason: string): number {
    const now = this.touch();
    let revived = 0;
    for (const [id, node] of this.nodes) {
      if (node.state !== "failed" && node.state !== "blocked") continue;
      this.nodes.set(id, {
        ...node,
        state: "pending",
        reason,
        failureCategory: null,
        failureDetail: null,
        failureCount: 0,
        updatedAt: now,
      });
      revived += 1;
    }
    if (revived > 0) this.failures.clear();
    return revived;
  }

  /** Records an execution attempt without changing the node's state. */
  bumpFailure(
    id: string,
    category: FailureCategory,
    detail: string,
  ): TaskNode {
    const node = this.require(id);
    const now = this.touch();
    this.nodes.set(id, {
      ...node,
      failureCategory: category,
      failureDetail: detail,
      failureCount: node.failureCount + 1,
      updatedAt: now,
    });
    return this.nodes.get(id)!;
  }

  setPausedCursor(id: string | null): void {
    this.pausedCursorId = id;
    this.updatedAt = this.touch();
  }

  snapshot(): TaskTreeSnapshot {
    return {
      schemaVersion: 2,
      rootId: this.rootId,
      cursorId: this.cursorId,
      pausedCursorId: this.pausedCursorId,
      nodes: [...this.nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
      failures: [...this.failures.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sourceKey, failure]) => ({ sourceKey, ...failure })),
      updatedAt: this.updatedAt,
    };
  }

  private create(input: AddTaskInput, parentId: string | null): TaskNode {
    const now = this.touch();
    const id = input.id ?? `task:${++this.serial}:${slug(input.intent)}`;
    if (this.nodes.has(id)) {
      const existing = this.nodes.get(id)!;
      throw new Error(
        `duplicate task node ${id} (existing ${existing.kind}/${existing.state} source=${existing.sourceKey}; new parent=${parentId} source=${input.sourceKey ?? ""})`,
      );
    }
    this.serial = Math.max(this.serial, this.nodes.size + 1);
    const node: TaskNode = {
      id,
      parentId,
      kind: input.kind ?? "task",
      mode: input.mode ?? null,
      handler: input.handler ?? "task",
      args: input.args ?? {},
      trigger: input.trigger ?? null,
      intent: input.intent,
      targetFamily: input.targetFamily,
      quantity: Math.max(1, input.quantity ?? 1),
      preconditions: input.preconditions ?? [],
      successEvidence: input.successEvidence ?? [],
      priority: input.priority ?? "goal",
      state: "pending",
      sourceKey: input.sourceKey ?? `${input.targetFamily}:${input.intent}`,
      fallbackNodeId: input.fallbackNodeId ?? null,
      failureCategory: null,
      failureDetail: null,
      failureCount: 0,
      reason: input.reason ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.nodes.set(id, node);
    return node;
  }

  private advanceCursor(from: string): void {
    const node = this.nodes.get(from);
    if (node === undefined) return;
    const siblings = this.childrenOf(node.parentId);
    const index = siblings.findIndex((candidate) => candidate.id === from);
    const next = siblings
      .slice(index + 1)
      .find((candidate) => candidate.state === "pending" || candidate.state === "blocked");
    if (next !== undefined) {
      this.activate(next.id);
      return;
    }
    if (node.parentId !== null && node.parentId !== this.rootId) {
      this.activate(node.parentId);
      return;
    }
    this.cursorId = node.parentId ?? from;
  }

  private childrenOf(parentId: string | null): readonly TaskNode[] {
    return [...this.nodes.values()]
      .filter((node) => node.parentId === parentId)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  private isDescendant(id: string, ancestorId: string): boolean {
    let node = this.nodes.get(id);
    while (node !== undefined && node.parentId !== null) {
      if (node.parentId === ancestorId) return true;
      node = this.nodes.get(node.parentId);
    }
    return false;
  }

  private require(id: string): TaskNode {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(`unknown task ${id}`);
    return node;
  }

  private touch(): number {
    this.updatedAt = this.now();
    return this.updatedAt;
  }
}

function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 32);
}
