import {
  goalKindForTitle,
  skillCallSchema,
  type GoalKind,
  type GoalMilestone,
  type RouteBlacklist,
  type SeasonGoal,
  type SkillCall,
} from "@craftmate/contracts";
import {
  STAGE_ORDER,
  TaskTree,
  deadEndEscapeTask,
  depthBelowSurface,
  evaluateMilestone,
  goalAcceptanceMet,
  hasUsablePickaxe,
  mineMouthApproachTask,
  nextMilestone,
  nextTaskForStage,
  planMission,
  returnToSurfaceTask,
  stageById,
  stageScopeFor,
  taskSignature,
  worldFactsFromSnapshot,
  type BlockedTask,
  type FailureCategory,
  type GoalId,
  type Task,
  type TaskNode,
  type TaskTreeSnapshot,
  type TaskTrigger,
  type TargetLockIntent,
  type WorldFacts,
} from "../domain/index.ts";
import type {
  GoalPlan,
  GoalPlanner,
  GoalPlanningInput,
  GoalSettlement,
  GoalTask,
} from "./goal-runtime.ts";

interface TaskSpec {
  readonly taskId: string;
  readonly title: string;
  readonly kind: Task["kind"];
  readonly stage: GoalId;
  readonly skill: SkillCall;
  readonly critical: boolean;
  readonly targetLock: TargetLockIntent | null;
  readonly signature: string;
}

type Resolution =
  | {
      readonly kind: "skill";
      readonly nodeId: string;
      readonly spec: TaskSpec;
      readonly reason: string;
      readonly stage: GoalId;
      readonly milestoneId: string;
      readonly milestoneTitle: string;
    }
  | {
      readonly kind: "blocked";
      readonly reason: string;
      readonly stage: GoalId;
      readonly milestoneId: string;
      readonly milestoneTitle: string;
    }
  | { readonly kind: "stage-complete"; readonly stage: GoalId }
  | {
      readonly kind: "milestone-complete";
      readonly stage: GoalId;
      readonly milestoneId: string;
    }
  | { readonly kind: "task-complete"; readonly stage: GoalId };

interface GoalTreePlannerOptions {
  readonly readRouteBlacklist?: (facts: WorldFacts) => readonly RouteBlacklist[];
  readonly newId?: () => string;
}

const HOSTILE =
  /zombie|husk|drowned|skeleton|stray|creeper|spider|witch|pillager|vindicator|evoker|ravager|enderman|slime|magma_cube|blaze|ghast|warden/iu;
const MAX_TREE_DEPTH = 8;
const MAX_TREE_NODES = 256;

/**
 * Goal-tree orchestrator. It is deliberately not a general Behavior Tree:
 * six semantic node kinds, two container modes, and one executable leaf at a
 * time. The body still receives the same SkillCall contract.
 */
export class GoalTreePlanner implements GoalPlanner {
  readonly engine = "tree" as const;
  private readonly readRouteBlacklist:
    | ((facts: WorldFacts) => readonly RouteBlacklist[])
    | undefined;
  private readonly newId: () => string;
  private tree: TaskTree | null = null;
  private goalId: string | null = null;
  private goalVersion = 0;
  private goalKind: GoalKind = "dragon";
  private activeNodeId: string | null = null;
  private pendingInterrupt: TaskTrigger | null = null;
  private interruptSerial = 0;

