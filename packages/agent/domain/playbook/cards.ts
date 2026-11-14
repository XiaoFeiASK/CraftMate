import type { GoalStrategy } from "@craftmate/contracts";
import {
  hasHostileNearby,
  hasUsablePickaxe,
  isDay,
  isNight,
  isUnderground,
  pickaxeTier,
  pickaxeUses,
  worldFactsFromSnapshot,
} from "../survival/facts.ts";
import {
  explore,
  gotoHomeTask,
  nextTaskForStage,
  nightWorkTask,
  returnToSurfaceTask,
  woodGatherTask,
} from "../survival/tasks.ts";
import type {
  BlockedTask,
  GoalId,
  Task,
  WorldFacts,
} from "../survival/types.ts";
import {
  cardEvaluation,
  memorySatisfiesPrecondition,
  type CardContext,
  type CardEvaluation,
  type PlaybookCard,
} from "./types.ts";

const FOOD_ITEMS =
  /(^|:)apple$|(^|:)baked_potato$|(^|:)bread$|(^|:)carrot$|(^|:)potato$|(^|:)beetroot$|(^|:)sweet_berries$|(^|:)melon_slice$|(^|:)cookie$|(^|:)golden_apple$|(^|:)golden_carrot$|(^|:)pumpkin_pie$|(^|:)honey_bottle$|(^|:)(cooked_)?(beef|chicken|cod|mutton|porkchop|rabbit|salmon)$|(^|:)rotten_flesh$/u;
const HOSTILE =
  /zombie|husk|drowned|skeleton|stray|creeper|spider|witch|pillager|vindicator|evoker|ravager|enderman|slime|magma_cube|blaze|ghast|wither|piglin|hoglin|phantom/iu;
const WOOD_ITEMS = /(^|:)[a-z_]+_(log|wood|stem|hyphae)$/u;
const IRON_ORE = /(^|:)iron_ore$/u;
const BED_ITEMS = /(^|:)[a-z_]+_bed$/u;
const BUILDING_BLOCKS =
  /(^|:)(cobblestone|cobbled_deepslate|stone|deepslate|dirt|gravel|sand|sandstone|andesite|diorite|granite|tuff)$/u;

function taskResult(
  card: PlaybookCard,
  task: Task | BlockedTask | null,
  predicate: (task: Task) => boolean,
  allowCritical = false,
  blockedReason?: string,
): CardEvaluation {
  if (task === null) {
    return cardEvaluation(card, "done", "当前事实下没有需要执行的动作");
  }
  if (!("skill" in task)) {
    return cardEvaluation(
      card,
      "blocked",
      blockedReason ?? task.missing[0]?.detail ?? "任务前置条件不足",
    );
  }
  if (task.critical === true && !allowCritical) {
    return cardEvaluation(card, "blocked", "当前有更高优先级的安全/恢复动作");
  }
  if (!predicate(task)) {
    return cardEvaluation(card, "blocked", "当前情境不需要这张卡");
  }
  return cardEvaluation(card, "available", task.title, task);
}

function fromStage(
  card: PlaybookCard,
  context: CardContext,
  stage: GoalId,
  predicate: (task: Task) => boolean,
  allowCritical = false,
  options: {
    readonly scopes?: readonly ("full" | "stage")[];
    readonly blockedReason?: string;
  } = {},
): CardEvaluation {
  const scopes = options.scopes ?? (["full"] as const);
  let first: Task | BlockedTask | null = null;
  for (const scope of scopes) {
    const task = nextTaskForStage({
      stage,
      facts: context.facts,
      newId: context.newId,
      scope,
    });
    if (first === null) first = task;
    if (task !== null && "skill" in task && predicate(task)) {
      return taskResult(card, task, predicate, allowCritical);
    }
  }
  return taskResult(
    card,
    first,
    predicate,
    allowCritical,
    options.blockedReason,
  );
}

function foodCount(facts: WorldFacts): number {
  return facts.inventory.reduce(
    (total, slot) => total + (FOOD_ITEMS.test(slot.item) ? slot.count : 0),
    0,
  );
}

function usedSlots(facts: WorldFacts): number {
  return facts.inventory.filter((slot) => slot.count > 0).length;
}

function logCount(facts: WorldFacts): number {
  return facts.inventory.reduce(
    (total, slot) => total + (WOOD_ITEMS.test(slot.item) ? slot.count : 0),
    0,
  );
}

function buildingBlockCount(facts: WorldFacts): number {
  return facts.inventory.reduce(
    (total, slot) => total + (BUILDING_BLOCKS.test(slot.item) ? slot.count : 0),
    0,
  );
}

function hungryForStrategy(facts: WorldFacts, strategy: GoalStrategy): boolean {
  return (
    facts.food !== undefined &&
    facts.food !== null &&
    facts.food <= strategy.eatBelow
  );
}

function hasWeapon(facts: WorldFacts): boolean {
  return facts.inventory.some((slot) =>
    /(^|:)(wooden|stone|iron|golden|diamond|netherite)_(sword|axe)$/u.test(slot.item),
  );
}

function isFull(facts: WorldFacts, strategy: GoalStrategy): boolean {
  return usedSlots(facts) >= Math.max(1, 36 - strategy.miningEmptySlots);
}

function isHurt(facts: WorldFacts, strategy: GoalStrategy): boolean {
  return (facts.health ?? 20) <= strategy.retreatHealth;
}

/**
 * Surface work closes before the sky actually turns dark. The body needs the
 * remaining daylight to reach shelter; waiting until `isNight` lets it start
 * a tree chop at dusk and get trapped outside.
 */
function pastNightReturn(facts: WorldFacts, strategy: GoalStrategy): boolean {
  const time = facts.timeOfDay;
  return time !== null && time !== undefined && time >= strategy.nightReturnAt;
}

/**
 * A creeper nine blocks away across a pond is not a fuse. The old eight-block
 * card gate, combined with a nine-block reflex, kept cancelling every swim
 * and goto while the mob stood on the far bank. Keep creeper reactions local;
 * other hostiles use the ordinary melee/bow window.
 */
function hostileRange(type: string, radius: number): number {
  return /(^|:)creeper$/u.test(type) ? Math.min(radius, 5) : radius;
}

function threatNearby(facts: WorldFacts, radius = 8): boolean {
  return (facts.entities ?? []).some(
    (entity) =>
      entity.distance <= hostileRange(entity.type, radius) &&
      HOSTILE.test(entity.type),
  );
}

