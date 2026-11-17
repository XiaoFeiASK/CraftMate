import {
  deadEndEscapeTask,
  nextTaskForStage,
  woodSourceFallbackTask,
} from "./tasks.ts";
import { isNight, isUnderground } from "./facts.ts";
import type {
  BlockedTask,
  Recovery,
  RecoveryInput,
  Task,
  TaskFailure,
} from "./types.ts";

/** A task may be retried once; two failures require a different strategy. */
export const MAX_STAGE_ATTEMPTS = 2;

export type FailureClass =
  | "NO_PATH"
  | "RESOURCE_NOT_FOUND"
  | "TOOL_TOO_LOW"
  | "STATION_UNREACHABLE"
  | "NIGHT_TOO_DANGEROUS"
  | "INVENTORY_FULL"
  | "NO_PROGRESS"
  | "TIMEOUT"
  | "UNKNOWN";

/**
 * Converts the body's free-text failure into the small set of causes that
 * actually change the recovery move. The order matters: a missing station is
 * not just another path failure, and a broken pickaxe must not be retried as
 * if a fresh observation could repair it.
 */
export function classifyFailure(
  failure: Pick<TaskFailure, "code" | "detail">,
): FailureClass {
  const text = `${failure.code} ${failure.detail}`.toLowerCase();
  if (
    /inventory.*full|backpack.*full|full inventory|no space|背包已满|物品栏已满/u.test(
      text,
    )
  ) {
    return "INVENTORY_FULL";
  }
  if (
    /pickaxe|tool.*(low|broke|durab)|durability|镐|工具.*(耐久|损坏)|需要.*镐/u.test(
      text,
    )
  ) {
    return "TOOL_TOO_LOW";
  }
  if (/night|dark|天黑|夜间|入夜/u.test(text)) {
    return "NIGHT_TOO_DANGEROUS";
  }
  if (
    failure.code.toLowerCase().includes("timeout") ||
    /timed? out|timeout|deadline|超时/u.test(text)
  ) {
    return "TIMEOUT";
  }
  if (
    /crafting_table|\btable\b|furnace|chest|bed|station|工作台|熔炉|箱子|床/u.test(text) &&
    /unreach|route|walk|reach|approach|too far|no progress|stuck|寻路|接近|走不到|不可达|没有进展/u.test(
      text,
    )
  ) {
    return "STATION_UNREACHABLE";
  }
  if (/no progress|stuck|no movement|卡住|没有进展|无进展/u.test(text)) {
    return "NO_PROGRESS";
  }
  if (
    /not found|no .* nearby|no .* within|not visible|no longer visible|no visible|找不到|看不见|附近没有|未发现/u.test(
      text,
    )
  ) {
    return "RESOURCE_NOT_FOUND";
  }
  /*
   * The container is open and reachable, but it holds none of the requested
   * category. That is a resource verdict, not an unknown failure that can be
   * fixed by reopening the same chest.
   */
  if (
    /no more matching items remain|no matching items remain|container.*(?:empty|no room)/iu.test(
      text,
    )
  ) {
    return "RESOURCE_NOT_FOUND";
  }
  if (
    /route|path|reach|approach|navigate|stopped short|unreachable|obstruct|blocked|no safe|no valid|no usable|no direction|behind a wall|寻路|路线|接近|到达|不可达|受阻/u.test(
      text,
    )
  ) {
    return "NO_PATH";
  }
  return "UNKNOWN";
}

/**
 * Chooses a next task after a body result without replaying the strategy that
 * just failed. Failure history is passed in rather than stored, which keeps
 * the function pure and lets the runtime persist only what it needs.
 */