  constructor(options: GoalTreePlannerOptions = {}) {
    this.readRouteBlacklist = options.readRouteBlacklist;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  plan(input: GoalPlanningInput): GoalPlan {
    const goal = input.goal;
    this.ensureTree(goal, input.treeSnapshot ?? null);
    const tree = this.tree!;
    const facts = this.facts(input);
    const goalKind = goal.goalKind ?? goalKindForTitle(goal.title);
    if (goalAcceptanceMet(goalKind, facts)) {
      const root = tree.root;
      if (root !== null) {
        tree.mark(root.id, "succeeded", {
          evidence: [`goal:${goalKind}`],
        });
      }
      return this.completePlan(goal, facts, tree);
    }
    const resolution = this.resolve(facts, input);
    if (resolution.kind === "skill") {
      return this.skillPlan(goal, facts, tree, resolution);
    }
    if (resolution.kind === "blocked") {
      return this.blockedPlan(tree, facts, resolution);
    }
    return this.blockedPlan(tree, facts, {
      kind: "blocked",
      reason: "目标树没有找到可执行叶子",
      stage: this.currentStageId(facts),
      milestoneId: "observe",
      milestoneTitle: "等待下一步",
    });
  }

  async planAsync(input: GoalPlanningInput): Promise<GoalPlan> {
    return this.plan(input);
  }

  noteSettlement(event: {
    readonly decisionId: string;
    readonly taskId: string;
    readonly strategyKey: string;
    readonly outcome: GoalSettlement;
  }): void {
    const tree = this.tree;
    if (tree === null) return;
    const node = tree.get(event.taskId);
    if (node === null || node.kind !== "skill") {
      this.activeNodeId = null;
      return;
    }
    const parent = node.parentId === null ? null : tree.get(node.parentId);
    const detail = outcomeDetail(event.outcome);
    if (event.outcome.status === "completed") {
      tree.mark(node.id, "succeeded", {
        evidence: evidenceFor(event.outcome),
      });
      if (parent !== null) tree.mark(parent.id, "succeeded");
      this.activeNodeId = null;
      return;
    }
    if (
      event.outcome.status === "cancelled" ||
      event.outcome.status === "preempted"
    ) {
      tree.reset(node.id, detail);
      if (parent !== null) tree.reset(parent.id, detail);
      if (event.outcome.status === "preempted") {
        this.pendingInterrupt = "danger";
      }
      this.activeNodeId = null;
      return;
    }
    const category = failureCategory(event.outcome.errorCode);
    const failed = tree.bumpFailure(node.id, category, detail);
    if (failed.failureCount < 2) {
      tree.reset(node.id, detail);
    } else {
      tree.mark(node.id, "failed", {
        failureCategory: category,
        failureDetail: detail,
        reason: detail,
      });
      if (parent !== null) {
        tree.mark(parent.id, "failed", {
          failureCategory: category,
          failureDetail: detail,
          reason: detail,
        });
      }
    }
    this.activeNodeId = null;
  }

  treeSnapshot(): TaskTreeSnapshot | null {
    return this.tree?.snapshot() ?? null;
  }

  /** The body reconnected, so failed branches may be attempted again. */
  retryFailed(reason: string): number {
    const revived = this.tree?.reviveFailures(reason) ?? 0;
    if (revived > 0) this.activeNodeId = null;
    return revived;
  }

  private ensureTree(
    goal: SeasonGoal,
    snapshot: TaskTreeSnapshot | null,
  ): void {
    if (
      this.tree !== null &&
      this.goalId === goal.id &&
      this.goalVersion === goal.version
    ) {
      return;
    }
    this.goalId = goal.id;
    this.goalVersion = goal.version;
    this.goalKind = goal.goalKind ?? goalKindForTitle(goal.title);
    this.activeNodeId = null;
    this.pendingInterrupt = null;
    if (snapshot !== null) {
      try {
        const restored = TaskTree.restore(snapshot, Date.now);
        if (restored.root?.kind === "goal") {
          this.assertLimits(restored);
          this.tree = restored;
          return;
        }
      } catch {
        this.tree = null;
      }
    }
    this.tree = this.buildTree(goal);
  }

  private buildTree(goal: SeasonGoal): TaskTree {
    const tree = new TaskTree();
    const rootId = nodeId("goal", goal.id, "v", String(goal.version));
    const root = tree.createRoot({
      id: rootId,
      kind: "goal",
      mode: "selector",
      handler: "goal",
      args: { goalKind: this.goalKind },
      intent: goal.title,
      targetFamily: this.goalKind,
      priority: "goal",
      sourceKey: `goal:${goal.id}`,
    });
    for (const stageId of stageScopeFor(this.goalKind)) {
      const stage = stageById(stageId);
      tree.attach(root.id, [
        {
          id: stageNodeId(rootId, stageId),
          kind: "stage",
          mode: "sequence",
          handler: `stage:${stageId}`,
          args: { stage: stageId },
          intent: stage.title,
          targetFamily: stageId,
          priority: "goal",
          sourceKey: `stage:${stageId}`,
        },
      ]);
    }
    tree.attach(root.id, [
      {
        id: nodeId(rootId, "interrupt"),
        kind: "interrupt",
        mode: "sequence",
        handler: "interrupt",
        trigger: "danger",
        args: {},
        intent: "安全与工具恢复",
        targetFamily: "interrupt",
        priority: "reflex",
        sourceKey: "interrupt",
      },
    ]);
    this.assertLimits(tree);
    return tree;
  }

  private assertLimits(tree: TaskTree): void {
    const snapshot = tree.snapshot();
    if (snapshot.nodes.length > MAX_TREE_NODES) {
      throw new Error(
        `目标树超过 ${MAX_TREE_NODES} 个节点；请缩小任务分支`,
      );
    }
    const byId = new Map(snapshot.nodes.map((node) => [node.id, node] as const));
    for (const node of snapshot.nodes) {
      let depth = 0;
      let parent = node.parentId;
      while (parent !== null) {
        depth += 1;
        if (depth > MAX_TREE_DEPTH) {
          throw new Error(`目标树超过 ${MAX_TREE_DEPTH} 层`);
        }
        parent = byId.get(parent)?.parentId ?? null;
      }
    }
  }

  private facts(input: GoalPlanningInput): WorldFacts {
    const snapshot = input.world as Parameters<typeof worldFactsFromSnapshot>[0];
    const targetLock = input.progress.targetLock ?? null;
    const routeBlacklist =
      input.routeBlacklist ??
      this.readRouteBlacklist?.(
        worldFactsFromSnapshot(snapshot, { targetLock }),
      ) ??
      [];
    return worldFactsFromSnapshot(snapshot, {
      routeBlacklist,
      targetLock,
    });
  }

  private resolve(facts: WorldFacts, input: GoalPlanningInput): Resolution {
    const tree = this.tree!;
    const root = tree.root;
    if (root === null) {
      return {
        kind: "blocked",
        reason: "目标树没有根节点",
        stage: this.currentStageId(facts),
        milestoneId: "observe",
        milestoneTitle: "等待下一步",
      };
    }
    const activeInterrupt = tree
      .children(root.id)
      .find(
        (node) =>
          node.kind === "interrupt" &&
          (node.state === "active" ||
            node.state === "waiting"),
      );
    const trigger =
      this.detectTrigger(facts, input) ?? activeInterrupt?.trigger ?? null;
    if (trigger !== null) {
      const interrupted = this.resolveInterrupt(root, trigger, facts, input);
      if (interrupted !== null) return interrupted;
    }
    return this.resolveStages(facts, input);
  }

  private resolveStages(
    facts: WorldFacts,
    input: GoalPlanningInput,
  ): Resolution {
    const tree = this.tree!;
    const root = tree.root;
    if (root === null) {
      return this.blocked("目标树没有根节点", facts);
    }
    let chosen = this.chooseStage(facts, input);
    if (chosen.kind === "blocked") return chosen;
    let lastBlocked: Resolution | null = null;
    for (let guard = 0; guard < STAGE_ORDER.length + 2; guard++) {
      const stage = stageById(chosen.stage);
      this.ensureMilestones(chosen.node, stage.id);
      const result = this.resolveStage(chosen.node, stage.id, facts, input);
      if (result.kind !== "stage-complete") {
        if (result.kind !== "blocked") return result;
        /*
         * A mission may propose a later stage whose entry conditions look
         * satisfied but whose first milestone has no executable task. Record
         * the block on that stage and let the next candidate run instead of
         * stranding the whole goal on one branch.
         */
        tree.mark(chosen.node.id, "blocked", { reason: result.reason });
        lastBlocked = result;
        chosen = this.chooseStage(facts, input);
        if (chosen.kind === "blocked") return lastBlocked;
        continue;
      }
      tree.mark(chosen.node.id, "succeeded", {
        evidence: [`stage:${stage.id}`],
      });
      chosen = this.chooseStage(facts, input);
      if (chosen.kind === "blocked") return lastBlocked ?? chosen;
    }
    return lastBlocked ?? this.blocked("阶段选择没有收敛", facts);
  }

  private chooseStage(
    facts: WorldFacts,
    input: GoalPlanningInput,
  ):
    | { readonly kind: "stage"; readonly node: TaskNode; readonly stage: GoalId }
    | { readonly kind: "blocked"; readonly reason: string; readonly stage: GoalId; readonly milestoneId: string; readonly milestoneTitle: string } {
    const tree = this.tree!;
    const root = tree.root!;
    const scope = stageScopeFor(this.goalKind);
    const current = this.currentStageId(facts);
    const mission = planMission({
      facts,
      goalTitle: this.goalTitle(),
      stage: current,
    });
    const candidates: GoalId[] = [];
    if (
      scope.includes(mission.stage) &&
      !/night-work|complete/iu.test(mission.kind)
    ) {
      candidates.push(mission.stage);
    }
    for (const stage of scope) {
      if (!candidates.includes(stage)) candidates.push(stage);
    }
    /*
     * A committed stage is evidence, not a permanent fact. The body can
     * consume its last plank, break its only iron pickaxe, or get hungry
     * again. Re-open a succeeded stage whose milestones no longer hold before
     * choosing a later one; otherwise the diamond stage reports
     * "needs an iron pickaxe" while the iron stage is skipped forever.
     */
    let reopened = false;
    for (const stageId of candidates) {
      const node = this.stageNodes(root).find(
        (entry) => entry.targetFamily === stageId,
      );
      if (node === undefined || node.state !== "succeeded") continue;
      if (this.stageMilestonesComplete(stageId, facts)) continue;
      tree.reset(
        node.id,
        `阶段证据回退：「${stageById(stageId).title}」的资源或装备已消耗`,
      );
      reopened = true;
    }
    const active = this.stageNodes(root).find(
      (node) => node.state === "active" || node.state === "paused",
    );
    if (active !== undefined && !terminal(active) && !reopened) {
      return { kind: "stage", node: active, stage: active.targetFamily as GoalId };
    }
    let fallbackReason: string | null = null;
    /*
     * A reopened early stage outranks the mission's suggested stage. Food is
     * the clearest case: once hunger drops, eating comes before another
     * mining leg even if the mission still points at the mine.
     */
    for (const stageId of reopened ? scope : candidates) {
      const node = this.stageNodes(root).find(
        (entry) => entry.targetFamily === stageId,
      );
      if (node === undefined || node.state === "succeeded") continue;
      if (node.state === "failed" || node.state === "blocked") continue;
      const ready = this.stageReady(stageId, facts, input);
      if (!ready.ok) {
        if (fallbackReason === null) fallbackReason = ready.reason;
        continue;
      }
      tree.activate(node.id);
      tree.mark(node.id, "active", {
        reason:
          stageId === mission.stage
            ? mission.reason
            : `回退到最早可执行阶段：${fallbackReason ?? "当前阶段不可进入"}`,
      });
      return { kind: "stage", node, stage: stageId };
    }
    return this.blocked(
      fallbackReason ?? "没有可进入的目标阶段",
      facts,
    );
  }

  private stageMilestonesComplete(stageId: GoalId, facts: WorldFacts): boolean {
    const stage = stageById(stageId);
    return stage.milestones.every(
      (milestone) => evaluateMilestone(milestone, facts) === "complete",
    );
  }

  private resolveStage(
    stageNode: TaskNode,
    stageId: GoalId,
    facts: WorldFacts,
    input: GoalPlanningInput,
  ): Resolution {
    const tree = this.tree!;
    const stage = stageById(stageId);
    const milestones = this.milestoneNodes(stageNode, stageId);
    if (milestones.length === 0) return this.blocked("阶段没有里程碑", facts, stageId);
    for (let guard = 0; guard < stage.milestones.length + 2; guard++) {
      const remaining: TaskNode[] = [];
      for (const node of this.milestoneNodes(stageNode, stageId)) {
        const definition = milestoneDefinition(stageId, node);
        if (definition === null) continue;
        if (evaluateMilestone(definition, facts) === "complete") {
          tree.mark(node.id, "succeeded", {
            evidence: [definition.condition],
          });
          continue;
        }
        if (node.state === "succeeded") {
          tree.reset(node.id, "里程碑证据回退，重新验证");
        }
        remaining.push(node);
      }
      if (remaining.length === 0) return { kind: "stage-complete", stage: stageId };
      const blocked = remaining.find(
        (node) => node.state === "blocked" || node.state === "failed",
      );
      if (blocked !== undefined) {
        return this.blocked(
          blocked.failureDetail ?? blocked.reason ?? "阶段里程碑阻塞",
          facts,
          stageId,
          blocked.id,
          blocked.intent,
        );
      }
      const node = remaining[0]!;
      const definition = milestoneDefinition(stageId, node);
      if (definition === null) {
        return this.blocked("未知里程碑", facts, stageId, node.id, node.intent);
      }
      const status = evaluateMilestone(definition, facts);
      if (status === "complete") {
        tree.mark(node.id, "succeeded", { evidence: [definition.condition] });
        continue;
      }
      tree.activate(node.id);
      const result = this.resolveMilestone(
        node,
        stageId,
        definition.id,
        definition.title,
        facts,
        input,
      );
      if (result.kind === "milestone-complete") continue;
      return result;
    }
    return this.blocked("阶段里程碑没有收敛", facts, stageId);
  }

  private resolveMilestone(
    milestoneNode: TaskNode,
    stageId: GoalId,
    milestoneId: string,
    milestoneTitle: string,
    facts: WorldFacts,
    input: GoalPlanningInput,
  ): Resolution {
    const tree = this.tree!;
    const stage = stageById(stageId);
    const definition = stage.milestones.find((entry) => entry.id === milestoneId);
    if (definition === undefined) {
      return this.blocked("未知里程碑", facts, stageId, milestoneNode.id, milestoneTitle);
    }
    for (let guard = 0; guard < 6; guard++) {
      if (evaluateMilestone(definition, facts) === "complete") {
        tree.mark(milestoneNode.id, "succeeded", {
          evidence: [definition.condition],
        });
        return {
          kind: "milestone-complete",
          stage: stageId,
          milestoneId,
        };
      }
      const tasks = tree
        .children(milestoneNode.id)
        .filter((node) => node.kind === "task");
      const active = tasks.find(
        (node) => node.state === "active" || node.state === "pending",
      );
      if (active !== undefined) {
        const result = this.resolveTask(active, stageId, milestoneId, milestoneTitle, facts, input);
        if (result.kind === "task-complete") continue;
        return result;
      }
      const failed = tasks.filter(
        (node) => node.state === "failed" || node.state === "blocked",
      );
      /*
       * A fresh plan is not recovery when the same observation produces the
       * same failed skill. The live body retried `mine_tunnel` every minute
       * with "no safe mining direction" while standing on the camp terrace,
       * because `nextTaskForStage` kept rebuilding the identical tunnel node.
       * Let a definitive mining failure hand over to the explicitly different
       * escape/approach task before the milestone spends its retry budget.
       */
      let task: Task | BlockedTask | null =
        failed.length === 0 ? null : this.recoveryTask(stageId, facts, failed);
      if (task === null) {
        if (failed.length >= 2) {
          const detail = `里程碑「${milestoneTitle}」连续失败 ${failed.length} 次`;
          tree.mark(milestoneNode.id, "blocked", { reason: detail });
          return this.blocked(detail, facts, stageId, milestoneNode.id, milestoneTitle);
        }
        task = nextTaskForStage({
          stage: stageId,
          facts,
          newId: this.newId,
          scope: "full",
        });
      }
      if (task === null) {
        return this.blocked("当前里程碑没有可执行任务", facts, stageId, milestoneNode.id, milestoneTitle);
      }
      if (!("skill" in task)) {
        const detail = task.missing.map((item) => item.detail).join("；");
        tree.mark(milestoneNode.id, "blocked", { reason: detail });
        return this.blocked(detail, facts, stageId, milestoneNode.id, milestoneTitle);
      }
      const parsed = skillCallSchema.safeParse(task.skill);
      if (!parsed.success) {
        return this.blocked("任务技能不符合契约", facts, stageId, milestoneNode.id, milestoneTitle);
      }
      if (
        input.health?.skills !== undefined &&
        !input.health.skills.includes(task.skill.name)
      ) {
        const detail = `身体未声明技能 ${task.skill.name}`;
        tree.mark(milestoneNode.id, "blocked", { reason: detail });
        return this.blocked(detail, facts, stageId, milestoneNode.id, milestoneTitle);
      }
      const signature = taskSignature(task);
      /*
       * Only failed attempts exhaust a strategy. A repeatable maintenance
       * action such as "light the tunnel" can succeed twice at two different
       * depths; counting those successes blocked the diamond milestone even
       * though placing one more torch at the new position was the right move.
       */
      if (
        tasks.filter(
          (node) =>
            node.sourceKey === signature &&
            (node.state === "failed" || node.state === "blocked"),
        ).length >= 2
      ) {
        const detail = `同一策略已尝试两次：${task.title}`;
        tree.mark(milestoneNode.id, "blocked", { reason: detail });
        return this.blocked(detail, facts, stageId, milestoneNode.id, milestoneTitle);
      }
      const created = this.createTaskNode(
        milestoneNode.id,
        task,
        stageId,
        milestoneId,
        milestoneTitle,
      );
      const result = this.resolveTask(
        created,
        stageId,
        milestoneId,
        milestoneTitle,
        facts,
        input,
      );
      if (result.kind === "task-complete") continue;
      return result;
    }
    return this.blocked("里程碑展开没有收敛", facts, stageId, milestoneNode.id, milestoneTitle);
  }

  /**
   * The tree owns task creation, so the non-tree planner's failure recovery
   * never runs here. Keep the same definitive verdicts from burning a whole
   * milestone: a blocked tunnel at the mine mouth walks back to the first
   * stair cell, and a flooded or shallow dead end climbs out before trying
   * another heading.
   */
  private recoveryTask(
    stage: GoalId,
    facts: WorldFacts,
    failed: readonly TaskNode[],
  ): Task | null {
    const latest = [...failed].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    )[0];
    if (latest === undefined) return null;
    const failure = `${latest.failureCategory ?? ""} ${
      latest.failureDetail ?? latest.reason ?? ""
    }`;
    if (
      !/no safe mining direction|no safe mining|no direction|enclosed|no safe route and no legal recovery step/iu.test(
        failure,
      )
    ) {
      return null;
    }
    const depth = depthBelowSurface(facts) ?? Number.POSITIVE_INFINITY;
    if (facts.inWater === true || depth <= 12) {
      const surface = returnToSurfaceTask(stage, facts, this.newId);
      if (surface !== null) return surface;
    }
    const escape = deadEndEscapeTask(stage, facts, this.newId);
    if (escape !== null) return escape;
    const approach = mineMouthApproachTask(stage, facts, this.newId);
    if (approach !== null) return approach;
    return returnToSurfaceTask(stage, facts, this.newId);
  }

