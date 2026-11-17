# Agent 编排与游戏身体映射

> 本文回答“一个决定由哪层产生、沿哪条代码路径下发、最终由哪个 Java 任务执行”。
> Bridge 帧格式见 [Bridge 设计](bridge.md)，系统边界见[架构总览](architecture.md)。

## 1. 一句话边界

```text
Agent 决定做什么和为什么
  -> Bridge 决定能不能发、何时发、超时怎么办
  -> Fabric Mod 决定具体怎么做、怎么在局部失败后继续
```

- **Agent 编排层**拥有目标、阶段、技能选择和终态判定。它只使用语义 ID，不导入
  Minecraft 类型，也不直接读写世界。
- **Bridge**拥有能力协商、队列、幂等、控制权、超时和终态转发，不生成技能。
- **身体层**拥有 tick 内感知、反射、局部寻路、原子动作和世界证据，不调用模型，
  也不重新规划目标。

判断新逻辑该放哪层：需要“选择目标或判断是否完成”就放 Agent；需要“在多个合法
动作之间排队、取消或超时”就放 Bridge；需要“读 Minecraft 状态、按键、瞄准或
修改世界”就放 Mod。

## 2. 总链路

```text
Ingress / 操作员
  -> Orchestrator
     -> Show（观众路径）或 GoalRuntime（目标路径）
        -> MissionGoalPlanner / SurvivalGoalPlanner / Planner
           -> SkillCall（契约校验）
              -> Bridge BodySession（能力、队列、控制权）
                 -> BridgeClient（WebSocket、tick 投递）
                    -> GameActions（任务状态机）
                       -> 辅助模块（寻路、感知、证据、反射）
                          -> result / progress / event
                             -> GoalRuntime / decision_log / telemetry
```

两条输入路径最终只在一个地方汇合：`packages/bridge/src/coordinator.ts` 的
`BodySession.issue`。因此“观众触发的挖矿”和“目标模式触发的挖矿”在身体看来是
同一种命令，差别只在决策来源、优先级和 `traceId`。

## 3. 编排模块职责

| 层 | 代码入口 | 输入 | 输出 | 不负责 |
| --- | --- | --- | --- | --- |
| 接入 | `services/ingress/src/*` | 抖音/dyhub 事件 | `AudienceEvent` | 内容判断、游戏动作 |
| 观众决策 | `packages/agent/application/show.ts` | `AudienceEvent`、世界快照 | `Decision`、承诺、节目节拍 | 直接执行技能 |
| Stage A/B | `packages/agent/domain/arbitration/*` | 文本、人格权重、冷却 | 意图与分数 | 模型调用、世界访问 |
| Stage C | `packages/agent/application/planner.ts` | 胜出意图、人格、能力清单 | `speech` + 可选 `SkillCall` | 绕过技能契约 |
| 目标方向 | `packages/agent/application/mission-goal-planner.ts` | 世界事实、当前阶段、失败历史 | 阶段、里程碑、下一个 `GoalTask` | 修改世界、逐步调用模型 |
| 生存规划 | `packages/agent/domain/survival/*` | `WorldFacts`、目标、可用技能 | 十阶段 DAG 与合法原子任务 | 选择具体方块坐标 |
| 连续计划 | `packages/agent/application/plan-compiler.ts` | 任务、事实、步骤 | 一个 `run_plan` `SkillCall` | 在身体内分支重规划 |
| 目标运行时 | `packages/agent/application/goal-runtime.ts` | 规划器、桥健康、世界快照 | 单任务下发、终态、退避、恢复 | 生成 Minecraft 操作 |
| 编排装配 | `services/orchestrator/src/main.ts` | 配置、服务、数据库 | 运行时循环、控制面、telemetry | 领域规则 |
| 编排持久化 | `services/orchestrator/src/persistence.ts` | SQLite、Show、GoalRuntime | 恢复后的运行对象 | 游戏输入 |
| 状态抢占 | `services/orchestrator/src/state-monitor.ts` | 在途任务、身体事实 | 低血/工具/可见矿的改道建议 | 选择替代技能 |
| 契约 | `packages/contracts/src/skills.ts`、`bridge.ts` | 技能与帧定义 | zod 校验、能力映射 | 执行动作 |
| 通道 | `packages/bridge/src/ws-server.ts`、`coordinator.ts`、`queue.ts` | `SkillCommand` | `cmd`、`ack`、终态、ownership | 感知与寻路 |
| 身体入口 | `mods/craftmate-body/.../BridgeClient.java` | WebSocket 帧、tick | `GameActions` 调用 | 规划目标 |
| 身体执行 | `mods/craftmate-body/.../GameActions.java` | 技能 ID + 参数 | 世界变化、进度、结果 | 生成新目标 |

