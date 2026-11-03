# Bridge 执行通道

> 本文说明游戏身体的协议、状态机、安全边界与当前验证程度。
> 真机与长时验收记录见 [运行报告](bridge-run-report.md)。
> 接入位置与权限分工见 [外部接入](integration.md) §3–4。

## 1. 边界

Bridge 只做三件事：把已校验的技能命令送到游戏、把真实进度和结果带回、在失控时让身体自己停下。

- **不做决策**：Orchestrator 选技能，Bridge 不重新解释观众意图。
- **不做路由装配**：Orchestrator 拥有 HTTP server 与 `/control`、`/ingress`；Bridge 提供 `createBridgeUpgrade()`，由 Orchestrator 在 upgrade 路由中挂载。
- **不直接写数据库**：动作通过 `ActionPort` 记账，生产适配器复用 A 的 `action_attempt`。

```text
Orchestrator ──SkillCommand──► BodySession ──WS /bridge──► SimBody / Minecraft Mod
     ▲                              │                              │
     └──── progress / result ◄─────┴──── cancel / watchdog ◄──────┘
```

## 2. Wire 协议 v1

所有帧都有 `v: 1`，以 `type` 判别。完整 schema 在 `packages/contracts/src/bridge.ts`。

| 方向 | 帧 | 用途 |
| --- | --- | --- |
| body → host | `hello` | 独立 token、客户端名、能力与技能清单 |
| host → body | `welcome` | 协商结果、心跳间隔、看门狗窗口 |
| host → body | `cmd` | 技能、参数、优先级、deadlineTick、幂等键 |
| body → host | `ack` | 接受/拒绝、身体生成的 taskId、错误码 |
| body → host | `progress` | 阶段、完成数、总片数与 tick |
| body → host | `result` | 唯一终态、耗时 tick、错误码与结果数据 |
| host → body | `cancel` | 按 taskId 取消；服务端发出不等于身体已停 |
| body → host | `event` | 世界事件，带 seq 与 tick |
| 双向 | `ownership` | `agent` / `operator` / `none` 三态 |
| 双向 | `heartbeat` | 存活与当前 tick；缺 500ms 触发本地停止 |

约定：

- `deadlineTick` 是绝对游戏 tick，不是相对毫秒。
- `idempotencyKey` 是副作用唯一键；重复到达不得再次执行。
- `taskId` 由身体生成，服务端在 `ack` 后采纳；排队超时的命令若迟到 ACK，服务端立即回 `cancel`。
- 终态为 `completed / preempted / cancelled / failed / timeout`，首个终态获胜。
- 非法帧以 `E_SCHEMA` 拒绝并关闭连接；forge token 以 4401 关闭，且不进入 agent 所有权。

## 3. 队列与控制权

- 队列有界（默认 32）。满时高优先级可以淘汰最低优先级的**排队项**，绝不淘汰运行项。
- 同时最多一个运行项；运行项只能由显式取消、终态或看门狗结束。
- `takeOver` 取消运行项并保留排队项；`emergencyStop` 取消所有项并进入 `none`；`release` 恢复 `agent` 并重新泵队列。
- 断线 500ms：身体本地释放按键、停止任务、进入 `none`。服务端同时取消在途与排队动作。

## 4. 安全

- token 独立于 `/control` / `/ingress`，默认写入 `~/.craftmate/bridge.token`，权限 `0600`。
- 端口默认仅 loopback；`hello` 必须首先完成，token 使用常量时间比较。
- 技能必须在 `hello.skills` 中声明，否则在服务端直接 `E_UNKNOWN_OP`，不发给身体。
- MCPFabric 只做适配器：危险工具组 `run_command` / `set_block` / UI 控制必须关闭；映射强度见 `packages/bridge-mcpfabric`，弱项不能当作已验证技能。
- 协议不包含 NBT、Java 类名或字段名，只有语义 ID、整数坐标与 tick。

## 5. 线程模型（真机约束）

Mod 侧必须遵守：

1. WebSocket 回调只投递队列，不改世界。
2. tick 线程消费队列，不做网络、磁盘或数据库 I/O。
3. 寻路在 worker 线程基于快照计算，结果回 tick 线程校验后提交。
4. 本地看门狗不依赖服务端，独立于网络回调运行。

`SimBody` 的 `scheduler` 注入边界对应这四点；真机 Mod 仍需逐条实测。

## 6. 启动

```bash
npm run dev:bridge          # fake body，默认 ws://127.0.0.1:4323/bridge
npm run bridge:smoke        # 连接 fake body 并跑一轮 mine_block
npm run bridge:long-run     # 默认 30 秒虚拟时钟采样
```

`npm run dev:bridge` 与 `services/voice` 的默认端口都是 `4323`，同时启动时需显式错开：

```bash
BRIDGE_PORT=4391 npm run dev:bridge
BRIDGE_PORT=4391 npm run bridge:smoke
```

当前 fake body 自带 `/health`，返回连接、所有权、队列深度与看门狗窗口。
它只验证协议与协调器，不代表真实 Minecraft 身体可用；真机步骤与阻塞项见 [运行报告](bridge-run-report.md)。