  private resolveTask(
    taskNode: TaskNode,
    stageId: GoalId,
    milestoneId: string,
    milestoneTitle: string,
    facts: WorldFacts,
    input: GoalPlanningInput,
  ): Resolution {
    const tree = this.tree!;
    if (taskNode.state === "succeeded") {
      return { kind: "task-complete", stage: stageId };
    }
    if (taskNode.state === "failed" || taskNode.state === "blocked") {
      return this.blocked(
        taskNode.failureDetail ?? taskNode.reason ?? "任务失败",
        facts,
        stageId,
        milestoneId,
        milestoneTitle,
      );
    }
    const spec = readTaskSpec(taskNode);
    if (spec === null) {
      tree.mark(taskNode.id, "failed", { reason: "任务节点缺少可执行参数" });
      return this.blocked("任务节点缺少可执行参数", facts, stageId, milestoneId, milestoneTitle);
    }
    const skills = tree
      .children(taskNode.id)
      .filter((node) => node.kind === "skill");
    const existing = skills[0];
    if (existing !== undefined) {
      if (existing.state === "succeeded") {
        tree.mark(taskNode.id, "succeeded");
        return { kind: "task-complete", stage: stageId };
      }
      if (existing.state === "failed" || existing.state === "blocked") {
        tree.mark(taskNode.id, "failed", {
          failureDetail: existing.failureDetail,
        });
        return this.blocked(
          existing.failureDetail ?? "技能失败",
          facts,
          stageId,
          milestoneId,
          milestoneTitle,
        );
      }
      tree.activate(existing.id);
      this.activeNodeId = existing.id;
      return this.skillResolution(
        existing.id,
        spec,
        milestoneTitle,
        stageId,
        milestoneId,
        facts,
        input,
      );
    }
    const parsed = skillCallSchema.safeParse(spec.skill);
    if (!parsed.success) {
      tree.mark(taskNode.id, "failed", { reason: "技能参数不合法" });
      return this.blocked("技能参数不合法", facts, stageId, milestoneId, milestoneTitle);
    }
    const [skill] = tree.attach(taskNode.id, [
      {
        id: nodeId(taskNode.id, "skill", spec.signature),
        kind: "skill",
        handler: "skill",
        args: { task: spec },
        intent: spec.title,
        targetFamily: spec.stage,
        priority: spec.critical ? "survival" : "goal",
        sourceKey: `skill:${spec.signature}`,
        successEvidence: [],
      },
    ]);
    if (skill === undefined) {
      return this.blocked("无法创建技能节点", facts, stageId, milestoneId, milestoneTitle);
    }
    tree.activate(skill.id);
    this.activeNodeId = skill.id;
    const result = this.skillResolution(
      skill.id,
      spec,
      milestoneTitle,
      stageId,
      milestoneId,
      facts,
      input,
    );
    if (result.kind === "skill" || result.kind === "blocked") return result;
    return { kind: "task-complete", stage: stageId };
  }