### 3.1 观众路径

1. Ingress 归一化事件，`Show.ingest` 做 Stage A/B。
2. 胜出意图进入 `Planner`（Stage C）；模型只能输出 `speech` 和声明过的技能。
3. `dispatchDirectSkill` 校验技能后调用 `bridge.session.issue`。
4. 终态按 `decisionId` 回填 `decision_log`，`taskTelemetry` 投影到控制台。

### 3.2 目标路径

1. `dispatchGoalStep` 调用 `GoalRuntime.beginStepAsync`。
2. `MissionGoalPlanner.plan` 先决定任务链方向，再由 `planSurvival` 选择阶段与原子任务。
3. 可证明的短序列由 `PlanCompiler` 编译为单个 `run_plan`。
4. `GoalRuntime` 写入 decision、绑定 `commandId/taskId`，调用同一个 `issue`。
5. 身体终态回填 `goal_runtime`；成功后等待一次新观察再规划下一步。

目标模式默认不调用模型。`Planner` 只服务观众 Stage C；两者不会互相重排任务。

### 3.3 编排出口

| 编排出口 | 可产生的技能 | 说明 |
| --- | --- | --- |
| 观众 Stage C `Planner` | 身体声明过的任意契约技能 | 模型输出仍要经过 `parseSkillArgs` 与能力白名单 |
| 生存任务 `tasks.ts` | `attack`、`chop_tree`、`collect_items`、`craft`、`deposit`、`eat`、`goto`、`mine_block`、`mine_tunnel`、`pillar_up`、`place_block`、`sleep`、`smelt`、`use_block`、`wait`、`withdraw` | 由世界事实和阶段前置决定，不按模型愿望生成 |
| `PlanCompiler` | `run_plan` | 把可证明的短序列打包成一个身体内顺序任务 |
| 空场/反射节拍 | 无 | 只生成台词和事件，不授予技能 |
| `state-monitor` | 无 | 只建议中断当前任务，替代任务仍由规划器产生 |

## 4. 技能到身体实现的映射

技能 ID 的权威清单有两层：

- `packages/contracts/src/skills.ts` 的 `skillNameSchema` 是未来契约全集；
- `FABRIC_BODY_SKILLS` 与 `GameActions.SKILLS` 是当前真实身体可执行集合。

`FABRIC_BODY_SKILLS` 与 `GameActions.SKILLS` 都是以下 20 个技能；契约全集是
23 个。多出的 `follow`、`flee`、`emote` 只在契约中，身体未实现，不得写成现有能力。

