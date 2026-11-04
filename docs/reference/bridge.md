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

命令契约定义在 `packages/contracts/src/skills.ts` 与 `bridge.ts`。参数 schema 覆盖
19 个技能；未知技能、非法参数和不声明的能力不会下发。

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