export function recover(input: RecoveryInput): Recovery {
  const failureClass = classifyFailure(input.failure);
  const failureText = `${input.failure.code} ${input.failure.detail}`;
  const history = [...(input.history ?? []), input.failure];
  const avoid = history.map((entry) => normalizedTaskId(entry.taskId));
  const sameStage = history.filter((entry) => entry.stage === input.failure.stage);
  const task = input.plan.task;
  const taskKey = task === null ? null : normalizedTaskId(taskSignature(task));
  const avoidStrategies = new Set(avoid);
  if (taskKey !== null) avoidStrategies.add(taskKey);

  /*
   * A stair can dead-end on a dry ledge with water around every descent and
   * branch face. Retrying the same mine_tunnel only produced another
   * E_PRECONDITION, and the generic alternative was an enclosed goto to the
   * old entrance. Switch to the explicit escape task immediately: mine the
   * overhead face or pillar until the body is out of the pocket.
   */
  if (
    task !== null &&
    ((task.skill.name === "mine_tunnel" &&
      /no safe mining direction|no safe mining|no direction/iu.test(
        failureText,
      )) ||
      (task.skill.name === "goto" &&
        (input.failure.code === "E_ENCLOSED" ||
          /enclosed|no safe route and no legal recovery step/iu.test(
            failureText,
          ))))
  ) {
    const escape = deadEndEscapeTask(
      input.failure.stage,
      input.facts,
      () => crypto.randomUUID(),
    );
    if (escape !== null) {
      return {
        task: escape,
        reason: "矿道死端没有安全下挖或侧切方向；改为挖开头顶/垫高脱困",
        avoid,
        blocked: [],
      };
    }
  }

  /*
   * "No more matching items remain" is a content verdict, not a transient
   * approach failure. Retrying the same chest produced three identical
   * withdraw attempts in the live run while seven trees were visible.
   */
  if (
    task !== null &&
    task.skill.name === "withdraw" &&
    /no more matching items remain|no matching .* in .*containers?/iu.test(
      `${input.failure.code} ${input.failure.detail}`,
    )
  ) {
    const woodFallback = woodSourceFallbackTask(
      input.failure.stage,
      input.facts,
      () => crypto.randomUUID(),
    );
    if (woodFallback !== null) {
      return {
        task: woodFallback,
        reason: "附近箱子都没有木头；改为砍树补充",
        avoid,
        blocked: [],
      };
    }
    return {
      task: null,
      reason: "附近箱子都没有木头，也没有可搜索的树木",
      avoid,
      blocked: [],
    };
  }

  const retryAllowed =
    failureClass !== "INVENTORY_FULL" &&
    failureClass !== "TOOL_TOO_LOW" &&
    failureClass !== "NIGHT_TOO_DANGEROUS";
  if (task !== null && retryAllowed) {
    const sameTaskFailures = sameStage.filter(
      (entry) =>
        normalizedTaskId(entry.taskId) === taskKey ||
        normalizedTaskId(entry.taskId) === normalizedTaskId(task.id),
    ).length;
    if (sameTaskFailures < MAX_STAGE_ATTEMPTS) {
      return {
        task,
        reason:
          sameTaskFailures === 0
            ? `重新观察后改用「${task.title}」`
            : `重新观察后重试一次「${task.title}」；世界状态可能已变化`,
        avoid,
        blocked: [],
      };
    }
  }

  // A bed is a short-range interaction, but the body's sleep approach is a
  // plain walk while goto can dig, step and pillar around rough shelter
  // floors. When that walk fails at night, do not park the body until dawn:
  // pretend the bed is unavailable for one replan so the current stage can
  // choose real night work (mining, crafting, storage) instead.
  if (
    task !== null &&
    task.skill.name === "sleep" &&
    input.facts.sleeping !== true &&
    isNight(input.facts) === true &&
    (failureClass === "STATION_UNREACHABLE" ||
      failureClass === "NO_PROGRESS" ||
      failureClass === "NO_PATH")
  ) {
    const withoutBed: RecoveryInput["facts"] = {
      ...input.facts,
      bed: null,
      bedPlaced: false,
      bedInReach: false,
      sleeping: false,
      ...(input.facts.nearbyBlocks === undefined
        ? {}
        : {
            nearbyBlocks: input.facts.nearbyBlocks.filter(
              (block) => !/(^|:)[a-z_]+_bed$/u.test(block.id),
            ),
          }),
    };
    const nightWork = nextTaskForStage({
      stage: input.failure.stage,
      facts: withoutBed,
      newId: () => crypto.randomUUID(),
    });
    if (
      nightWork !== null &&
      "skill" in nightWork &&
      !avoidStrategies.has(normalizedTaskId(taskSignature(nightWork)))
    ) {
      return {
        task: nightWork,
        reason: "床的接近路线失败；夜间改做当前阶段的挖矿、制作或整理工作",
        avoid,
        blocked: [],
      };
    }
    return {
      task: null,
      reason: "床的接近路线失败，当前也没有安全的夜间工作",
      avoid,
      blocked:
        nightWork !== null && !("skill" in nightWork) ? [nightWork] : [],
    };
  }

  // A station the body can see but cannot stand beside is not recoverable by
  // walking to it again. On the fallback branch, present the planner with a
  // world where that station is unusable so it builds a replacement instead
  // of replaying the same approach forever.
  const stationText = `${input.failure.code} ${input.failure.detail}`;
  const recoverableFacts: RecoveryInput["facts"] =
    failureClass === "STATION_UNREACHABLE" &&
    /crafting_table|\btable\b|工作台/iu.test(stationText)
      ? {
          ...input.facts,
          craftingTable: null,
          craftingTablePlaced: false,
          craftingTableNearby: false,
          craftingTableReachable: false,
          // The old block is still visible, but recovery is explicitly
          // declining to use it. Remove it from station inference so the
          // planner can build a replacement instead of reusing the same
          // unreachable block through `nearbyBlocks`.
          ...(input.facts.nearbyBlocks === undefined
            ? {}
            : {
                nearbyBlocks: input.facts.nearbyBlocks.filter(
                  (block) => !/(^|:)crafting_table$/u.test(block.id),
                ),
              }),
          ...(input.facts.stations === undefined
            ? {}
            : {
                stations: input.facts.stations.filter(
                  (station) => station !== "crafting_table",
                ),
              }),
        }
      : input.facts;
  const alternative = nextTaskForStage({
    stage: input.failure.stage,
    facts: recoverableFacts,
    newId: () => crypto.randomUUID(),
  });
  /*
   * The way out of a mine is not an optional detour that a previous failure
   * can blacklist. Once the station is gone and the body is still underground,
   * the climb-to-surface plan is the only path that can restore the table and
   * the pickaxe. The old avoid set contained that exact goto from an earlier
   * attempt, so every replan returned null and the goal parked as blocked
   * forever. Reissue the escape; the body's position changes as it climbs and
   * the runtime's failure backoff still caps the retry rate.
   */
  if (
    failureClass === "STATION_UNREACHABLE" &&
    /crafting_table|\btable\b|工作台/iu.test(stationText) &&
    isUnderground(input.facts) &&
    alternative !== null &&
    "skill" in alternative &&
    alternative.kind === "navigate" &&
    alternative.skill.name === "goto" &&
    alternative.skill.args["mode"] === "recover"
  ) {
    return {
      task: alternative,
      reason: "工作台不可达且身处地下：先沿已有矿道返回地表",
      avoid,
      blocked: [],
    };
  }
  /*
   * A chest can be empty of wood even though it is openable. Repeating the
   * same withdraw forever would starve the mine; treat that chest as
   * unavailable for one replan so the wood reserve falls back to chopping.
   */
  if (task !== null && task.skill.name === "withdraw") {
    const woodFallback = nextTaskForStage({
      stage: input.failure.stage,
      facts: { ...input.facts, chest: null },
      newId: () => crypto.randomUUID(),
    });
    if (
      woodFallback !== null &&
      "skill" in woodFallback &&
      woodFallback.skill.name !== "withdraw"
    ) {
      return {
        task: woodFallback,
        /*
         * A previous chop_tree failure must not block this fallback. The
         * chest has just been proven empty of wood, so the only remaining
         * source is a tree; the runtime's failure backoff still caps retries
         * and the newer body selects the lowest trunk log.
         */
        reason: "箱子没有可取回的木头；改为砍树补充",
        avoid,
        blocked: [],
      };
    }
  }
  if (
    alternative !== null &&
    "skill" in alternative &&
    !avoidStrategies.has(normalizedTaskId(taskSignature(alternative)))
  ) {
    return {
      task: alternative,
      reason: "当前任务不可复用，改用同阶段的下一个候选任务",
      avoid,
      blocked: [],
    };
  }
  return {
    task: null,
    reason:
      taskKey !== null &&
      sameStage.filter((entry) => normalizedTaskId(entry.taskId) === taskKey).length >=
        MAX_STAGE_ATTEMPTS
        ? `阶段「${input.plan.stageTitle}」的同一策略已失败两次，停止重复`
        : sameStage.length >= MAX_STAGE_ATTEMPTS
          ? `阶段「${input.plan.stageTitle}」已连续失败 ${MAX_STAGE_ATTEMPTS} 次，没有安全替代`
          : `没有安全的新任务：${input.failure.detail}`,
    avoid,
    blocked: alternative !== null && !("skill" in alternative) ? [alternative] : [],
  };
}

/** True when a failed task should not be reissued unchanged. */
export function isRepeatedFailure(failure: TaskFailure, history: readonly TaskFailure[]): boolean {
  return history.some(
    (entry) => normalizedTaskId(entry.taskId) === normalizedTaskId(failure.taskId) && entry.code === failure.code,
  );
}

export function avoidSet(recovery: Recovery): ReadonlySet<string> {
  return new Set(recovery.avoid);
}

export function taskSignature(task: Task): string {
  return `${task.stage}:${task.kind}:${task.skill.name}:${canonicalJson(task.skill.args)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Task ids generated by the planner may already contain the strategy
 * signature. The `task:` prefix is a storage detail, not part of the
 * identity used to decide whether an action was already tried.
 */
export function normalizedTaskId(taskId: string): string {
  return taskId.startsWith("task:") ? taskId.slice("task:".length) : taskId;
}

export function blockedFrom(recovery: Recovery): readonly BlockedTask[] {
  return recovery.blocked;
}