  private skillResolution(
    nodeIdValue: string,
    spec: TaskSpec,
    milestoneTitle: string,
    stageId: GoalId,
    milestoneId: string,
    _facts: WorldFacts,
    _input: GoalPlanningInput,
  ): Resolution {
    return {
      kind: "skill",
      nodeId: nodeIdValue,
      spec,
      reason: `目标阶段「${stageById(stageId).title}」：${milestoneTitle}`,
      stage: stageId,
      milestoneId,
      milestoneTitle,
    };
  }

  private resolveInterrupt(
    root: TaskNode,
    trigger: TaskTrigger,
    facts: WorldFacts,
    input: GoalPlanningInput,
  ): Resolution | null {
    const tree = this.tree!;
    const interrupt = tree
      .children(root.id)
      .find((node) => node.kind === "interrupt");
    if (interrupt === undefined) return null;
    if (interrupt.state === "failed" || interrupt.state === "blocked") {
      return this.blocked(
        interrupt.failureDetail ?? interrupt.reason ?? "安全抢占失败",
        facts,
      );
    }
    const stageId = this.currentStageId(facts);
    const stage = stageById(stageId);
    const milestone = nextMilestone(stage, facts);
    const tasks = tree
      .children(interrupt.id)
      .filter((node) => node.kind === "task");
    const active = tasks.find(
      (node) => node.state === "active" || node.state === "pending",
    );
    if (active === undefined && !this.triggerStillActive(trigger, facts)) {
      tree.mark(interrupt.id, "succeeded", {
        evidence: [`interrupt:${trigger}:cleared`],
      });
      tree.setPausedCursor(null);
      this.pendingInterrupt = null;
      return null;
    }
    /*
     * The preemption condition can disappear while its task is still
     * retrying. The live run lost a pickaxe, created a "return to the surface
     * table for food" task, and then regained a usable pickaxe; the task node
     * stayed active and the goal loop replayed it forever. Close the
     * interrupt as soon as the trigger is gone instead of waiting for a task
     * that no longer matches the world.
     */
    if (active !== undefined && !this.triggerStillActive(trigger, facts)) {
      tree.mark(active.id, "succeeded", {
        evidence: [`interrupt:${trigger}:obsolete`],
      });
      tree.mark(interrupt.id, "succeeded", {
        evidence: [`interrupt:${trigger}:cleared`],
      });
      tree.setPausedCursor(null);
      this.pendingInterrupt = null;
      return null;
    }
    if (interrupt.state === "succeeded") {
      tree.reset(interrupt.id, "新的安全事件");
      this.interruptSerial += 1;
    }
    if (active === undefined) {
      this.ensurePausedStage(root, facts);
      tree.activate(interrupt.id);
      tree.mark(interrupt.id, "active", {
        trigger,
        reason: trigger === "tool-lost" ? "工具失效，先恢复工具" : "安全事件，先处理危险",
      });
      const task = nextTaskForStage({
        stage: stageId,
        facts,
        newId: this.newId,
        scope: "full",
      });
      if (task === null) {
        tree.mark(interrupt.id, "blocked", { reason: "没有安全恢复任务" });
        return this.blocked("没有安全恢复任务", facts);
      }
      if (!("skill" in task)) {
        const detail = task.missing.map((item) => item.detail).join("；");
        tree.mark(interrupt.id, "blocked", { reason: detail });
        return this.blocked(detail, facts);
      }
      const created = this.createTaskNode(
        interrupt.id,
        task,
        stageId,
        milestone?.milestone.id ?? "safety",
        "安全处理",
      );
      const result = this.resolveTask(
        created,
        stageId,
        milestone?.milestone.id ?? "safety",
        "安全处理",
        facts,
        input,
      );
      if (result.kind === "task-complete") return null;
      return result;
    }
    const result = this.resolveTask(
      active,
      stageId,
      milestone?.milestone.id ?? "safety",
      "安全处理",
      facts,
      input,
    );
    if (result.kind === "task-complete") {
      tree.mark(interrupt.id, "succeeded", {
        evidence: ["interrupt:completed"],
      });
      tree.setPausedCursor(null);
      this.pendingInterrupt = null;
      return null;
    }
    return result;
  }