| 技能 | 编排用途 | 身体任务类 | 主要协作模块 | 完成证据 |
| --- | --- | --- | --- | --- |
| `goto` | 精确移动、探索、逃生、接近交互点 | `GotoTask` | `BoundedPathfinder`、`NavGoal`、`NavigationMode`、`ApproachRoute`、`StairEscape`、`ShaftEscape`、`CanopyEscape` | 实际位移到目标；探索可明确返回部分路径 |
| `look_at` | 观察实体或坐标 | `LookTask` | `CameraController`、`ViewSlew`、`CameraSpring` | 镜头稳定 3 tick |
| `mine_block` | 精确方块或最近同类方块 | `MineTask` | `BlockInteraction`、`OrePerception`、`MiningApproach`、`MiningDrops`、`ToolSelection`、`PickaxeBudget`、`UnreachableTargets` | 目标格变空气；资源挖掘还需确认预期掉落 |
| `mine_tunnel` | 连续阶梯下挖或水平支线 | `DescendTask` | `MineStair`、`ShaftEscape`、`OreOpportunity`、`MiningDepth`、`PickaxeBudget` | 每个台阶/支线段的方块变化与进度 |
| `chop_tree` | 按原木数量砍树 | `MineTask`（log 模式） | `TrunkSelection`、`CanopyCleanup`、`CanopyEscape`、`MiningDrops` | 原木掉落或背包增量 |
| `collect_items` | 走近并拾取掉落物 | `CollectTask` | `PickupApproach`、`CollectionEvidence` | 背包目标物品增加 |
| `craft` | 工作台或 2×2 合成 | `CraftTask` | `CraftGridLayout`、`CraftEvidence`、`StationPlacement`、`StationMemory`、`ApproachRoute` | 输出槽确有目标物，取走后主背包同量增加 |
| `deposit` | 把物品存入容器 | `DepositTask` | `ContainerEvidence`、`ApproachRoute`、`InteractionReach`、`StationMemory` | 背包减少量与容器增加量逐项相等 |
| `withdraw` | 从容器批量取物 | `DepositTask`（取物模式） | 同上；容器内容短时缓存 | 容器减少量与背包增加量逐项相等 |
| `say` | 在游戏内聊天框发送文本 | `SayTask` | 无 | 聊天包已提交；直播语音由 Voice 负责，不是此技能 |
| `wait` | 有界等待 | `WaitTask` | 无 | tick 数到达 |
| `attack` | 接近并攻击实体 | `AttackTask` | `InteractionEvidence`、`ApproachRoute`、`ToolSelection` | 同一实体掉血或死亡；可选确认掉落入包 |
| `equip` | 选择快捷栏物品 | `EquipTask` | 无；护甲自动升级由 `ArmorSelection` 独立维护 | 选中槽确实持有目标物品 |
| `eat` | 吃背包中的食物 | `EatTask` | `SessionFacts` | 饥饿值恢复且食物堆叠减少 |
| `use_block` | 右键使用门、按钮等 | `UseBlockTask` | `BlockInteraction`、`InteractionReach` | 方块状态变化或服务端接受交互 |
| `place_block` | 放置方块或床 | `PlaceTask` | `PlacementTarget`、`StationPlacement`、`StationMemory`、`BlockInteraction` | 目标格出现请求方块且材料减少 |
| `pillar_up` | 原地垫高脱困 | `PillarTask` | `PlanSafety`、`PlacementTarget`、`ShaftEscape` | 每块脚下方块确认出现，累计高度 |
| `smelt` | 走到熔炉并熔炼 | `SmeltTask` | 熔炉菜单、背包差量、燃料选择 | 产物入包、输入与燃料减少 |
| `sleep` | 走到床并睡到天亮 | `SleepTask` | `SleepEvidence`、`ApproachRoute`、`StationMemory` | `isSleeping` 后世界天数前进 |
| `run_plan` | 执行 1–32 步连续计划 | `PlanTask` | `PlanGuardEvaluator`、`PlanGuardNeeds`、`PlanSafety` | 每步自身证据 + `targetLocks` / `checkpoint` |

> `GameActions.java` 同时是任务表、任务状态机和通用 Minecraft 操作集合。新增技能
> 时不要只加一个 `case`：还要同步契约、能力映射、`SkillLabels`、计划编译器和测试。
>
> `look_at`、`say`、`equip` 等技能可由观众 Stage C 或操作员直接调用；当前生存
> 规划器不生成它们。护甲和镐子的自动更换由身体的 `ArmorSelection` / `ToolSelection`
> 维护，不需要 Agent 逐步下发 `equip`。

