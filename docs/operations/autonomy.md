# 自主生存闭环

> 本文说明目标模式如何持续决策、Agent 与 Fabric 身体各自负责什么，以及为什么
> “角色在动”不等于“模型在扣费”。协议字段见 [Bridge 设计](../reference/bridge.md)，
> 阶段定义见 [技术设计](../reference/technical-design.md)。

最后核对：2026-11-06，Minecraft Java 1.20.1。

## 1. 两种输入，两条决策路径

CraftMate 同时支持观众驱动和目标驱动，但两者不会混用同一个决策器：

| 路径 | 输入 | 决策方式 | 是否调用大模型 |
| --- | --- | --- | --- |
| 观众驱动 | 评论、礼物、操作员耳语 | Stage A/B 仲裁，胜出意图进入 Stage C | 可能，取决于意图与预算 |
| 目标驱动 | 操作员开启目标模式 | `GoalRuntime` + 确定性 `SurvivalGoalPlanner` | 否 |

目标模式当前不把世界快照发给大模型，也不依赖模型返回下一步技能。它从身体上报的
事实计算阶段、里程碑和单个可验证任务，再把任务交给 Bridge。这样即使模型供应商
超时或返回 5xx，角色仍能继续砍树、挖矿、战斗和移动。

“Agent 层在执行”可以通过三个事实确认：

- `goal_runtime.enabled = 1`，且 `goal_json.status = active`；
- `decision_log` 持续出现 `goal:<goalId>:<version>:<uuid>` 的幂等键和技能；
- 客户端日志出现 `[CraftMate] goto start ...`、`[CraftMate] goto · <id>` 等
  由 Agent 下发的任务日志。

只有 `idle action=...` 才表示身体在等待 Agent 指令时的空闲游走，不是目标规划器
下达的任务。

## 2. 持续闭环

```text
身体快照
  -> worldFactsFromSnapshot（只保留已观测事实）
  -> planSurvival（阶段、里程碑、下一任务）
  -> GoalRuntime（退避、失败历史、接管与终态）
  -> Bridge（能力校验、队列、超时）
  -> Fabric Mod（A*、视角、挖掘、放置、战斗）
  -> result/changes（世界证据）
  -> GoalRuntime.settle（成功或失败）
  -> 重新观察并规划
```

关键约束：

- 一次最多只有一个在途目标命令；收到终态后才重新规划。
- 技能必须同时通过契约校验和身体能力白名单。
- 完成结果必须带已确认变化；空结果或只有 `unconfirmed` 不推进里程碑。
- 同一移动策略连续失败后，规划器会换一片区域重新观察，而不是原地循环。
- 达到失败上限不会永久 `blocked`，而是进入最长 6 秒退避并继续尝试；身体在退避
  期间由空闲游走保持自然动作。
- 接管、急停、目标切换会取消当前目标命令，并保持控制权归属。

## 3. 生存阶段

当前默认目标是“击败末影龙”，DAG 共九个阶段：

1. 木头与工作台
2. 木镐与石镐
3. 食物
4. 庇护所与床
5. 铁器与熔炉
6. 下界与烈焰棒
7. 末影珍珠与末影之眼
8. 要塞
9. 末地传送门与末影龙

每个阶段由身体事实判定 `complete`、`incomplete` 或 `unverified`。后台不会用固定
百分比伪造进度；没有观测字段时保持 `unverified`。

截至 2026-11-06，已在真实 1.20.1 存档验证的阶段能力覆盖木头、石具、觅食和移动；
床、熔炉、铁器、下界、要塞、末地与击杀末影龙的完整链路仍未验收。

## 4. Agent 与 Mod 的分工

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Agent / GoalRuntime | 读取快照、选阶段、选任务、失败恢复、幂等键、终态判定 | 直接改 Minecraft 世界 |
| Bridge | 能力协商、命令队列、控制权、超时、终态回传 | 选择生存目标或路线语义 |
| Fabric Mod | tick 内执行技能、局部寻路、视角限速、挖掘/放置/攻击确认 | 调用大模型、决定观众意图 |