function makeCard(
  input: Omit<PlaybookCard, "evaluate"> & {
    readonly evaluate: (context: CardContext) => CardEvaluation;
  },
): PlaybookCard {
  return input;
}

function nearestThreat(facts: WorldFacts, radius = 10) {
  return [...(facts.entities ?? [])]
    .filter(
      (entity) =>
        entity.distance <= hostileRange(entity.type, radius) &&
        HOSTILE.test(entity.type),
    )
    .sort((left, right) => left.distance - right.distance)[0] ?? null;
}

function homeAnchor(facts: WorldFacts) {
  /*
   * A mine entrance is a workplace, not a home. A bed or a placed chest is
   * the only durable anchor that authorises a nightly return. The body no
   * longer builds a starter hut, so there is no shelter fact to consult.
   */
  return facts.bed ?? facts.chest ?? null;
}

/** A bed the body can sleep in tonight, without a trip to find sheep. */
function hasBedAccess(facts: WorldFacts): boolean {
  return (
    facts.bed !== null &&
    facts.bed !== undefined
  ) ||
    facts.bedPlaced === true ||
    facts.inventory.some((slot) => BED_ITEMS.test(slot.item)) ||
    (facts.nearbyBlocks ?? []).some((block) => BED_ITEMS.test(block.id));
}

/** True when the body is already standing at a remembered safe place. */
function atSafeAnchor(facts: WorldFacts): boolean {
  const anchor = homeAnchor(facts);
  const position = facts.position;
  if (anchor === null || position === null || position === undefined) return false;
  return Math.hypot(
    position.x - anchor.x,
    (position.y ?? anchor.y) - anchor.y,
    position.z - anchor.z,
  ) <= 8;
}

/** Standable cells around a remembered station, never its own block cell. */
function adjacentCells(anchor: { readonly x: number; readonly y: number; readonly z: number }) {
  return [
    { x: anchor.x + 1, y: anchor.y, z: anchor.z },
    { x: anchor.x - 1, y: anchor.y, z: anchor.z },
    { x: anchor.x, y: anchor.y, z: anchor.z + 1 },
    { x: anchor.x, y: anchor.y, z: anchor.z - 1 },
  ];
}

function retreatTask(
  context: CardContext,
  strategy: GoalStrategy,
): Task | null {
  const position = context.facts.position;
  if (position === undefined || position === null) return null;
  const threat = nearestThreat(context.facts, 10);
  /*
   * An unarmed body cannot win a melee trade. Prefer crafting a sword
   * earlier, but once a mob is already in reach the only reliable response
   * is to sprint away. Do not dig a temporary hole: the body cannot fight
   * from it, and the live runs showed that a vertical hideout delayed the
   * escape without preventing the hit.
   *
   * This is ordinary walking, not a mining errand. A retreat that tunnels or
   * pillars while a mob is adjacent spends the escape budget on blocks and
   * leaves the body in the same danger; if walking has no route, the recovery
   * cards own the next decision.
   */
  let candidates: { x: number; y: number; z: number }[];
  if (threat !== null) {
    const dx = position.x - (threat.x ?? position.x);
    const dz = position.z - (threat.z ?? position.z);
    const length = Math.hypot(dx, dz) || 1;
    candidates = [-0.5, 0, 0.5].map((offset) => {
      const angle = Math.atan2(dz, dx) + offset;
      return {
        x: Math.round((position.x + Math.cos(angle) * 16) * 10) / 10,
        y: position.y,
        z: Math.round((position.z + Math.sin(angle) * 16) * 10) / 10,
      };
    });
  } else {
    const home = homeAnchor(context.facts);
    candidates = home === null
      ? [
          {
            x: position.x,
            // Without a remembered camp, a same-level target made the live
            // body tunnel east and west forever inside the same two blocks.
            // Underground the only useful retreat is upward: the goto skill
            // can mine through the ceiling and pillar back to daylight.
            y: position.y + (isUnderground(context.facts) ? 24 : 12),
            z: position.z,
          },
        ]
      : adjacentCells(home);
  }
  const title = threat === null
    ? "低血量回营地休整"
    : `低血量撤离 ${threat.type}`;
  return {
    id: `task:${context.newId()}`,
    stage: context.stage,
    kind: "navigate",
    title,
    critical: true,
    skill: {
      name: "goto",
      args: {
        target: candidates[0]!,
        candidates,
        acceptPartial: true,
        mode: "walk",
        emergency: true,
      },
      idempotencyKey: context.newId(),
    },
    preconditions: ["low health or a hostile within ten blocks"],
    expectedEvidence: ["the body reaches a safer distance or the camp"],
    verify: () => true,
  };
}

/**
 * Repeated walk failures only justify a destructive dig-out when the body is
 * actually enclosed by terrain. A beach, a forest edge or an open-ocean
 * surface also produces `E_UNREACHABLE` for every target on the far side of
 * the obstacle, but there is no wall to mine; those states belong to walking,
 * re-observing or swimming. `shaftWalls` is the body's measured horizontal
 * solid-neighbour count and is the cheapest positive signal for a pocket.
 */
function boxedInByTerrain(context: CardContext): boolean {
  if (
    context.consecutiveFailures < 3 ||
    context.lastFailure === null ||
    !/E_UNREACHABLE|E_STUCK/u.test(context.lastFailure) ||
    !hasUsablePickaxe(context.facts, 2) ||
    context.facts.inWater === true
  ) {
    return false;
  }
  return (
    context.facts.enclosed === true ||
    isUnderground(context.facts) ||
    (context.facts.shaftWalls ?? 0) >= 2
  );
}

function sleepTask(context: CardContext): Task {
  return {
    id: `task:${context.newId()}`,
    stage: context.stage,
    kind: "interact",
    title: "入夜前回家睡觉",
    critical: true,
    skill: {
      name: "sleep",
      args: {},
      idempotencyKey: context.newId(),
    },
    preconditions: ["night time", "a usable bed is nearby"],
    expectedEvidence: ["the body sleeps and the day advances"],
    verify: () => true,
  };
}

/**
 * Night is for sleeping when a bed exists, not for sitting in a hole until
 * sunrise. A body without a bed keeps doing useful underground work instead.
 */
