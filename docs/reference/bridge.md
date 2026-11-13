# Bridge 执行通道

> 本文定义 Orchestrator 与 Minecraft 身体之间的协议、队列和控制权。整体边界见[架构总览](architecture.md)。

## 1. 边界

Bridge 是受控命令通道，不是模型网关。

- Agent 输出技能调用；Bridge 校验能力、入队、跟踪任务。
- Mod 执行动作，不上传模型输出或平台身份。
- 队列上限、终态、看门狗和控制权是安全边界。

## 2. 传输与握手

- Orchestrator 在 `127.0.0.1:4321/bridge` 挂载 WebSocket upgrade。
- Token 来自 `~/.craftmate/bridge.token`，权限 `0600`。
- Body 发送 `hello`，声明 `capabilities` 和 `skills`。
- Orchestrator 回复 `welcome`，包含 sessionId、心跳、看门狗和已接受能力。
- 未握手、非法帧或旧 generation 被拒绝。

## 3. 帧

| 类型 | 方向 | 用途 |
| --- | --- | --- |
| `hello` | body → bridge | token、能力、技能声明 |
| `welcome` | bridge → body | 会话、能力协商、心跳参数 |
| `cmd` | bridge → body | 技能、参数、deadline、优先级、幂等键 |
| `ack` | body → bridge | 接受或拒绝，含 taskId |
| `progress` | body → bridge | 阶段、done、total |
| `result` | body → bridge | 终态、错误码、耗时 |
| `cancel` | bridge → body | 原因；Mod 必须停止副作用 |
| `event` | body → bridge | 世界事件，单调 `seq` |
| `heartbeat` / ownership | 双向 | 存活与控制权 |

### 3.1 反射事件

`event` 的名字是 `reflex` 时，身体在报告"我正在受伤"。这是身体自己的判断，
不等模型：Mod 每刻检查岩浆、低血、坠落、溺水、着火、饥饿、近身怪物和来箭，
命中后先松开按键、停止挖掘，再发一条事件。

```json
{ "type": "event", "seq": 0, "tick": 0, "name": "reflex",
  "data": { "kind": "lava", "detail": "站在岩浆里或离岩浆只有一格", "health": 4 } }
```

- 协调器收到普通危险后把在跑和排队中的 Agent 任务判 `failed`，错误码
  `E_PRECONDITION`，原因写成 `safety: <detail>`，并给身体发 `cancel`。
- `kind="threat"` 表示近身敌人或来箭。它不会取消已经在执行的 `attack`，否则每次
  近战都会在第 7 格被自己的反射打断；其它危险仍然高于攻击。
- 只有 `owner=agent` 时才这么处理。Operator 接管期间，身体不能借"安全"名义
  取消操作员的任务。
- 事件同时留在 `BridgeHealth.incidents`（最近 24 条）里，控制台直接显示。
- 名字用普通字符串，老版本协调器遇到未知名字只忽略，不会断开连接。

反射只做"松手 + 原生逃生"（岩浆里跳一下、水下上浮、短距侧闪/后撤），不自己
选长期安全点。去哪、接下来做什么归 Agent；反射层不发明路线，避免把角色带下
悬崖。

命令契约定义在 `packages/contracts/src/skills.ts` 与 `bridge.ts`。契约目录保留
20 个技能作为未来扩展面；当前 Fabric 身体实际支持的能力和技能以
`FABRIC_BODY_CAPABILITIES` / `FABRIC_BODY_SKILLS` 为准。未知技能、非法参数和未
声明的能力不会下发。未在真实身体清单中的技能只能作为 roadmap，不得写成现有
产品能力。

当前 Fabric 身体声明 16 个技能：`goto`、`look_at`、`mine_block`、`chop_tree`、
`collect_items`、`craft`、`deposit`、`say`、`wait`、`attack`、`equip`、`eat`、
`use_block`、`place_block`、`pillar_up`、`sleep`。

### 3.2 移动、镜头与地形

`goto` 的参数是 `target`，可选择附带 `candidates`（最多 8 个备选落点）和
`acceptPartial`。普通移动必须精确到达目标；探索任务可把已证明安全的部分路径终点
视为“到了新的观察区域”，但结果会明确说明是部分路径。身体使用有界 A*，只接受
可站立、无液体、无碰撞的单元格：

- `goto` 节点预算 4000，挖掘接近 3000；失败返回已走路径和真实原因。
- 路点按实际位移更新进展，U 形绕行不会因瞬间远离目标被判卡住。
- 连续 3 秒无进展才重规划，最多 3 次；每次重新校验路径。
- 单格台阶、树冠、竖井和断口分别走爬台阶、下降、挖竖井或自动垫桥状态机。
- 自动垫桥要求支撑面、目标格和材料都有效；每块确认出现后才提交下一块。
- 走路视角使用 `12°/tick` 上限，观察使用 `8°/tick`，只有对齐 25° 内才按前进。
  挖掘、放置和方块交互按坐标、距离与暴露面构造命中包；镜头只负责展示，
  不再是动作前置条件。近战攻击同样按实体与距离提交，不要求准星对准。

