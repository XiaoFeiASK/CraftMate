# 自主生存闭环

> 本文说明目标模式的生产决策链、验收边界和现场排查。Bridge 字段见
> [Bridge 设计](../reference/bridge.md)，系统边界见[架构总览](../reference/architecture.md)。

最后核对：2026-11-16。目标模式的代码路径为确定性规划，不依赖逐步模型调用。

## 1. 两条输入路径

| 路径 | 输入 | 决策器 | 是否调用模型 |
| --- | --- | --- | --- |
| 观众驱动 | 评论、礼物、操作员耳语 | Stage A/B 仲裁，胜出意图进入 Stage C | 可能 |
| 目标驱动 | 操作员开启目标模式或空场目标 | `MissionGoalPlanner` + `GoalRuntime` | 否 |

评论空窗时，`Show.downtimeBeat` 可生成环境台词；身体侧空闲游走只负责观察和短距
移动。两者都不授予技能。`CRAFTMATE_IDLE_GOAL=1` 可在空窗 90 秒后自动建立
「空场自由生存」目标，默认关闭。

目标模式中，观众提议进入收件箱，不直接插入当前任务。安全、阶段前置和执行闸门
仍然有效。

## 2. 生产决策链

```text
身体快照
  -> worldFactsFromSnapshot
  -> planMission（安全门与验收链）
  -> planSurvival（阶段、里程碑、合法原子任务）
  -> MissionGoalPlanner（必要时合成 run_job）
  -> GoalRuntime（单任务、终态、退避、失败历史）
  -> Bridge（能力校验、队列、超时）
  -> Fabric Mod（寻路、挖掘、放置、合成、战斗）
  -> changes（世界证据）
  -> 重新观察
```

`planMission` 只选择任务链方向，不直接生成技能：

| 优先级 | 任务链 | 作用 |
| --- | --- | --- |
| 1 | `survive` | 低血量或近身强敌时先撤离 |
| 2 | `secure-food` | 饥饿低于安全线且无可食物品时补充食物 |
| 3 | `recover-tool` | 恢复可用镐，避免裸手采矿 |
| 4 | `acquire-station` | 材料够但缺少可达工作台时先建站点 |
| 5 | `iron-set` | 按铁镐、铁剑、四件护甲的缺口推进 |
| 6 | `diamond-first-3` | 铁套齐备后取得前三颗钻石 |
| 7 | `night-work` | 无床时在安全区域继续制作、熔炼或矿道工作 |
| 8 | `complete` | 有界验收目标已满足 |

默认「击败末影龙」使用完整生存链；标题含铁器的目标以整套铁装为验收线，含钻石的
目标当前以「整套铁装 + 3 颗钻石」为有界验收线，不等同于整套钻石甲。规划器不会
凭标题跳过木头、工具、食物和站点前置。

### 2.1 连续任务

当熔炼产量和现有材料足以连续完成多件铁装，且工作台可达时，
`MissionGoalPlanner` 会把熔炼与后续制作编译成一个 `run_job`。这样身体不必在
每个原子步骤之间等待一次空闲重排。节点仍逐项校验参数，失败时停止后续节点。

### 2.2 执行约束

- 一次最多一个在途目标命令；收到终态后才重新规划。
- 完成必须带已确认世界变化；空结果或 `unconfirmed` 不推进里程碑。
- 同一移动策略连续失败会换区域或改用恢复路径，不做原地无限重试。
- 结算成功后等待一次新的身体观察，再允许下一步，避免复用动作前快照。
- 接管、急停、暂停和目标切换会取消在途命令。
- 部署/挖掘后的 350ms 观察间隔防止同一动作在旧快照上重复下发。

## 3. 生存阶段

生存 DAG 共十个阶段：

1. 木头与工作台
2. 木镐与石镐
3. 食物
4. 营地与床
5. 铁器与熔炉
6. 钻石装备
7. 下界与烈焰棒
8. 末影珍珠与末影之眼
9. 要塞
10. 末地传送门与末影龙

每个里程碑由身体事实判定 `complete`、`incomplete` 或 `unverified`。缺失观测
保持 `unverified`，不按时间或固定百分比补进度。

## 4. Agent 与 Mod 分工

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Mission / Survival planner | 任务链方向、阶段、前置条件、合法任务 | 修改世界 |
| GoalRuntime | 单任务在途、终态判定、退避、失败历史、目标切换 | 选择具体 Minecraft 操作 |
| Bridge | 能力协商、队列、控制权、超时、终态回传 | 生存策略 |
| Fabric Mod | tick 内执行、局部寻路、视角、原子动作和身体侧反射 | 模型调用、观众意图 |

Mod 的低层自治只把已批准技能做得像人：

- `BoundedPathfinder` 使用有界 A*，失败返回部分路径和原因。
- `StairEscape`、`CanopyEscape`、`ShaftEscape`、自动垫桥处理局部卡死。
- `CameraSpring` / `CameraController` 做最短弧转向和视角平滑，命中仍按真实射线。
- `IdleWander` 仅在 Agent 持有控制权且无命令时观察、短距行走或捡掉落物。
- `Reflexes` 先松手和闪避；去哪里由 Agent 决定。

## 5. 反射与夜间

身体反射先于 Agent 决策。岩浆、低血、坠落、溺水、着火、饥饿和近身威胁会先
停止输入。协调器只对紧急危险取消 Agent 在途任务；非紧急 `threat` 只记录事件，
不打断正常行走。正在执行的攻击、紧急撤退和恢复攀爬不会被同类反射反复取消。

有床时夜间回家睡觉；没有床时不建造临时小屋、不挖竖井拖延时间。健康的身体继续
矿道、制作、熔炼或整理物资；受伤且没有食物或安全工作时，只执行有界的原地等待，
天亮后恢复规划。

## 6. 现场排查

```bash
sqlite3 -header -column "$HOME/.craftmate/craftmate.db" \
  "select enabled, goal_json, progress_json from goal_runtime;"

sqlite3 -header -column "$HOME/.craftmate/craftmate.db" \
  "select datetime(created_at_ms/1000,'unixepoch','localtime') as at,
          intent, status, skill_json, outcome_json
     from decision_log order by created_at_ms desc limit 20;"
```

| 现象 | 先看什么 | 结论 |
| --- | --- | --- |
| 角色随机看/走 | 客户端 `idle action=...` | 没有 Agent 任务，Mod 空闲游走 |
| 目标存在但短暂不动 | `progress_json.nextTask`、`retryAt` | 退避、等待终态或观察间隔 |
| 重复同一路径 | `decision_log`、`goto start/escape` | 检查失败码、路线黑名单和地形 |
| 看到树却说没树 | `perception visibleWood` 的 `columns/candidates` | 扫描未执行、区块不足或视线过滤 |
| 动作开始但没有进度 | `changes` / `unconfirmed` | 世界变化未确认，不能算完成 |

客户端日志默认在 Minecraft 实例的 `logs/latest.log`。目标模式不再增加模型费用；
如果看到新增 `model_cost`，优先检查观众 Stage C 或手工触发的模型调用。

## 7. 当前边界

- 从空手到击杀末影龙的真实存档全链路尚未完成。
- 末影水晶、床炸、落地水、要塞搜索和末地地形尚未进入稳定技能闭环。
- 有界验收会停在铁套或前三颗钻石，不代表整套钻石甲已经完成。
- 真实直播、语音路由和模型供应商稳定性见
  [验证清单](verification.md)与[外部集成](../guides/integrations.md)。