  private ensurePausedStage(root: TaskNode, facts: WorldFacts): void {
    if (this.tree?.pausedCursor != null) return;
    const stageId = this.currentStageId(facts);
    const stage = this.tree
      ?.children(root.id)
      .find((node) => node.kind === "stage" && node.targetFamily === stageId);
    if (stage !== undefined) this.tree?.setPausedCursor(stage.id);
  }

  private detectTrigger(
    facts: WorldFacts,
    _input: GoalPlanningInput,
  ): TaskTrigger | null {
    if (this.pendingInterrupt !== null) return this.pendingInterrupt;
    if (this.triggerStillActive("danger", facts)) return "danger";
    if (this.triggerStillActive("tool-lost", facts)) return "tool-lost";
    return null;
  }

  private triggerStillActive(trigger: TaskTrigger, facts: WorldFacts): boolean {
    if (trigger === "operator") return false;
    const health = facts.health;
    if (trigger === "danger") {
      if (health === undefined || health === null) return false;
      const hostile = (facts.entities ?? []).find(
        (entity) => HOSTILE.test(entity.type) && entity.distance <= 8,
      );
      return health <= 6 || (health <= 10 && hostile !== undefined);
    }
    const stage = this.currentStageId(facts);
    const enoughProgress =
      STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf("stone-tools");
    return (
      facts.pickaxeLost === true ||
      (enoughProgress && !hasUsablePickaxe(facts))
    );
  }