function returnHomeTask(context: CardContext): Task | null {
  const home = homeAnchor(context.facts);
  const position = context.facts.position;
  if (home === null || position === undefined || position === null) return null;
  const distance = Math.hypot(
    home.x - position.x,
    home.y - position.y,
    home.z - position.z,
  );
  if (distance > 4) {
    const candidates = adjacentCells(home);
    return {
      id: `task:${context.newId()}`,
      stage: context.stage,
      kind: "navigate",
      title: "天色将晚，先回营地",
      critical: true,
      skill: {
        name: "goto",
        args: {
          target: candidates[0]!,
          candidates,
          acceptPartial: true,
          mode: "walk",
        },
        idempotencyKey: context.newId(),
      },
      preconditions: ["the configured nightly return time has arrived"],
      expectedEvidence: ["the body reaches the camp"],
      verify: () => true,
    };
  }
  if (isNight(context.facts) !== true) return null;
  return context.facts.bed === null || context.facts.bed === undefined
    ? null
    : sleepTask(context);
}

function combatTask(context: CardContext): Task | null {
  const threat = nearestThreat(context.facts, 8);
  if (threat === null) return null;
  return {
    id: `task:${context.newId()}`,
    stage: context.stage,
    kind: "combat",
    title: `击退近身威胁 ${threat.type}`,
    skill: {
      name: "attack",
      args: {
        target: threat.type,
        count: 1,
        radius: 12,
        lethal: true,
        collect: false,
      },
      idempotencyKey: context.newId(),
    },
    preconditions: ["a hostile is within melee range", "health and weapon are sufficient"],
    expectedEvidence: ["the hostile loses health or dies", "the immediate threat leaves"],
    verify: () => true,
  };
}

const safetyEat = makeCard({
  id: "safety.eat",
  title: "饿了先吃",
  group: "safety",
  stage: "any",
  priority: 100,
  risk: "low",
  critical: true,
  minDwellMs: 0,
  expectedEvidence: ["食物数量减少", "饥饿值回升或进食事件确认"],
  recovery: ["safety.retreat", "food.hunt"],
  stopConditions: ["饥饿值恢复到安全线", "背包没有可食用食物"],
  evaluate: (context) =>
    cardEvaluation(
      safetyEat,
      "blocked",
      "占位卡，在目录构建时替换",
    ),
});

/**
 * The catalog is intentionally hand-sized. A model can see every card, but
 * the deterministic evaluator decides whether each one is legal right now.
 */