`look_at` 接受坐标或玩家名，镜头稳定后才完成。渲染镜头由 `CameraMixin` 平滑，
玩家真实旋转只承载移动方向与床等方块朝向，不参与命中判定。

### 3.3 合成、放置与战斗

`craft` 的参数为 `item` 与可选 `count`（1–64，默认 1）。它优先走到 16 格内最近
的工作台（无工作台时使用背包 2×2 网格），通过原版配方书让服务端放入单批材料，
再取走结果；只有取走前结果槽确有目标物品、且稳定后主背包增加了同一批数量时才
确认。`count` 大于单批产量时会重复提交配方，实际产量可能因配方一次产出多件而
略高于请求数。没有可达配方、材料不足、满包、界面未打开或结果未出现都会返回
`E_PRECONDITION` 和已确认数量。当前不含熔炉、高炉、烟熏炉、切石机等非合成台
配方。

`deposit` 的参数为可选的 `container`（整数方块坐标）与可选的 `item`；不传
`item` 时只转移非损坏物品，并跳过工具和装备。容器结果必须以背包减少量与容器
增加量逐项相等为确认依据。当前只覆盖 `BaseContainerBlockEntity` 的存储菜单，
不含末影箱、讲台、信标等其它容器或功能界面。

`place_block` 支持 `block` 与 `count`（1–64），每次确认目标格出现请求方块且材料
被消耗后才继续。`pillar_up` 支持可选 `block` 与 `height`（1–16）：原地跳起、
向下看并在脚下确认放置，逐块抬高，适合无路可走的洞穴/竖井逃生；材料不足、未在
跳跃顶点提交或服务端拒绝都会返回失败和已确认高度。

`attack` 支持 `target`、可选 `targets`、`count`、`radius`（1–48）、`lethal` 和
`collect`。每刀都要求同一实体掉血或死亡；`lethal=true` 以目标死亡为完成条件，
`collect=true` 会在击杀后确认掉落物进入背包。远距离动物先用 `goto` 接近，避免
只站在原地反复攻击。

### 3.4 世界快照

身体快照包含完整背包（hotbar/main/armor/offhand）、耐久、生命/饥饿、时间、睡眠、
工作台事实、附近方块、可达方块和附近实体。实体同时上报坐标（旧身体可只报距离），
规划器因此能区分“低血时往反方向撤”和“没有方向时只能先攻击”。本体会话还维护
`foodAcquired` / `foodConsumed` / 工作台已合成/已放置等事实，避免食物吃光后
里程碑回退，或重连后重复砍树。终局另有 `dragonDefeated`：只有服务端确认末影龙
死亡后才为 `true`；附近实体列表里没有龙只表示未观测到，不能据此判定通关。

## 4. 队列与任务

```text
queued -> accepted -> running -> completed
                            |-> failed
                            |-> timeout
                            |-> cancelled
```

- 单运行项；其他任务排队。
- 队列有界，满时先拒绝低优先级。
- `idempotencyKey` 支持安全重发。
- 终态不可逆；同 taskId 的旧更新被忽略。
- body 的 ACK 必须返回本次身体会话内唯一的 taskId；协调器在新会话的 ACK 前使用随机会话前缀，避免旧连接的同名任务污染新连接。
- 下发命令的传输异常立即结算为失败；不得留下没有到达身体却持续显示运行中的任务。
- deadline 到期由协调器标 `timeout`。

## 5. 控制权

| 操作 | 效果 |
| --- | --- |
| `takeover` | sticky owner 改为 Operator，取消 Agent 未完成任务 |
| `release` | 显式恢复 Agent，重建 generation |
| `stop` | 释放输入、取消任务、静音相关执行 |
| 断线 / 2s 心跳缺失 | 本地释放按键并取消未完成项 |

sticky owner 跨重连保持，防止断线自动夺权；所有权消息携带 generation，旧消息拒绝。

## 6. 安全与线程

- Mod 收到网络帧后投递到 tick 队列，不直接修改世界。
- 寻路、文件、日志和网络留在非 tick 线程。
- 协议只携带语义 ID、整数坐标、tick 和错误码。
- Reflex 不能被命令关闭；低血量、岩浆、坠落、卡住可抢占行为。
- 正式启动不注入 `SimBody`；测试替身只在自动化测试中使用。

## 7. 本地验收

1. 构建 Fabric 工程：`cd mods/craftmate-body && ./gradlew build`。
2. 将构建产物安装到 Minecraft 1.20.1 / Fabric Loader `≥0.15.11` 实例，并安装 Fabric API 0.92.2+1.20.1。
3. 启动 CraftMate，确认 `/bridge` 显示身体能力。
4. 通过控制台或测试命令触发一个可观察动作。
5. 验证进度、终态、断线释放、接管和急停。

当前真实验收范围见[验证清单](../operations/verification.md#游戏身体)。