  private createTaskNode(
    parentId: string,
    task: Task,
    stageId: GoalId,
    milestoneId: string,
    milestoneTitle: string,
  ): TaskNode {
    const tree = this.tree!;
    const signature = taskSignature(task);
    const siblings = tree
      .children(parentId)
      .filter((node) => node.kind === "task");
    let ordinal =
      siblings.filter((node) => node.sourceKey === signature).length + 1;
    const spec: TaskSpec = {
      taskId: task.id,
      title: task.title,
      kind: task.kind,
      stage: task.stage,
      skill: task.skill,
      critical: task.critical === true,
      targetLock: task.targetLock ?? null,
      signature,
    };
    let id = nodeId(parentId, "task", slug(signature), String(ordinal));
    /*
     * Child ids are truncated to the contract length and hashed. Two long
     * paths can therefore share a readable prefix; a revived tree made that
     * visible as a duplicate id that stopped the whole planner. Bump the
     * ordinal until the deterministic id is actually free.
     */
    while (tree.get(id) !== null) {
      ordinal += 1;
      id = nodeId(parentId, "task", slug(signature), String(ordinal));
    }
    const created = tree.attach(parentId, [
      {
        id,
        kind: "task",
        mode: "sequence",
        handler: "task",
        args: { task: spec },
        intent: task.title,
        targetFamily: stageId,
        priority: task.critical === true ? "survival" : "goal",
        sourceKey: signature,
        successEvidence: [],
        reason: `里程碑「${milestoneTitle}」`,
      },
    ])[0];
    if (created === undefined) {
      throw new Error(`无法创建任务节点 ${milestoneId}`);
    }
    tree.activate(created.id);
    return created;
  }