Mod 内的低层自治只服务于“把 Agent 的技能做得像人”，不会替代阶段规划：

- `BoundedPathfinder`：有界 A*，只走可站立、无液体、无碰撞格子；失败返回部分
  路径和真实原因。
- `ViewSlew` / `CameraController`：最短弧转向、角速度上限、平滑镜头；交互瞄准仍
  使用真实命中射线。
- `StairEscape` / `CanopyEscape` / `ShaftEscape`：卡在坑、树冠或竖井时先寻找
  可挖掘的楼梯/下降路径，必要时垫方块，不凭空瞬移。
- 自动垫桥：验证支撑面、目标格和材料后逐块放置，确认后再前进。
- `IdleWander`：仅在无命令且 Agent 持有控制权时随机观察、短距离行走、捡附近
  掉落物；真实命令到达会立即重置。
- `Reflexes`：岩浆、低血、坠落、溺水、着火、饥饿、近身威胁和来箭先松手/闪避；
  后续战斗或撤退仍由 Agent 规划。

## 5. 为什么 API 额度可能长期不变

目标模式是确定性规划器，正常情况下不会产生模型请求。模型成本账本只在实际调用
成功后记账；没有调用就没有新增 `model_cost` 行。

检查顺序：

```bash
sqlite3 "$HOME/.craftmate/craftmate.db" \
  "select datetime(occurred_at_ms/1000,'unixepoch','localtime'), provider, model,
          cost, prompt_tokens, completion_tokens
     from model_cost order by occurred_at_ms desc limit 10;"
```

如果目标模式正在运行、`model_cost` 没有新行，且日志没有 Stage C 请求，额度不变
是预期行为，不是账本坏了。若观众评论应触发模型但供应商返回 `502`，同样不会产生
费用；应先检查供应商端点与模型名，而不是只刷新余额页面。

从迁移 `0012_model_usage.sql` 起，即使没有配置每百万 token 单价，成功请求也会以
`cost = 0` 记录 `prompt_tokens` / `completion_tokens`，便于区分“没有调用”和
“调用了但本地价格为零”。

## 6. 现场排查

| 现象 | 先看什么 | 结论 |
| --- | --- | --- |
| 角色随机看/走 | 客户端 `idle action=...` | 没有 Agent 任务，Mod 空闲游走 |
| 有目标但短时不动 | `nextTask`、`retryAt`、`consecutiveFailures` | 退避或等待身体终态 |
| 一直重复同一路径 | `decision_log` 与 `goto start/escape` | 检查失败策略、地形和重规划日志 |
| 模型额度不变 | `model_cost`、供应商错误 | 目标模式不调用模型，或请求失败 |
| 看到动作但没有进度 | skill `changes` / `unconfirmed` | 身体未确认世界变化，不得算成功 |

常用 SQL：

```bash
sqlite3 -header -column "$HOME/.craftmate/craftmate.db" \
  "select goal_json, enabled, progress_json
     from goal_runtime;"

sqlite3 -header -column "$HOME/.craftmate/craftmate.db" \
  "select datetime(created_at_ms/1000,'unixepoch','localtime') as at,
          intent, status, skill_json, outcome_json
     from decision_log order by created_at_ms desc limit 20;"
```

客户端日志默认在 Minecraft 实例的 `logs/latest.log`；Bridge 与编排器日志以
`npm run dev:orchestrator` 的终端输出为准。

## 7. 当前边界

- 还未完成从空手到击杀末影龙的真实存档全链路。
- 末影水晶、床炸、落地水、要塞搜索和末地地形尚未进入稳定技能闭环。
- 空闲游走不会挖矿、开箱或主动建设，它只避免角色像冻结一样站着。
- 真实直播、语音路由和模型供应商稳定性仍按各自验收文档处理。
