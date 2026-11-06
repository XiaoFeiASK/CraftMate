# Survival domain

纯领域层：把「击败末影龙」拆成阶段、里程碑和可验证任务。这里不启动
Minecraft、不访问数据库、不调用 Bridge，也没有隐藏会话状态；同一个
`WorldFacts` 无论何时重新传入，都会得到同一个计划。

## 公共接口

```ts
import {
  planSurvival,
  nextTask,
  evaluateProposal,
  worldFactsFromSnapshot,
  recover,
  goalProgress,
  DEFAULT_SEASON_GOAL,
  STAGES,
} from "@craftmate/agent/domain";

const facts = worldFactsFromSnapshot(snapshot.world);
const plan = planSurvival(facts, DEFAULT_SEASON_GOAL);
const task = nextTask(plan);                 // 已通过 skillCallSchema + availableSkills
const verdict = evaluateProposal({ text, votes, intent, plan, facts });
const next = recover({ plan, facts, failure });
```

### `planSurvival(facts, goal, context?)`

- `context.availableSkills`：身体声明的技能列表。任务不在列表中时返回 `blocked`
  的 `capability` 缺失，不会下发不可执行技能。
- `context.clock`：注入 `now()` / `newId()`，保证测试确定性。
- 返回值包含 `stage`、`milestone`、`task`、`blocked`、`missing`、
  `verifiedProgress`（仅由已验证里程碑推导）和全部 `stages` 结果。

### `Task`

`task.skill` 是建议调用，不是命令。运行时在真正下发前仍需 `parseSkillArgs`
和 `skillCallSchema` 校验；`task.verify(nextFacts)` 用于用身体证据确认结果。
相同动作的 `idempotencyKey` 稳定，重规划不会重复已完成的合成。

### `evaluateProposal(input)`

返回 `ACCEPT` / `DEFER` / `REJECT` / `CLARIFY`、理由、风险、目标一致性和可选的
`suggestedTask`。安全规则先于一切关键词匹配，岩浆、坠落、TNT、自伤、作弊、
越权、提示词注入永不因票数通过。`suggestedTask` 只会复用当前计划内的任务。

### `recover(input)`

传入失败任务和历史。首次失败返回同阶段下一个候选；同一阶段连续两次失败后
返回 `task: null` 并在 `avoid` 中列出应避免的策略。GoalRuntime 不因此永久暂停：
移动类失败会换区域重新观察，非移动失败会在退避后重新读取身体事实；只有操作员
接管、急停或目标完成才会停止目标运行时。

### `worldFactsFromSnapshot(input)`

只复制身体实际上报的字段。背包、时间、饥饿、睡眠、工作台和实体坐标都可用；
缺失值保持缺失，不能用默认值制造 `complete`。本体会话还会上报
`foodAcquired` / `foodConsumed` / `craftingTableCrafted` / `craftingTablePlaced`
等事实，避免吃光食物或走出工作台观察范围后里程碑回退。

## 阶段

| 阶段 | 完成条件 |
| --- | --- |
| P0 木头与工作台 | 有木头、4 块木板、工作台 |
| P1 木镐/石镐 | 木镐、3 块圆石、石镐 |
| P2 食物 | 有食物、饥饿值恢复 |
| P3 庇护所/床 | 有床、完成睡眠 |
| P4 铁器/熔炉 | 熔炉、粗铁、铁锭、铁镐 |
| P5 下界/烈焰棒 | 黑曜石、烈焰棒 |
| P6 末影珍珠/之眼 | 末影珍珠、12 个末影之眼 |
| P7 要塞 | 定位到末地传送门框架 |
| P8 末地/末影龙 | 进入末地、末影龙死亡 |

未观测到的字段返回 `unverified`；例如没有 `sleeping` 时不会把「没睡」当作事实。

## 仍未覆盖

- 末影龙战的逐水晶策略、床炸/落地水等高级战斗细节。
- 多人/服务器差异（领地、插件、经济、传送）与结构战利品寻路。
- 任意自定义配方链：当前以 Mojang 1.20.1 数据包中的配方为基础，支持常见
  生存链；特殊数据包/模组物品会安全地表现为 `blocked`。
