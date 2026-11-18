# 自主生存闭环

> 本文说明目标模式的生产决策链、验收边界和现场排查。Bridge 字段见
> [Bridge 设计](../reference/bridge.md)，系统边界见[架构总览](../reference/architecture.md)，
> 目标树节点语义见[目标树调度](../reference/goal-tree.md)。

最后核对：2026-11-17。目标模式的代码路径为确定性树调度，不依赖逐步模型调用。

## 1. 两条输入路径

| 路径 | 输入 | 决策器 | 是否调用模型 |
| --- | --- | --- | --- |
| 观众驱动 | 评论、礼物、操作员耳语 | Stage A/B 仲裁，胜出意图进入 Stage C | 可能 |
| 目标驱动 | 操作员开启目标模式或空场目标 | `GoalTreePlanner` + `GoalRuntime` | 否 |

评论空窗时，`Show.downtimeBeat` 可生成环境台词；身体侧空闲游走只负责观察和短距
移动。两者都不授予技能。`CRAFTMATE_IDLE_GOAL=1` 可在空窗 90 秒后自动建立
「击败末影龙」目标，默认关闭。

目标模式中，观众提议进入收件箱，不直接插入当前任务。安全、阶段前置和执行闸门
仍然有效。

## 2. 生产决策链

```text
身体快照
  -> worldFactsFromSnapshot
  -> GoalTreePlanner（根、阶段骨架、里程碑、task/skill 叶子）
       -> planMission（只提议阶段方向）
       -> nextTaskForStage（编译阶段内合法原子任务）
       -> 前置阶段与技能能力检查
  -> GoalRuntime（单任务、终态、退避、失败历史）
  -> Bridge（能力校验、队列、超时）
  -> Fabric Mod（寻路、挖掘、放置、合成、战斗）
  -> changes（世界证据）
  -> 重新观察
```

`planMission` 只选择任务链方向，不直接生成技能；目标树还会检查前置阶段和当前
阶段是否有可执行任务，因此 mission 的提议不是最终调度结果。

| 优先级 | 任务链提议 | 作用 |
| --- | --- | --- |
| 1 | `survive` | 低血量或近身强敌时先撤离 |
| 2 | `secure-food` | 饥饿低于安全线且无可食物品时补充食物 |
| 3 | `recover-tool` | 恢复可用镐，避免裸手采矿 |
| 4 | `acquire-station` | 材料够但缺少可达工作台时先建站点 |
| 5 | `iron-set` | 按铁镐、铁剑、四件护甲的缺口推进 |
| 6 | `diamond-first-3` | 铁套齐备后取得前三颗钻石 |
| 7 | `night-work` | 无床时在安全区域继续制作、熔炼或矿道工作 |
| 8 | `complete` | 有界验收目标已满足 |

默认「击败末影龙」使用完整生存链；`diamond-set` 目标以钻石镐、剑、头盔、胸甲、
护腿、靴子六件齐全为验收线。目标树按 `goalKind` 选择阶段范围，不会凭标题跳过
木头、工具、食物和站点前置。

### 2.1 连续计划

`run_plan` 是身体内的顺序执行能力，最多 32 个原子步骤或 180 秒。legacy
`MissionGoalPlanner` 在熔炼或合成材料可证明时，用 `PlanCompiler` 把短序列编译成
一个 `run_plan`；默认树引擎当前按里程碑展开原子任务，每个技能叶子单独下发。
两条路径都受类型化 guard、目标族白名单和世界证据约束；身体不能选择分支或生成新目标。

树引擎先建立完整阶段骨架，只展开当前阶段的里程碑和任务；同一时刻只有一个技能
叶子在途。技能失败先重试一次再换任务，阶段切换必须满足前置阶段。低血和工具失效
走根下 interrupt，恢复后重新求值；操作员接管暂停当前节点，不伪造技能。

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
| GoalTreePlanner + nextTaskForStage | 目标树、阶段方向、里程碑、前置条件和合法任务 | 修改世界 |
| Mission / Survival planner（legacy） | 回退路径的阶段建议与 `run_plan` 编译 | 修改世界；不进入默认装配 |
| GoalRuntime | 单任务在途、终态判定、退避、目标切换 | 选择具体 Minecraft 操作 |
| Bridge | 能力、队列、控制权、超时、终态回传 | 生存策略 |
| Fabric Mod | tick 内执行、局部寻路、反射、原子动作 | 模型调用、观众意图 |

Mod 的低层自治只把已批准技能做得像人：`BoundedPathfinder` 负责有界 A*，地形恢复
模块处理台阶/树冠/竖井/断口，`Reflexes` 只松手和原生逃生，`IdleWander` 只在无命令
时活动。逐项技能与 Java 任务对应见
[Agent 编排与游戏身体映射](../reference/agent-body-mapping.md)。

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
- legacy 标题式验收仍可能停在铁套或前三颗钻石；默认目标树的验收由 `goalKind`
  决定，`diamond-set` 需要钻石镐、剑、头盔、胸甲、护腿和靴子六件齐全。
- 真实直播、语音路由和模型供应商稳定性见
  [验证清单](verification.md)与[外部集成](../guides/integrations.md)。