export function playbookCards(strategy: GoalStrategy): readonly PlaybookCard[] {
  const safetyEatCard: PlaybookCard = {
    ...safetyEat,
    evaluate: (context) => {
      if (!hungryForStrategy(context.facts, strategy)) {
        return cardEvaluation(safetyEatCard, "blocked", "饥饿值高于进食阈值");
      }
      return fromStage(
        safetyEatCard,
        context,
        context.stage,
        (task) => task.skill.name === "eat",
        true,
        { blockedReason: "背包里没有可食用食物" },
      );
    },
  };

  const safetyRetreatCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "safety.retreat",
    title: "低血或近身威胁先撤",
    group: "safety",
    stage: "any",
    priority: 110,
    risk: "low",
    critical: true,
    minDwellMs: 0,
    expectedEvidence: ["与威胁距离拉开", "生命值不再下降"],
    recovery: ["safety.eat", "safety.night_home", "recovery.reobserve"],
    stopConditions: ["威胁离开交互范围", "生命值恢复到安全线"],
    evaluate: (context) => {
      const threat = threatNearby(context.facts);
      const health = context.facts.health ?? 20;
      if (
        !threat &&
        isHurt(context.facts, strategy) &&
        atSafeAnchor(context.facts)
      ) {
        return cardEvaluation(
          safetyRetreatCard,
          "blocked",
          "已在营地，低血量应先进食或寻找食物恢复",
        );
      }
      if (!threat && !isHurt(context.facts, strategy)) {
        return cardEvaluation(safetyRetreatCard, "blocked", "当前没有近身威胁且血量安全");
      }
      if (!threat && isHurt(context.facts, strategy) && homeAnchor(context.facts) === null) {
        /*
         * Low health is a permanent state until the body eats, and without a
         * camp the old retreat target was simply "twelve blocks sideways".
         * That made the critical gate own every planning cycle and tunnel in
         * place until the coordinate-stall alarm fired. At night the correct
         * move is to let the shelter cards take over; by day underground the
         * body should climb out, and on the surface it should look for food.
         */
        if (isNight(context.facts) === true) {
          return cardEvaluation(
            safetyRetreatCard,
            "blocked",
            "夜间没有可回的营地，继续地下工作并避开交战",
          );
        }
        if (!isUnderground(context.facts)) {
          return cardEvaluation(
            safetyRetreatCard,
            "blocked",
            "没有可回的营地，先寻找食物或恢复",
          );
        }
      }
      if (
        threat &&
        health >= strategy.engageHealth &&
        hasWeapon(context.facts)
      ) {
        return cardEvaluation(
          safetyRetreatCard,
          "blocked",
          "血量和武器足够，优先清理近身威胁",
        );
      }
      const task = retreatTask(context, strategy);
      return task === null
        ? cardEvaluation(safetyRetreatCard, "blocked", "无法计算安全的撤退方向")
        : cardEvaluation(safetyRetreatCard, "available", task.title, task);
    },
  };

  const safetyNightHomeCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "safety.night_home",
    title: "天黑有床就回家睡觉",
    group: "safety",
    stage: "any",
    priority: 95,
    risk: "low",
    critical: true,
    minDwellMs: 0,
    expectedEvidence: ["回到床边", "完成睡眠并跨过夜晚"],
    recovery: ["home.bed", "recovery.reobserve"],
    stopConditions: ["天亮", "床已确认"],
    evaluate: (context) => {
      const time = context.facts.timeOfDay;
      if (context.facts.sleeping === true) {
        return cardEvaluation(safetyNightHomeCard, "done", "已经入睡");
      }
      if (
        time === null ||
        time === undefined ||
        time < strategy.nightReturnAt
      ) {
        return cardEvaluation(
          safetyNightHomeCard,
          "blocked",
          "还没到回家时间，继续手头工作",
        );
      }
      // A temporary dirt hole is not a home. Only a real bed authorises the
      // nightly trip back; without one the body keeps mining or crafting.
      const bedKnown =
        (context.facts.bed !== null && context.facts.bed !== undefined) ||
        context.facts.bedPlaced === true;
      if (!bedKnown || homeAnchor(context.facts) === null) {
        return cardEvaluation(
          safetyNightHomeCard,
          "blocked",
          "没有床：夜间继续挖矿、制作或整理物资",
        );
      }
      if (isNight(context.facts) !== true) {
        return cardEvaluation(
          safetyNightHomeCard,
          "blocked",
          "天还没黑，先继续手头工作",
        );
      }
      const task = returnHomeTask(context);
      return task === null
        ? cardEvaluation(
            safetyNightHomeCard,
            "blocked",
            "床边还不可用，继续等待可入睡时机",
          )
        : cardEvaluation(safetyNightHomeCard, "available", task.title, task);
    },
  };

  const recoveryToolCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "recovery.tool",
    title: "镐坏了先修工具",
    group: "recovery",
    stage: "any",
    priority: 85,
    risk: "medium",
    critical: true,
    minDwellMs: 0,
    expectedEvidence: ["获得或装备可用镐", "工具耐久恢复"],
    recovery: ["craft.upgrade", "recovery.reobserve"],
    stopConditions: ["拥有可用镐"],
    evaluate: (context) => {
      const tier = pickaxeTier(context.facts);
      const uses = pickaxeUses(context.facts);
      if (tier > 0 && (uses === null || uses > 4)) {
        return cardEvaluation(recoveryToolCard, "blocked", "当前镐仍可用");
      }
      return fromStage(
        recoveryToolCard,
        context,
        tier < 2 ? "stone-tools" : context.stage,
        (task) =>
          task.skill.name === "craft" ||
          task.skill.name === "equip" ||
          /镐|工具|修复/u.test(task.title),
        true,
        {
          scopes: ["full", "stage"],
          blockedReason: "当前没有可修复或可制作的镐",
        },
      );
    },
  };

  const recoveryUnloadCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "recovery.unload",
    title: "背包满了先卸货",
    group: "recovery",
    stage: "any",
    priority: 80,
    risk: "low",
    critical: true,
    minDwellMs: 0,
    expectedEvidence: ["空出可用物品栏", "物资存入箱子"],
    recovery: ["home.store", "recovery.reobserve"],
    stopConditions: ["空出至少 4 个格子"],
    evaluate: (context) => {
      if (!isFull(context.facts, strategy)) {
        return cardEvaluation(recoveryUnloadCard, "blocked", "背包仍有空间");
      }
      return fromStage(
        recoveryUnloadCard,
        context,
        "shelter",
        (task) => /背包|箱子|存放|储物|卸货/u.test(task.title),
        true,
        { blockedReason: "当前没有可用的卸货路线" },
      );
    },
  };

  const recoveryReobserveCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "recovery.reobserve",
    title: "失败两次就换区域观察",
    group: "recovery",
    stage: "any",
    priority: 75,
    risk: "low",
    critical: false,
    minDwellMs: 0,
    expectedEvidence: ["到达新的观察区域", "下一轮快照出现新资源或新路线"],
    recovery: ["explore.surface", "mine.surface"],
    stopConditions: ["找到新资源", "连续换区仍无进展"],
    evaluate: (context) => {
      const recoveryRetry =
        context.lastStrategy?.includes("recovery.escape") === true &&
        context.lastFailure !== null &&
        /E_TIMEOUT|E_STUCK|E_UNREACHABLE|E_ENCLOSED/u.test(
          context.lastFailure,
        );
      // A body sealed inside a roofed hut or a one-block shaft cannot reach
      // any observation target. Re-observe used to burn every planning cycle
      // walking into the same four walls. Escape owns that state.
      if (
        recoveryRetry ||
        context.facts.enclosed === true ||
        (context.lastFailure !== null &&
          /E_ENCLOSED/u.test(context.lastFailure))
      ) {
        return cardEvaluation(
          recoveryReobserveCard,
          "blocked",
          "身体处于封闭空间，先脱困再换区域观察",
        );
      }
      // The same far-away observation request cannot solve a body that is
      // boxed in by three walls and water. Once walk has failed repeatedly,
      // recovery must mine a corridor instead of blacklisting more regions.
      if (boxedInByTerrain(context)) {
        return cardEvaluation(
          recoveryReobserveCard,
          "blocked",
          "连续寻路失败且身体没有位移，先挖开安全出口",
        );
      }
      if (
        context.lastFailure === null &&
        context.consecutiveFailures < 1
      ) {
        return cardEvaluation(recoveryReobserveCard, "blocked", "当前没有失败需要换区");
      }
      if ((context.facts.health ?? 20) <= strategy.retreatHealth) {
        return cardEvaluation(
          recoveryReobserveCard,
          "blocked",
          "血量过低，先原地恢复或找食物，不要远行观察",
        );
      }
      /*
       * Re-observe is a local recovery, not a migration. The live run chained
       * partial explore routes west along a beach until the body was ninety
       * blocks from its chest, with no food and no mine. When the camp is
       * remembered and the body has drifted far from it, walking home is the
       * only useful "new observation area".
       */
      const home = homeAnchor(context.facts);
      const position = context.facts.position;
      if (
        home !== null &&
        position !== null &&
        position !== undefined &&
        Math.hypot(position.x - home.x, position.z - home.z) > 64
      ) {
        const homeward = gotoHomeTask(
          context.stage,
          context.facts,
          context.newId,
          { title: "离家太远，先回营地重新观察" },
        );
        if (homeward !== null) {
          return cardEvaluation(
            recoveryReobserveCard,
            "available",
            homeward.title,
            homeward,
          );
        }
      }
      const task = explore(
        context.facts,
        context.stage,
        "换一片区域重新观察",
        "资源",
        1,
        context.newId,
        16,
        Math.min(48, Math.max(24, strategy.exploreRadius)),
      );
      return cardEvaluation(recoveryReobserveCard, "available", task.title, task);
    },
  };

  const recoveryEscapeCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "recovery.escape",
    title: "封闭空间内卡死后恢复",
    group: "recovery",
    stage: "any",
    priority: 95,
    risk: "high",
    critical: true,
    minDwellMs: 0,
    expectedEvidence: ["离开封闭坑或竖井", "重新获得安全可行走路线"],
    recovery: ["recovery.reobserve", "mine.surface"],
    stopConditions: ["身体回到开放空间", "恢复预算用尽"],
    evaluate: (context) => {
      const enclosedFailure =
        context.lastFailure !== null &&
        /E_ENCLOSED/u.test(context.lastFailure);
      // `E_ENCLOSED` is emitted by the body only after it checked the roof
      // and wall geometry. That evidence is enough on its own: a roofed
      // surface hut can be only two blocks deep, so the older `enclosed`
      // snapshot (a deep vertical shaft) stays false even though walk has no
      // exit. A plain `E_STUCK` still needs the snapshot to confirm that the
      // body really is in a one-block shaft.
      const stuckInShaft =
        context.lastFailure !== null &&
        /E_STUCK/u.test(context.lastFailure) &&
        context.facts.enclosed === true;
      const boxedIn = boxedInByTerrain(context);
      // A body that stays below the surface through six consecutive planning
      // failures is not making progress on the current task. Give the escape
      // card a chance even when the latest failure was a timeout from some
      // other card; otherwise a wood or ore retry can own the body forever.
      const persistentStuck =
        context.consecutiveFailures >= 6 &&
        isUnderground(context.facts) &&
        hasUsablePickaxe(context.facts, 2);
      /*
       * A recovery leg has a hard body deadline. The first leg can time out
       * after opening only a few blocks, and the interruption is not proof
       * that the pocket disappeared. Keep the same card in charge until the
       * body actually has ordinary walk routes again.
       */
      const continuingRecovery =
        context.lastStrategy?.includes("recovery.escape") === true &&
        context.lastFailure !== null &&
        /E_TIMEOUT/u.test(context.lastFailure) &&
        hasUsablePickaxe(context.facts, 2);
      if (
        !enclosedFailure &&
        !stuckInShaft &&
        !boxedIn &&
        !continuingRecovery &&
        !persistentStuck
      ) {
        return cardEvaluation(
          recoveryEscapeCard,
          "blocked",
          "当前没有封闭空间内的卡死失败",
        );
      }
      const position = context.facts.position;
      if (position === null || position === undefined) {
        return cardEvaluation(recoveryEscapeCard, "blocked", "身体位置尚未观测");
      }
      const target = {
        x: position.x,
        y: Math.min(
          context.facts.surfaceY ?? position.y + 12,
          position.y + 12,
        ),
        z: position.z,
      };
      /*
       * `recover` may build a bounded pillar, which is correct for a real
       * one-block shaft. A three-walled pocket beside water is not a shaft:
       * stacking up here would recreate the sky-pillar bug. Use `dig`, which
       * may mine a staircase or a horizontal corridor but cannot place a
       * block, and aim it at the body's current heading so the first
       * reachable wall becomes the exit.
       */
      const heading =
        typeof context.facts.yaw === "number" &&
        Number.isFinite(context.facts.yaw)
          ? context.facts.yaw
          : typeof context.facts.cameraYaw === "number" &&
              Number.isFinite(context.facts.cameraYaw)
            ? context.facts.cameraYaw
            : 0;
      const radians = ((heading + 90) * Math.PI) / 180;
      const digTarget = {
        x: Math.round((position.x + Math.cos(radians) * 8) * 10) / 10,
        y: position.y,
        z: Math.round((position.z + Math.sin(radians) * 8) * 10) / 10,
      };
      const mode = enclosedFailure || stuckInShaft ? "recover" : "dig";
      const skillTarget = mode === "recover" ? target : digTarget;
      return cardEvaluation(
        recoveryEscapeCard,
        "available",
        mode === "recover"
          ? "普通行走已确认卡死；只在当前封闭空间启动恢复"
          : "连续寻路失败且没有位移；只挖开出口，不搭柱也不搭桥",
        {
          id: `task:${context.newId()}`,
          stage: context.stage,
          kind: "navigate",
          title: "从封闭空间恢复并回到地表",
          critical: true,
          skill: {
            name: "goto",
            args: { target: skillTarget, acceptPartial: false, mode },
            idempotencyKey: context.newId(),
          },
          preconditions: [
            "ordinary walk returned E_ENCLOSED, E_STUCK or repeated E_UNREACHABLE",
            "the body has a pickaxe and a real wall or shaft to mine",
          ],
          expectedEvidence: ["the body leaves the enclosed pocket"],
          verify: () => true,
        },
      );
    },
  };

  const foodHuntCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "food.hunt",
    title: "补食物：打猎或收集掉落",
    group: "food",
    stage: "food",
    priority: 70,
    risk: "medium",
    critical: false,
    minDwellMs: 15_000,
    expectedEvidence: ["获得食物物品", "饥饿值恢复或储备增加"],
    recovery: ["food.forage", "explore.surface"],
    stopConditions: ["食物储备达到目标", "当前不饿且附近没有动物"],
    evaluate: (context) => {
      const starving = (context.facts.food ?? 20) <= 6;
      const emergencyFoodSearch =
        isHurt(context.facts, strategy) && foodCount(context.facts) === 0;
      if (
        pastNightReturn(context.facts, strategy) &&
        !starving &&
        !emergencyFoodSearch
      ) {
        return cardEvaluation(
          foodHuntCard,
          "blocked",
          "天黑后不外出打猎，夜间挖矿或整理物资",
        );
      }
      const animals = (context.facts.entities ?? []).some(
        (entity) => entity.distance <= 24 && /sheep|cow|pig|chicken|rabbit|fish|salmon|cod/i.test(entity.type),
      );
      if (
        !hungryForStrategy(context.facts, strategy) &&
        foodCount(context.facts) >= strategy.foodReserve
      ) {
        return cardEvaluation(foodHuntCard, "blocked", "食物储备充足");
      }
      if (!animals) {
        /*
         * An emergency body cannot wait for a passive mob to wander into the
         * same 24-block window it has already scanned. Oak leaves are a 0.5%
         * apple roll, and the live run swept thirty-two leaves three times in
         * a row without recovering a single hunger point. Walk a bounded
         * observation leg instead; it is the action that can actually create
         * a hunt target.
         */
        if (emergencyFoodSearch) {
          const task = explore(
            context.facts,
            "food",
            "寻找可猎取的动物",
            "动物",
            2,
            context.newId,
            24,
            36,
            true,
          );
          return task === null
            ? cardEvaluation(foodHuntCard, "blocked", "附近没有可探索的猎场")
            : cardEvaluation(foodHuntCard, "available", task.title, task);
        }
        return cardEvaluation(foodHuntCard, "blocked", "当前视野没有可猎取的动物");
      }
      return fromStage(
        foodHuntCard,
        context,
        "food",
        (task) =>
          task.stage === "food" &&
          (task.skill.name === "attack" || task.skill.name === "collect_items" || task.skill.name === "goto"),
        false,
        {
          scopes: ["full", "stage"],
          blockedReason: "当前视野没有可猎取的动物",
        },
      );
    },
  };

  const foodForageCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "food.forage",
    title: "补食物：捡掉落或找苹果",
    group: "food",
    stage: "food",
    priority: 68,
    risk: "low",
    critical: false,
    minDwellMs: 15_000,
    expectedEvidence: ["食物进入背包", "饥饿值恢复或储备增加"],
    recovery: ["food.hunt", "explore.surface"],
    stopConditions: ["食物储备达到目标", "当前不饿"],
    evaluate: (context) => {
      const starving = (context.facts.food ?? 20) <= 6;
      /*
       * A hurt body with nothing edible cannot wait for sunrise. The live
       * night run stood at camp with health 6 and food 12: every card was
       * blocked by either "night" or "no food" and it made no progress until
       * it died. An empty reserve plus a health emergency is a stronger
       * reason than the ordinary night curfew.
       */
      const urgentFoodSearch =
        isHurt(context.facts, strategy) && foodCount(context.facts) === 0;
      if (
        pastNightReturn(context.facts, strategy) &&
        !starving &&
        !urgentFoodSearch
      ) {
        return cardEvaluation(
          foodForageCard,
          "blocked",
          "天黑后不外出觅食，夜间挖矿或整理物资",
        );
      }
      /*
       * Oak leaves drop apples at 0.5%, so a full canopy sweep is a poor use
       * of daylight when hunger is still workable. The live run broke more
       * than a hundred leaves at food 10 while two raw iron waited for a
       * furnace. Forage is the emergency fallback, not the reserve builder:
       * at 12–16 the body should eat if it can, otherwise keep progressing
       * and come back when hunger actually reaches the urgent line.
       */
      /*
       * A hurt body with nothing edible cannot wait for hunger to fall to 8.
       * At food 14 and health 6 the live planner reported every card blocked
       * and stood at camp until it died. Foraging is the only food source
       * that exists next to that camp, so a missing reserve plus a health
       * emergency is itself an urgent reason to look for apples.
       */
      if (
        (context.facts.food ?? 20) > 8 &&
        foodCount(context.facts) < strategy.foodReserve &&
        !urgentFoodSearch
      ) {
        return cardEvaluation(
          foodForageCard,
          "blocked",
          "饥饿尚可，先推进当前目标；低于 8 再觅食",
        );
      }
      if (
        !hungryForStrategy(context.facts, strategy) &&
        foodCount(context.facts) >= strategy.foodReserve
      ) {
        return cardEvaluation(foodForageCard, "blocked", "食物储备充足");
      }
      return fromStage(
        foodForageCard,
        context,
        "food",
        (task) =>
          task.stage === "food" &&
          (task.skill.name === "mine_block" ||
            task.skill.name === "collect_items" ||
            task.skill.name === "chop_tree" ||
            task.skill.name === "goto") &&
          /苹果|树叶|橡树|掉落|食物|捡起|猎取|动物|接近地表|返回地面/u.test(
            task.title,
          ),
        false,
        {
          scopes: ["full", "stage"],
          blockedReason: "附近没有可采集的食物，先换区域寻找",
        },
      );
    },
  };

  const combatEngageCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "combat.engage",
    title: "装备允许时清理近身威胁",
    group: "combat",
    stage: "any",
    priority: 66,
    risk: "medium",
    critical: false,
    minDwellMs: 10_000,
    expectedEvidence: ["目标失去生命或死亡", "威胁离开交互范围"],
    recovery: ["safety.retreat", "recovery.reobserve"],
    stopConditions: ["威胁清除", "血量降到撤退线"],
    evaluate: (context) => {
      if (!threatNearby(context.facts)) {
        return cardEvaluation(combatEngageCard, "blocked", "当前没有近身威胁");
      }
      if ((context.facts.health ?? 20) < strategy.engageHealth || !hasWeapon(context.facts)) {
        return cardEvaluation(combatEngageCard, "blocked", "血量或武器不足以主动交战");
      }
      const task = combatTask(context);
      return task === null
        ? cardEvaluation(combatEngageCard, "blocked", "威胁已离开交互范围")
        : cardEvaluation(combatEngageCard, "available", task.title, task);
    },
  };

  const homeBedCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "home.bed",
    title: "做床并睡觉",
    group: "home",
    stage: "shelter",
    priority: 58,
    risk: "low",
    critical: false,
    minDwellMs: 30_000,
    expectedEvidence: ["床被放置", "睡眠跨夜确认"],
    recovery: ["safety.night_home", "home.store"],
    stopConditions: ["床已放置并完成睡眠", "没有羊毛且夜间已到"],
    evaluate: (context) => {
      if (context.facts.sleptThroughNight === true) {
        return cardEvaluation(homeBedCard, "done", "已经完成一次跨夜睡眠");
      }
      if (isNight(context.facts) === true && !hasBedAccess(context.facts)) {
        return cardEvaluation(
          homeBedCard,
          "blocked",
          "夜间无床，先做地下工作或整理物资，天亮再找羊毛",
        );
      }
      return fromStage(
        homeBedCard,
        context,
        "shelter",
        (task) => task.stage === "shelter" && /床|睡觉/u.test(task.title),
      );
    },
  };

  const homeStoreCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "home.store",
    title: "回家整理箱子与背包",
    group: "home",
    stage: "shelter",
    priority: 56,
    risk: "low",
    critical: false,
    minDwellMs: 20_000,
    expectedEvidence: ["物资进入箱子", "背包空出格子"],
    recovery: ["recovery.unload", "home.store"],
    stopConditions: ["背包不再拥挤", "箱子已满"],
    evaluate: (context) => {
      if (!isFull(context.facts, strategy) && usedSlots(context.facts) < 20) {
        return cardEvaluation(homeStoreCard, "blocked", "当前没有整理背包的必要");
      }
      return fromStage(
        homeStoreCard,
        context,
        "shelter",
        (task) => task.stage === "shelter" && /箱子|存放|储物|背包/u.test(task.title),
      );
    },
  };

  const mineOreCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "mine.ore",
    title: "眼前有铁矿就先挖",
    group: "mine",
    stage: "iron",
    priority: 55,
    risk: "medium",
    critical: false,
    minDwellMs: 0,
    expectedEvidence: ["铁矿石方块变为空气", "粗铁进入背包"],
    recovery: ["mine.surface", "craft.smelt"],
    stopConditions: ["眼前铁矿挖完", "背包接近满"],
    evaluate: (context) => {
      const ore = (context.facts.nearbyBlocks ?? []).find(
        (block) => IRON_ORE.test(block.id) && (block.distance ?? 99) <= 24,
      );
      if (ore === undefined) {
        return cardEvaluation(mineOreCard, "blocked", "视野内没有可及铁矿");
      }
      return fromStage(
        mineOreCard,
        context,
        "iron",
        (task) =>
          task.skill.name === "mine_block" &&
          IRON_ORE.test(String(task.skill.args["block"] ?? "")),
        false,
        { scopes: ["stage"], blockedReason: "视野内没有可采铁矿" },
      );
    },
  };

  const mineSurfaceCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "mine.surface",
    title: "该回地表时沿阶梯上升",
    group: "mine",
    stage: "any",
    priority: 54,
    risk: "medium",
    critical: false,
    minDwellMs: 0,
    expectedEvidence: ["身体上升并回到地表", "获得新的地表观察"],
    recovery: ["recovery.reobserve", "home.store"],
    stopConditions: ["已在地表", "发现更安全的营地"],
    evaluate: (context) => {
      if (!isUnderground(context.facts)) {
        return cardEvaluation(mineSurfaceCard, "blocked", "身体不在地下");
      }
      if (!hasUsablePickaxe(context.facts)) {
        return cardEvaluation(
          mineSurfaceCard,
          "blocked",
          "没有可用镐，先修工具再挖回地表",
        );
      }
      /*
       * The body keeps the last failed ledge in its own route cache and will
       * reject the same drop in the next tick. Re-issuing `mine.surface`
       * immediately therefore looks like progress while producing two
       * identical E_STUCK results. Let a recovery card change the approach
       * first; the surface card can return once the route cache or position
       * changes.
       */
      if (
        context.lastStrategy?.includes("mine.surface") === true &&
        context.lastFailure !== null &&
        /E_STUCK|E_UNREACHABLE|E_ENCLOSED|ledge/u.test(context.lastFailure)
      ) {
        return cardEvaluation(
          mineSurfaceCard,
          "blocked",
          "上次挖回地表没有路线，先换区域或恢复",
        );
      }
      /*
       * This must not depend on the mainline task. The iron stage can be
       * blocked by an old mine entrance, hunger or a full backpack while the
       * body is still standing in a shallow hole; in that state the only
       * correct move is a short dig back to the current column's surface.
       * `returnToSurfaceTask` starts from the body's own x/z and never pillars.
       */
      const task = returnToSurfaceTask(
        context.stage,
        context.facts,
        context.newId,
      );
      return task === null
        ? cardEvaluation(
            mineSurfaceCard,
            "blocked",
            "当前地表高度未知，无法规划回地表阶梯",
          )
        : cardEvaluation(mineSurfaceCard, "available", task.title, task);
    },
  };

  const mineDescendCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "mine.descend",
    title: "评估装备后下矿",
    group: "mine",
    stage: "iron",
    priority: 50,
    risk: "high",
    critical: false,
    minDwellMs: 30_000,
    expectedEvidence: ["矿石进入背包", "矿道或地表出口可复用"],
    recovery: ["mine.surface", "recovery.reobserve"],
    stopConditions: ["矿物目标达成", "食物/空格/工具不足"],
    evaluate: (context) => {
      const food = foodCount(context.facts);
      const hunger = context.facts.food ?? 20;
      /*
       * Carried food and the hunger bar are two forms of the same reserve.
       * Requiring three items deadlocked a body at 20/20 with an empty pack:
       * it refused to mine because it had no food, and it could not hunt at
       * night because hunting is a daytime card. A full bar is enough to
       * start a descent; the existing mining-return task still climbs out at
       * hunger 10 before the reserve is spent.
       */
      const foodReady = food >= strategy.miningFood || hunger >= 17;
      const exits =
        context.facts.mineEntrance !== null &&
        context.facts.mineEntrance !== undefined
          ? 1
          : context.memory.filter(
              (entry) =>
                entry.kind === "mine" &&
                memorySatisfiesPrecondition(entry, context.now),
            ).length;
      const ready =
        hasUsablePickaxe(context.facts, 2) &&
        foodReady &&
        buildingBlockCount(context.facts) >= strategy.miningBlocks &&
        usedSlots(context.facts) <= 36 - strategy.miningEmptySlots &&
        exits > 0;
      if (!ready) {
        return cardEvaluation(
          mineDescendCard,
          "blocked",
          !hasUsablePickaxe(context.facts, 2)
            ? "需要石镐或更好的镐"
            : !foodReady
              ? `食物不足（需要 ${strategy.miningFood} 份或饥饿值 ≥ 17）`
              : buildingBlockCount(context.facts) < strategy.miningBlocks
                ? `方块不足（需要 ${strategy.miningBlocks} 个）`
              : usedSlots(context.facts) > 36 - strategy.miningEmptySlots
                ? "背包空间不足"
                : "还没有记录安全出口",
        );
      }
      return fromStage(
        mineDescendCard,
        context,
        // The same descent builder also owns deepslate diamond trips at the
        // nether stage. Hard-coding "iron" made the card compile an iron
        // staircase forever after the body finished its iron gear.
        context.stage,
        (task) =>
          task.skill.name === "mine_block" ||
          task.skill.name === "goto" ||
          task.skill.name === "pillar_up",
        false,
        { scopes: ["stage"] },
      );
    },
  };

  const craftSmeltCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "craft.smelt",
    title: "熔炼矿石补铁器",
    group: "craft",
    stage: "iron",
    priority: 48,
    risk: "low",
    critical: false,
    minDwellMs: 20_000,
    expectedEvidence: ["产物进入背包", "熔炉燃料消耗"],
    recovery: ["mine.descend", "craft.upgrade"],
    stopConditions: ["铁锭达到目标", "缺少燃料或熔炉"],
    evaluate: (context) =>
      fromStage(
        craftSmeltCard,
        context,
        "iron",
        (task) => task.skill.name === "smelt",
        false,
        {
          scopes: ["full", "stage"],
          blockedReason: "当前没有可熔炼的矿石、燃料或熔炉",
        },
      ),
  };

  const craftUpgradeCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "craft.upgrade",
    title: "用现有材料升级工具",
    group: "craft",
    stage: "any",
    priority: 46,
    risk: "low",
    critical: false,
    minDwellMs: 15_000,
    expectedEvidence: ["新工具进入背包或装备栏", "旧工具被替换"],
    recovery: ["mine.descend", "recovery.tool"],
    stopConditions: ["当前阶段工具已达目标", "材料不足"],
    evaluate: (context) =>
      fromStage(
        craftUpgradeCard,
        context,
        context.stage,
        (task) =>
          task.skill.name === "craft" &&
          /镐|剑|工具|斧|铲/u.test(task.title),
        false,
        {
          scopes: ["full", "stage"],
          blockedReason: "当前没有可直接升级的工具材料",
        },
      ),
  };

  const nightWorkCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "night.work",
    title: "没床的夜里继续经营",
    group: "progress",
    stage: "any",
    priority: 44,
    risk: "medium",
    critical: false,
    minDwellMs: 30_000,
    expectedEvidence: ["完成一次挖掘、制作或熔炼", "物资或工具发生变化"],
    recovery: ["safety.night_home", "mine.surface", "recovery.reobserve"],
    stopConditions: ["天亮", "有床可睡", "健康或食物不足"],
    evaluate: (context) => {
      if (context.facts.sleeping === true) {
        return cardEvaluation(nightWorkCard, "done", "已经入睡");
      }
      if (isNight(context.facts) !== true) {
        return cardEvaluation(nightWorkCard, "blocked", "还没到夜间工作时段");
      }
      if (hasBedAccess(context.facts)) {
        return cardEvaluation(nightWorkCard, "blocked", "有床可睡，先回家睡觉");
      }
      if ((context.facts.health ?? 20) < 10) {
        return cardEvaluation(nightWorkCard, "blocked", "血量过低，先恢复");
      }
      const task = nightWorkTask(context.stage, context.facts, context.newId);
      if (task === null) {
        return cardEvaluation(nightWorkCard, "done", "当前没有夜间工作");
      }
      return taskResult(nightWorkCard, task, () => true, true);
    },
  };

  const stockpileWoodCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "stockpile.wood",
    title: "木材储备低于安全线就补",
    group: "explore",
    stage: "wood-and-table",
    priority: 30,
    risk: "low",
    critical: false,
    minDwellMs: 15_000,
    expectedEvidence: ["原木进入背包", "木材储备达到目标"],
    recovery: ["explore.surface"],
    stopConditions: ["木材储备达到 8 根", "视野没有树"],
    evaluate: (context) => {
      if (isUnderground(context.facts)) {
        return cardEvaluation(
          stockpileWoodCard,
          "blocked",
          "身体在地下，先返回地表再补木材",
        );
      }
      if (pastNightReturn(context.facts, strategy)) {
        return cardEvaluation(
          stockpileWoodCard,
          "blocked",
          "天黑后不外出砍树，夜间挖矿或整理物资",
        );
      }
      if (logCount(context.facts) >= 8) {
        return cardEvaluation(stockpileWoodCard, "done", "木材储备已足够");
      }
      const task = woodGatherTask(
        context.facts,
        context.stage,
        "补充原木储备",
        context.newId,
        2,
      );
      return task === null
        ? cardEvaluation(stockpileWoodCard, "blocked", "视野内没有可接近的树")
        : cardEvaluation(stockpileWoodCard, "available", task.title, task);
    },
  };

  const exploreSurfaceCard: PlaybookCard = {
    ...makeCard({} as never),
    id: "explore.surface",
    title: "安全时主动探索新区域",
    group: "explore",
    stage: "any",
    priority: 20,
    risk: "medium",
    critical: false,
    minDwellMs: 30_000,
    expectedEvidence: ["到达新的观察区域", "发现资源、动物或结构"],
    recovery: ["mine.surface", "recovery.reobserve"],
    stopConditions: ["发现有价值目标", "天黑或食物不足"],
    evaluate: (context) => {
      if (
        isDay(context.facts) === false ||
        pastNightReturn(context.facts, strategy)
      ) {
        return cardEvaluation(
          exploreSurfaceCard,
          "blocked",
          "天黑后不主动远行，夜间做地下工作或睡觉",
        );
      }
      if (
        (context.facts.health ?? 20) < strategy.engageHealth ||
        hungryForStrategy(context.facts, strategy)
      ) {
        return cardEvaluation(exploreSurfaceCard, "blocked", "血量或饥饿不适合远行");
      }
      /*
       * Exploration pays for itself only while the body can return to its
       * chest, furnace and mine. The live beach run kept picking a fresh
       * 24–48 block ring and drifted ninety blocks from camp with two raw
       * iron still unsmelted. Treat the camp as a leash: beyond half the
       * configured explore radius, the next useful "new area" is home.
       */
      const home = homeAnchor(context.facts);
      const position = context.facts.position;
      const leash = Math.max(48, strategy.exploreRadius / 2);
      if (
        home !== null &&
        position !== null &&
        position !== undefined &&
        Math.hypot(position.x - home.x, position.z - home.z) > leash
      ) {
        const homeward = gotoHomeTask(
          context.stage,
          context.facts,
          context.newId,
          { title: "离营地太远，先回去补给" },
        );
        if (homeward !== null) {
          return cardEvaluation(
            exploreSurfaceCard,
            "available",
            homeward.title,
            homeward,
          );
        }
      }
      const task = explore(
        context.facts,
        context.stage,
        "主动探索地图并寻找资源",
        "资源",
        1,
        context.newId,
        24,
        Math.min(48, Math.max(24, strategy.exploreRadius)),
      );
      return cardEvaluation(exploreSurfaceCard, "available", task.title, task);
    },
  };

  const cards = [
    safetyRetreatCard,
    safetyEatCard,
    safetyNightHomeCard,
    recoveryToolCard,
    recoveryUnloadCard,
    recoveryEscapeCard,
    recoveryReobserveCard,
    foodHuntCard,
    foodForageCard,
    combatEngageCard,
    homeBedCard,
    homeStoreCard,
    mineOreCard,
    mineSurfaceCard,
    mineDescendCard,
    craftSmeltCard,
    craftUpgradeCard,
    nightWorkCard,
    stockpileWoodCard,
    exploreSurfaceCard,
  ];
  return cards.map((card) =>
    card.critical
      ? card
      : { ...card, minDwellMs: Math.max(card.minDwellMs, strategy.cardMinDwellMs) },
  );
}

/** Used by tests and the 4h soak report to keep the catalog visibly complete. */
export const PLAYBOOK_CARD_IDS = [
  "safety.eat",
  "safety.retreat",
  "safety.night_home",
  "recovery.reobserve",
  "recovery.tool",
  "recovery.unload",
  "recovery.escape",
  "food.hunt",
  "food.forage",
  "home.bed",
  "home.store",
  "mine.ore",
  "mine.descend",
  "mine.surface",
  "craft.upgrade",
  "craft.smelt",
  "night.work",
  "explore.surface",
  "stockpile.wood",
  "combat.engage",
] as const;
