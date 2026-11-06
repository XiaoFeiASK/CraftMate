# 自主生存闭环

> 本文说明目标模式如何持续决策、Agent 与 Fabric 身体各自负责什么，以及模型安全
> 边界和成本排查。协议字段见 [Bridge 设计](../reference/bridge.md)，
> 阶段定义见 [技术设计](../reference/technical-design.md)。

最后核对：2026-11-06，Minecraft Java 1.20.1。

## 1. 两种输入，两条决策路径

CraftMate 同时支持观众驱动和目标驱动，但两者不会混用同一个决策器：

| 路径 | 输入 | 决策方式 | 是否调用大模型 |
| --- | --- | --- | --- |
| 观众驱动 | 评论、礼物、操作员耳语 | Stage A/B 仲裁，胜出意图进入 Stage C | 可能，取决于意图与预算 |
| 目标驱动 | 操作员开启目标模式 | 确定性候选 + 模型排序 + `GoalRuntime` 执行闸门 | 已配置模型时可能 |

目标模式采用受约束的混合决策。`SurvivalGoalPlanner` 先从身体事实计算阶段、
里程碑和合法候选；模型只能从候选 id 中选择一个，并给出一句理由。模型不能发明
技能、参数、坐标或跳过前置，也不能把“没木头”改成“直接建家”。候选少于两个、
未配置模型、预算超限、超时、坏 JSON 或未知 id 时会直接回退确定性任务，因此供应
商故障不会让角色停摆。

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
  -> planSurvival（阶段、里程碑、合法候选任务）
  -> 模型排序（只能返回候选 id；失败则用确定性首选）
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
- 模型只参与候选排序，不直接生成技能；开头无木头时候选锁死为砍树/基础工作台。
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
  路径和真实原因。直线路段会压缩成关键拐点，长距离安全路段自动奔跑。
- `visibleWood` 感知：每 30 tick 采样 96 格内的已加载地表，按 24/64 格分成
  密采样、2 格网格和 3 格网格，再做视线确认；缓存随移动超过 8 格或过期失效。
  日志里的 `columns` / `candidates` 可区分“范围不够”和“扫描没有执行”。
- `ViewSlew` / `CameraController`：最短弧转向、角速度上限、平滑镜头；交互瞄准仍
  使用真实命中射线。
- `StairEscape` / `CanopyEscape` / `ShaftEscape`：卡在坑、树冠或竖井时先寻找
  可挖掘的楼梯/下降路径，必要时垫方块，不凭空瞬移。
- 自动垫桥：验证支撑面、目标格和材料后逐块放置，确认后再前进。
- `IdleWander`：仅在无命令且 Agent 持有控制权时随机观察、短距离行走、捡附近
  掉落物；真实命令到达会立即重置。
- `Reflexes`：岩浆、低血、坠落、溺水、着火、饥饿、近身威胁和来箭先松手/闪避；
  后续战斗或撤退仍由 Agent 规划。

## 5. 模型额度为什么可能不变或增长

目标模式只有出现两个以上合法候选时才请求模型。开局无木头时通常只有一个砍树/
工作台候选，因此不会调用模型；未配置 API Key、预算超限或供应商失败时也不会产生
成功调用。模型成本账本只在实际调用成功后记账；没有调用就没有新增 `model_cost`
行。正常推进到食物、庇护所和发育阶段后，候选增加，额度可能随每次任务决策增长。

检查顺序：

```bash
sqlite3 "$HOME/.craftmate/craftmate.db" \
  "select datetime(occurred_at_ms/1000,'unixepoch','localtime'), provider, model,
          cost, prompt_tokens, completion_tokens
     from model_cost order by occurred_at_ms desc limit 10;"
```

供应商自己的账单接口是另一份口径。OpenAI 兼容端点可用下面的请求核对；这里的
`total_usage` 通常是美分，账户无硬上限时 `soft_limit_usd` 会是一个很大的值：

```bash
KEY=$(jq -r '.model.apiKey' "$HOME/.craftmate/integrations.json")
curl -fsS -H "Authorization: Bearer $KEY" \
  "https://www.yyapi.cloud/v1/dashboard/billing/usage" | jq '.total_usage'
```

网页额度卡和账单接口可能使用不同统计周期，因此不要只看页面上的“已用”小数；
同一次目标运行前后两次查询 `total_usage` 增长，才是真实的扣费证据。

如果目标模式正在运行、`model_cost` 没有新行，先看是否只有一个候选、是否未配置
模型或是否处于失败回退；这些情况下额度不变是预期行为。若供应商返回 `502`，同样
不会产生费用；应先检查供应商端点与模型名，而不是只刷新余额页面。

从迁移 `0012_model_usage.sql` 起，即使没有配置每百万 token 单价，成功请求也会以
`cost = 0` 记录 `prompt_tokens` / `completion_tokens`，便于区分“没有调用”和
“调用了但本地价格为零”。

## 6. 现场排查

| 现象 | 先看什么 | 结论 |
| --- | --- | --- |
| 角色随机看/走 | 客户端 `idle action=...` | 没有 Agent 任务，Mod 空闲游走 |
| 有目标但短时不动 | `nextTask`、`retryAt`、`consecutiveFailures` | 退避或等待身体终态 |
| 一直重复同一路径 | `decision_log` 与 `goto start/escape` | 检查失败策略、地形和重规划日志 |
| 模型额度不变 | `model_cost`、候选数量、供应商错误 | 只有一个确定性候选、未配置模型，或请求失败 |
| 明明看到树却说没树 | `perception visibleWood` 的 `columns/candidates` | 扫描未执行、加载区块不足或被视线过滤 |
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

怀疑客户端卡顿时，先看树木扫描是否出现 `perception scan took ...ms`。诊断截帧
上限为 1024 宽、每 2 秒一帧，编码在独立线程；若仍有长帧，可用 JFR 对照：

```bash
jcmd <minecraft-pid> JFR.start duration=15s filename=/tmp/craftmate.jfr
$JAVA_HOME/bin/jfr print --events jdk.ExecutionSample \
  --stack-depth 1 /tmp/craftmate.jfr
```

## 7. 当前边界

- 还未完成从空手到击杀末影龙的真实存档全链路。
- 末影水晶、床炸、落地水、要塞搜索和末地地形尚未进入稳定技能闭环。
- 空闲游走不会挖矿、开箱或主动建设，它只避免角色像冻结一样站着。
- 真实直播、语音路由和模型供应商稳定性仍按各自验收文档处理。
