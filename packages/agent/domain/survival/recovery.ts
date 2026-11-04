import { nextTaskForStage } from "./tasks.ts";
import type {
  BlockedTask,
  Recovery,
  RecoveryInput,
  Task,
  TaskFailure,
} from "./types.ts";

/** Failures of the same stage beyond this count are not retried blindly. */
export const MAX_STAGE_ATTEMPTS = 2;

/**
 * Chooses a next task after a body result without replaying the strategy that
 * just failed. Failure history is passed in rather than stored, which keeps
 * the function pure and lets the runtime persist only what it needs.
 */
export function recover(input: RecoveryInput): Recovery {
  const history = [...(input.history ?? []), input.failure];
  const avoid = history.map((entry) => entry.taskId);
  const sameStage = history.filter((entry) => entry.stage === input.failure.stage);
  const task = input.plan.task;

  if (sameStage.length >= MAX_STAGE_ATTEMPTS) {
    return {
      task: null,
      reason: `阶段「${input.plan.stageTitle}」连续失败 ${sameStage.length} 次，停止重复同一策略`,
      avoid,
      blocked: [
        {
          stage: input.failure.stage,
          kind: task?.kind ?? "gather",
          title: `需要人工检查：${input.failure.detail}`,
          missing: [
            {
              kind: "safety",
              detail: `最近失败：${input.failure.code} ${input.failure.detail}`,
            },
          ],
        },
      ],
    };
  }

  if (task !== null && !avoid.includes(task.id)) {
    const failedSameKind = sameStage.some((entry) => entry.taskId === task.id);
    if (!failedSameKind) {
      return {
        task,
        reason: `重新观察后仍可执行「${task.title}」；不重放已失败的任务`,
        avoid,
        blocked: [],
      };
    }
  }

  const alternative = nextTaskForStage({
    stage: input.failure.stage,
    facts: input.facts,
    newId: () => crypto.randomUUID(),
  });
  if (alternative !== null && "skill" in alternative && !avoid.includes(alternative.id)) {
    return {
      task: alternative,
      reason: "当前任务不可复用，改用同阶段的下一个候选任务",
      avoid,
      blocked: [],
    };
  }
  return {
    task: null,
    reason: `没有安全的新任务：${input.failure.detail}`,
    avoid,
    blocked: alternative !== null && !("skill" in alternative) ? [alternative] : [],
  };
}

/** True when a failed task should not be reissued unchanged. */
export function isRepeatedFailure(failure: TaskFailure, history: readonly TaskFailure[]): boolean {
  return history.some((entry) => entry.taskId === failure.taskId && entry.code === failure.code);
}

export function avoidSet(recovery: Recovery): ReadonlySet<string> {
  return new Set(recovery.avoid);
}

export function taskSignature(task: Task): string {
  return `${task.stage}:${task.kind}:${task.skill.name}:${JSON.stringify(task.skill.args)}`;
}

export function blockedFrom(recovery: Recovery): readonly BlockedTask[] {
  return recovery.blocked;
}