## 5. 生存阶段到身体行为

阶段定义在 `packages/agent/domain/survival/stages.ts`，任务生成在
`packages/agent/domain/survival/tasks.ts`。身体不关心阶段名，只关心收到的技能。

| 阶段 | Agent 选择的主要任务 | 常见身体技能 | 主要身体模块 | 验收事实 |
| --- | --- | --- | --- | --- |
| `wood-and-table` | 砍树、木板、工作台、放置 | `chop_tree`、`craft`、`place_block` | `TrunkSelection`、`CraftGridLayout`、`StationPlacement` | 原木/木板/工作台/已放置站点 |
| `stone-tools` | 挖石、合成石镐 | `mine_block`、`craft` | `BlockInteraction`、`ToolSelection`、`CraftEvidence` | 圆石、可用石镐 |
| `food` | 狩猎、拾取、进食、烹饪 | `attack`、`collect_items`、`eat`、`smelt` | `AttackTask`、`CollectTask`、`EatTask`、`SmeltTask` | 饥饿值、食物堆叠、`foodConsumed` |
| `shelter` | 做床/箱子、放置、睡觉、存放 | `craft`、`place_block`、`sleep`、`deposit` | `StationPlacement`、`SleepEvidence`、`ContainerEvidence` | 床/箱子/已放置事实、天数前进 |
| `iron` | 挖铁、熔炼、批量制作 | `mine_block`、`smelt`、`run_plan` | `OrePerception`、`SmeltTask`、`PlanTask` | 粗铁/铁锭/铁装 |
| `diamond-gear` | 阶梯下挖、矿脉挖掘、钻石装备 | `mine_tunnel`、`mine_block`、`craft` | `MineStair`、`OreOpportunity`、`MiningDepth` | 钻石与装备 |
| `nether` | 黑曜石、传送门、烈焰人 | `mine_block`、`place_block`、`use_block`、`attack` | `BlockInteraction`、`PlaceTask`、`AttackTask` | 黑曜石、烈焰棒、维度事实 |
| `eyes` | 末影人、珍珠、合成眼睛 | `attack`、`collect_items`、`craft` | `AttackTask`、`CollectTask`、`CraftTask` | 珍珠、末影之眼 |
| `stronghold` | 远程地标搜索、要塞进入 | `goto`、`use_block` | `BoundedPathfinder`、`ChunkIndex`、`InteractionEvidence` | 地标、维度/位置证据 |
| `dragon` | 末地移动、战斗、破坏水晶 | `goto`、`attack`、`place_block`、`use_block` | `GotoTask`、`AttackTask`、`PlaceTask` | 末影龙死亡会话事实 |

阶段只约束“该做什么”，不保证身体一定做到。里程碑必须由 `changes` 或身体快照
推进；`unconfirmed`、空结果和旧快照都不算完成。

## 6. `run_plan` 的跨层契约

`run_plan` 是 Agent 唯一允许下发的“身体内顺序执行”宏技能，但它不是脚本解释器。

| 层 | 责任 | 代码 |
| --- | --- | --- |
| 契约 | 限制 1–32 步、最多 8 个目标族、180 秒、禁止嵌套 | `packages/contracts/src/skills.ts` |
| Agent | 生成 planId、步骤、预期证据、目标族和 guard | `packages/agent/application/plan-compiler.ts` |
| 目标运行时 | 把计划当作一个在途任务；终态后才重新规划 | `packages/agent/application/goal-runtime.ts` |
| Bridge | 一个命令、一个 taskId；deadline 大于身体预算 | `packages/bridge/src/coordinator.ts` |
| 身体 | 逐步创建子任务，步前重新求值 guard，失败即停 | `GameActions.PlanTask` |
| 身体 guard | 只接受封闭白名单，未知 guard 失败关闭 | `PlanGuardEvaluator` |
| 身体观察 | 矿族 guard 缺观察时触发有界矿脉扫描 | `PlanGuardNeeds`、`OrePerception` |