  private stageReady(
    stageId: GoalId,
    facts: WorldFacts,
    input: GoalPlanningInput,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const stage = stageById(stageId);
    const root = this.tree?.root ?? null;
    if (root !== null) {
      const stages = this.stageNodes(root);
      for (const required of stage.requires) {
        const dependency = stages.find(
          (node) => node.targetFamily === required,
        );
        if (dependency?.state !== "succeeded") {
          return {
            ok: false,
            reason: `前置阶段「${stageById(required).title}」尚未完成`,
          };
        }
      }
    }
    if (stage.milestones.every((entry) => evaluateMilestone(entry, facts) === "complete")) {
      return { ok: true };
    }
    const task = nextTaskForStage({
      stage: stageId,
      facts,
      newId: this.newId,
      scope: "full",
    });
    if (task === null) return { ok: false, reason: `阶段 ${stage.title} 没有可执行任务` };
    if (!("skill" in task)) {
      return {
        ok: false,
        reason: task.missing.map((item) => item.detail).join("；"),
      };
    }
    if (!skillCallSchema.safeParse(task.skill).success) {
      return { ok: false, reason: "阶段任务技能不符合契约" };
    }
    if (
      input.health?.skills !== undefined &&
      !input.health.skills.includes(task.skill.name)
    ) {
      return { ok: false, reason: `身体未声明技能 ${task.skill.name}` };
    }
    return { ok: true };
  }

  private ensureMilestones(stageNode: TaskNode, stageId: GoalId): void {
    const tree = this.tree!;
    if (tree.children(stageNode.id).some((node) => node.kind === "milestone")) {
      return;
    }
    const stage = stageById(stageId);
    tree.attach(
      stageNode.id,
      stage.milestones.map((milestone) => ({
        id: nodeId(stageNode.id, "milestone", milestone.id),
        kind: "milestone" as const,
        mode: "sequence" as const,
        handler: `milestone:${stageId}:${milestone.id}`,
        args: { stage: stageId, milestoneId: milestone.id },
        intent: milestone.title,
        targetFamily: stageId,
        priority: "goal" as const,
        sourceKey: `milestone:${stageId}:${milestone.id}`,
        successEvidence: [],
      })),
    );
    const first = this.milestoneNodes(stageNode, stageId)[0];
    if (first !== undefined) tree.activate(first.id);
  }

  private milestoneNodes(
    stageNode: TaskNode,
    stageId: GoalId,
  ): readonly TaskNode[] {
    const order = new Map(
      stageById(stageId).milestones.map(
        (milestone, index) => [milestone.id, index] as const,
      ),
    );
    return this.tree!
      .children(stageNode.id)
      .filter((node) => node.kind === "milestone")
      .sort(
        (left, right) =>
          (order.get(milestoneIdOf(left) ?? "") ?? 999) -
          (order.get(milestoneIdOf(right) ?? "") ?? 999),
      );
  }

  private currentStageId(facts: WorldFacts): GoalId {
    const tree = this.tree;
    if (tree !== null) {
      const root = tree.root;
      if (root !== null) {
        const stages = this.stageNodes(root);
        const active = stages.find(
            (node) =>
              (node.state === "active" || node.state === "paused"),
          );
        if (active !== undefined) return active.targetFamily as GoalId;
        const pending = stages.find(
            (node) =>
              node.state !== "succeeded" &&
              node.state !== "failed" &&
              node.state !== "blocked",
          );
        if (pending !== undefined) return pending.targetFamily as GoalId;
      }
    }
    return stageScopeFor(this.goalKind)[0] ?? "wood-and-table";
  }

  private stageNodes(root: TaskNode): readonly TaskNode[] {
    return this.tree!
      .children(root.id)
      .filter((node) => node.kind === "stage")
      .sort(
        (left, right) =>
          STAGE_ORDER.indexOf(left.targetFamily as GoalId) -
          STAGE_ORDER.indexOf(right.targetFamily as GoalId),
      );
  }

  private skillPlan(
    goal: SeasonGoal,
    facts: WorldFacts,
    tree: TaskTree,
    result: Extract<Resolution, { kind: "skill" }>,
  ): GoalPlan {
    const stage = stageById(result.stage);
    const milestones = this.goalMilestones(stage.id, facts);
    return {
      stage: { id: stage.id, title: stage.title },
      milestone: { id: result.milestoneId, title: result.milestoneTitle },
      nextTask: this.goalTask(result),
      milestones,
      verified: milestones.some((entry) => entry.status === "completed"),
      strategyKey: result.spec.signature,
      treeSnapshot: tree.snapshot(),
    };
  }

  private blockedPlan(
    tree: TaskTree,
    facts: WorldFacts,
    result: Extract<Resolution, { kind: "blocked" }>,
  ): GoalPlan {
    const stage = stageById(result.stage);
    return {
      stage: { id: stage.id, title: stage.title },
      milestone: { id: result.milestoneId, title: result.milestoneTitle },
      nextTask: null,
      milestones: this.goalMilestones(stage.id, facts),
      verified: false,
      blockedReason: result.reason,
      treeSnapshot: tree.snapshot(),
    };
  }

