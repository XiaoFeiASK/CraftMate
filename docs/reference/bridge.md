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
不等模型：Mod 每刻检查岩浆、低血、坠落、溺水、着火、饥饿和近身苦力怕，命中后
先松开按键、停止挖掘，再发一条事件。

```json
{ "type": "event", "seq": 0, "tick": 0, "name": "reflex",
  "data": { "kind": "lava", "detail": "站在岩浆里或离岩浆只有一格", "health": 4 } }
```

- 协调器收到后把在跑和排队中的 Agent 任务全部判 `failed`，错误码
  `E_PRECONDITION`，原因写成 `safety: <detail>`，并给身体发 `cancel`。
- 只有 `owner=agent` 时才这么处理。Operator 接管期间，身体不能借"安全"名义
  取消操作员的任务。
- 事件同时留在 `BridgeHealth.incidents`（最近 24 条）里，控制台直接显示。
- 名字用普通字符串，老版本协调器遇到未知名字只忽略，不会断开连接。

反射只做"松手 + 原生逃生"（岩浆里跳一下、水下上浮），不自己选安全点。去哪、
接下来做什么归 Agent；反射层不发明路线，避免把角色带下悬崖。

命令契约定义在 `packages/contracts/src/skills.ts` 与 `bridge.ts`。契约目录保留
19 个技能作为未来扩展面；当前 Fabric 身体实际支持的能力和技能以
`FABRIC_BODY_CAPABILITIES` / `FABRIC_BODY_SKILLS` 为准。未知技能、非法参数和未
声明的能力不会下发。未在真实身体清单中的技能只能作为 roadmap，不得写成现有
产品能力。

当前 Fabric 身体声明 14 个技能。`craft` 的参数为 `item` 与可选 `count`（1–64，
默认 1）。它优先走到 16 格内最近的工作台（无工作台时使用背包 2×2 网格），
通过原版配方书让服务端放入单批材料，再取走结果；只有取走前结果槽确有目标
物品、且稳定后主背包增加了同一批数量时才确认。`count` 大于单批产量时会重复
提交配方，实际产量可能因配方一次产出多件而略高于请求数。没有可达配方、
材料不足、满包、界面未打开或结果未出现都会返回 `E_PRECONDITION` 和已确认
数量。当前不含熔炉、高炉、烟熏炉、切石机等非合成台配方。`deposit` 的参数为
可选的 `container`
（整数方块坐标）与可选的 `item`；不传 `item` 时只转移非损坏物品，并跳过工具
和装备。容器结果必须以背包减少量与容器增加量逐项相等为确认依据。当前只
覆盖 `BaseContainerBlockEntity` 的存储菜单，不含末影箱、讲台、信标等其它
容器或功能界面。

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
2. 将构建产物安装到 Minecraft 1.21.11 / Fabric 0.20.1 实例。
3. 启动 CraftMate，确认 `/bridge` 显示身体能力。
4. 通过控制台或测试命令触发一个可观察动作。
5. 验证进度、终态、断线释放、接管和急停。

当前真实验收范围见[验证清单](../operations/verification.md#游戏身体)。