guard 白名单：

| guard | Agent 何时生成 | 身体如何判断 |
| --- | --- | --- |
| `inventory` | 合成/熔炼原料、工具前置 | 当前背包数量区间 |
| `target_family` | 挖矿、砍树、攻击实体 | 已观察/可见/可达的族实例数量 |
| `station` | 工作台、熔炉 | 当前是否可达该站点 |
| `dimension` | 跨维度步骤 | 当前维度 ID |
| `health` / `food` | 挖掘等风险步骤 | 当前生命/饥饿区间 |
| `time` | 夜间/白天行为 | 当前昼夜 |
| `world_version` | 计划编译时的世界身份 | 世界 ID 是否相等或已变化 |
| `all` / `or` | 组合多个前置 | 逐项与/或，嵌套最多 3 层 |

身体不允许在 plan 内选择分支、改写目标或嵌套 `run_plan`。guard 不匹配、证据冲突、
世界身份变化、超时、危险或操作员接管都会回到 Agent 安全点。

## 7. 感知、反射与结果回传

### 7.1 身体上报什么

| 身体事实 | 生产模块 | Agent 消费方 |
| --- | --- | --- |
| 背包、护甲、耐久 | `InventorySnapshot`、`GameActions.snapshot` | `worldFactsFromSnapshot`、`inventoryCount`、阶段里程碑 |
| 生命、饥饿、昼夜、睡眠 | `GameActions.snapshot`、`SessionFacts` | `isLowHealth`、`isHungry`、`isNight` |
| 附近方块、可见矿、可达方块 | `OrePerception`、`GameActions` 感知扫描 | `nearbyHas`、任务生成、`state-monitor` |
| 附近实体与地标 | `GameActions` 实体扫描、`ChunkIndex` | `nearestEntity`、`nearestLandmark`、世界记忆 |
| 站点与营地锚点 | `StationMemory`、`StationPlacement` | 工作台/熔炉/箱子/床任务 |
| 反射事件 | `Reflexes`、`WaterSurface`、`RespawnRetry` | `world_event`、`Show.reactToIncident`、Bridge 取消 |
| 终态与证据 | 各任务类 + `*Evidence` | `skillOutcomeSchema`、`decision_log`、`goal_runtime` |

### 7.2 反射的边界

反射层每 tick 先于任务运行。它只做“松手 + 原生逃生”：

- 岩浆、低血、坠落、溺水、着火、近身威胁会先停止输入；
- 反射不选长期安全点，不发明路线，不生成技能；
- 紧急危险会让 Bridge 取消在途 Agent 任务；非紧急威胁只记录事件；
- 操作员接管后反射不碰人的输入。

### 7.3 终态不是“开始执行”

身体完成技能时必须给出世界变化；Agent 侧仍会二次校验：

- `completed` 但无 `changes`，Orchestrator 会改判失败并写 `E_NO_PROGRESS`；
- `unconfirmed` 只能作为证据，不能推进目标里程碑；
- 超时、取消、抢占和失败分别进入 `timeout` / `cancelled` / `preempted` / `failed`；
- 同一条决策通过 `decisionId` 把下发、进度和终态串起来。

## 8. 控制权与空闲行为

| 状态 | 身体入口 | 行为 |
| --- | --- | --- |
| Agent 持有 | `BridgeClient.agentControlled`、`GameActions.update` | 执行任务；无任务时允许 `IdleWander` |
| Operator 持有 | `ControlOwnership`、`BridgeClient.applyOwnership` | 取消 Agent 任务；反射和空闲游走不接管人的输入 |
| None | 断线、心跳缺失、急停 | 本地停输入、取消未完成任务；等待显式接管或释放 |