  private completePlan(
    goal: SeasonGoal,
    facts: WorldFacts,
    tree: TaskTree,
  ): GoalPlan {
    const stageId = this.currentStageId(facts);
    const stage = stageById(stageId);
    return {
      stage: { id: stage.id, title: stage.title },
      milestone: { id: "acceptance", title: "目标验收完成" },
      nextTask: null,
      milestones: this.goalMilestones(stage.id, facts),
      verified: true,
      complete: true,
      treeSnapshot: tree.snapshot(),
    };
  }

  private goalTask(result: Extract<Resolution, { kind: "skill" }>): GoalTask {
    const spec = result.spec;
    return {
      intent: intentForTaskKind(spec.kind),
      text: spec.title,
      reason: result.reason,
      ...(spec.critical ? { critical: true } : {}),
      skill: spec.skill,
      taskId: result.nodeId,
      targetLock:
        spec.targetLock === null
          ? null
          : {
              ...spec.targetLock,
              cardId: spec.targetLock.cardId ?? null,
              lockedAt: 0,
              expiresAt: 0,
            },
    };
  }

  private goalMilestones(stageId: GoalId, facts: WorldFacts): GoalMilestone[] {
    return stageById(stageId).milestones.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      status:
        evaluateMilestone(milestone, facts) === "complete"
          ? "completed"
          : "unverified",
    }));
  }

  private blocked(
    reason: string,
    facts: WorldFacts,
    stageId = this.currentStageId(facts),
    milestoneId = "blocked",
    milestoneTitle = "等待恢复",
  ): Extract<Resolution, { kind: "blocked" }> {
    return {
      kind: "blocked",
      reason,
      stage: stageId,
      milestoneId,
      milestoneTitle,
    };
  }

  private goalTitle(): string {
    return this.goalKind === "diamond-set"
      ? "集齐全套钻石装备"
      : "击败末影龙";
  }
}

function milestoneDefinition(
  stageId: GoalId,
  node: TaskNode,
): { readonly id: string; readonly title: string; readonly condition: string; readonly verify: (facts: WorldFacts) => "complete" | "incomplete" | "unverified" } | null {
  const milestoneId = milestoneIdOf(node);
  if (milestoneId === null) return null;
  return stageById(stageId).milestones.find((entry) => entry.id === milestoneId) ?? null;
}

function milestoneIdOf(node: TaskNode): string | null {
  if (typeof node.args["milestoneId"] === "string") {
    return node.args["milestoneId"];
  }
  return node.handler.split(":").at(-1) ?? null;
}

function readTaskSpec(node: TaskNode): TaskSpec | null {
  const raw = node.args["task"];
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Partial<TaskSpec>;
  if (
    typeof value.taskId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.stage !== "string" ||
    typeof value.signature !== "string" ||
    value.skill === undefined
  ) {
    return null;
  }
  const skill = skillCallSchema.safeParse(value.skill);
  if (!skill.success) return null;
  return {
    taskId: value.taskId,
    title: value.title,
    kind: value.kind as Task["kind"],
    stage: value.stage as GoalId,
    skill: skill.data,
    critical: value.critical === true,
    targetLock: value.targetLock ?? null,
    signature: value.signature,
  };
}

function terminal(node: TaskNode): boolean {
  return (
    node.state === "succeeded" ||
    node.state === "failed" ||
    node.state === "blocked" ||
    node.state === "invalidated"
  );
}

function intentForTaskKind(kind: Task["kind"]): GoalTask["intent"] {
  switch (kind) {
    case "gather":
    case "mine":
      return "mine";
    case "craft":
    case "smelt":
      return "craft";
    case "place":
      return "build";
    case "navigate":
      return "move";
    case "combat":
      return "danger";
    default:
      return "unknown";
  }
}

function failureCategory(code: string | null | undefined): FailureCategory {
  const value = (code ?? "").toLowerCase();
  if (value.includes("timeout")) return "timeout";
  if (value.includes("operator")) return "operator";
  if (value.includes("danger")) return "danger";
  if (value.includes("world")) return "world_changed";
  if (value.includes("evidence")) return "evidence_conflict";
  if (value.includes("precondition")) return "precondition";
  return "internal";
}

function outcomeDetail(outcome: GoalSettlement): string {
  const code = outcome.errorCode === undefined ? "" : `${outcome.errorCode}: `;
  return `${code}${outcome.detail ?? outcome.status}`.slice(0, 600);
}

function evidenceFor(outcome: GoalSettlement): readonly string[] {
  const evidence = (outcome.changes ?? []).map(
    (change) => `${change.kind}: ${change.detail}`.slice(0, 240),
  );
  return evidence.length > 0 ? evidence : ["settled: completed"];
}

function stageNodeId(rootId: string, stageId: GoalId): string {
  return nodeId(rootId, "stage", stageId);
}

function nodeId(...parts: string[]): string {
  const raw = parts
    .join(":")
    .replace(/[^a-zA-Z0-9:_-]+/gu, "-")
    .replace(/-+/gu, "-");
  if (raw.length <= 100) return raw;
  // Deep trees would otherwise push the ordinal/hash out of the 100-char
  // contract limit, making two different tasks share one id. Keep a readable
  // prefix and append a deterministic hash of the complete path.
  const hash = shortHash(raw);
  return `${raw.slice(0, 91)}-${hash}`;
}

function shortHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 32);
}