`IdleWander` 只在 Agent 持有控制权且队列为空时观察、短距行走或捡附近掉落物，不会
挖矿、开容器或与 Bridge 命令竞争。看到角色在目标之间随机看/走，先检查是否有
在途任务和 `retryAt`，不要误判为寻路失控。

## 9. 启动脚本与进程映射

| 入口 | 作用 | 关键代码 |
| --- | --- | --- |
| `./start.command` | 检查 Node/Rust、端口和依赖，加载 `.env` | `start.command` |
| `node tools/dev.mjs` | 并行启动 Orchestrator、Voice、桌面或 Web | `tools/dev.mjs` |
| Orchestrator | 装配 Show、GoalRuntime、Bridge、Ingress、控制面 | `services/orchestrator/src/main.ts`、`persistence.ts` |
| Voice | 只接收已批准台词并播放 | `services/voice/src/*` |
| Minecraft 客户端 | 加载 Fabric Mod，连接 `/bridge` | `CraftMateBodyClient`、`BridgeClient` |
| `./stop.command` | 结束本仓库进程并检查端口 | `stop.command` |

实际顺序：

1. `start.command` 检查 Node/Rust、安装依赖、确认 4321/4323/5173 未被占用。
2. 它只启动 Orchestrator、Voice 和桌面/Web；不启动 Minecraft，也不直接启动 Ingress。
3. Orchestrator 根据已保存的抖音房间调用 `createIngressSupervisor`，按需启动或重启
   Ingress；没有房间时保持未配置状态。
4. 操作员手动启动 Minecraft 并进入专用世界，`BridgeClient` 才发送 `hello`。
5. `stop.command` 只结束工作目录属于本仓库的进程，不会强杀占用端口的其他程序。

因此“服务已启动”不等于“身体已接入”。控制台显示身体未接入时，先检查 Minecraft
进程、Mod jar、world 载入和 Bridge token。

## 10. 新增或修改行为时的检查表

1. **只改参数**：先改 `packages/contracts/src/skills.ts`，再补契约测试。
2. **新增技能**：同步 `skillNameSchema`、`skillArgsSchema`、`SKILL_CAPABILITY`、
   `FABRIC_BODY_SKILLS`、`GameActions.SKILLS`、`createTask`、`SkillLabels`。
3. **新增阶段/任务**：改 `packages/agent/domain/survival/`，不要往 Java 里塞目标判断。
4. **新增连续计划步骤**：确认 `PlanCompiler` 能生成 guard 与证据，且身体子任务可执行。
5. **新增世界事实**：先让身体快照上报，再让 `worldFactsFromSnapshot` 消费；缺字段保持未知。
6. **新增安全动作**：先判断是反射、身体局部恢复还是 Agent 策略；只有后两者能选目的地。
7. **更新文档**：技能表改本文和 [Bridge 设计](bridge.md) 的现有能力清单；行为变化同步
   [验证清单](../operations/verification.md)。

## 11. 排查定位

| 现象 | 先看 | 结论 |
| --- | --- | --- |
| 有计划但没有命令 | `goal_runtime.progress_json`、`retryAt`、`state-monitor` | 退避、等待终态或规划器返回空任务 |
| 命令已下发但身体不动 | `/bridge` 健康、`ack`、`GameActions.start` 拒绝原因 | 控制权、能力、前置条件或界面阻挡 |
| 技能开始但无世界变化 | 任务 `problem`、`changes`、`unconfirmed` | 服务端拒绝、工具不对或证据不足 |
| 同一路径反复重试 | `decision_log`、`UnreachableTargets`、`route_blacklist` | 精确坐标不可达或策略未切换 |
| 角色空闲随机看/走 | 客户端 `idle action=...` | 没有在途任务，属于 `IdleWander` |
| 身体报成功但目标不推进 | `skillOutcomeSchema`、`completionEvidenceProblem` | 缺少已确认世界变化 |

