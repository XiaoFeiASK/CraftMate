# 架构总览

> 本文描述系统边界、运行链路和不可妥协的约束。字段与参数见[技术设计](technical-design.md)，运行步骤见[运行手册](../operations/runbook.md)。

## 1. 系统上下文

```text
抖音直播间 → dyhub → Ingress → Orchestrator → Agent → Bridge → Fabric Mod
                                  │           │
                            Admin Console   Voice
                          （遥控 / 展示）  （说话 / 字幕）
                                  │
                               SQLite
```

系统运行在单台 macOS 上。外部输入是抖音事件，外部输出是游戏动作、语音、字幕和管
理端状态；SQLite 是唯一持久化依赖。

## 2. 模块边界

| 模块 | 唯一职责 | 明确不做 |
| --- | --- | --- |
| Ingress | 接收 dyhub，归一化、去重、限流 | 内容判断、模型调用、游戏决策 |
| Agent | 理解意图、仲裁、目标规划、生成技能、维护人格与承诺 | 直接知道 Minecraft API 或直播推流 |
| Orchestrator | 进程装配、控制面、持久化、服务健康 | 拥有领域规则或替代 Agent 决策 |
| Bridge | 游戏协议、有界队列、能力协商、控制权 | 理解观众或决定该不该做 |
| Fabric Mod | tick 内感知、反射、局部寻路、视角与原子动作 | 网络 I/O、模型调用、读取文件 |
| Voice | 分句、调用 TTS、播放、字幕与急停 | 决定说什么 |
| Admin Console | 展示状态、修改配置、发出操作员指令 | 承担运行时关键路径 |

Admin Console 崩溃不中断直播；外部系统故障只降级对应能力，不污染持久化事实。

## 3. 硬约束

1. **tick 线程不做 I/O。** Mod 的网络回调只投递到 tick 队列；寻路和文件、数据库、
   模型访问留在工作线程。协议超时统一使用 tick。
2. **观众文本不是指令。** 弹幕只能作为 JSON 数据进入模型；不能进入系统提示，不能
   修改系统配置，不能声明自己拥有控制权。
3. **先落库，再出声。** 涉及承诺的回应必须先写入承诺账本，再交给 Voice。失败不伪
   装播放，重启后未完成承诺可见。

这三条不因优先级、调试或演示放宽。

## 4. 运行链路

### 4.1 一条评论的一生

1. Ingress 收到事件，校验并归一化为 `AudienceEvent`。
2. Stage A 用纯规则过滤空消息、注入、冷却和非指令事件。
3. Stage B 做确定性意图分类、人格权重打分和优先级排序。
4. 只有胜出意图进入 Stage C，由模型生成回应与技能计划。
5. 涉及说话的承诺先落库；语音开始后更新 `spoken` 状态。
6. 技能必须属于游戏身体声明的能力白名单，才会进入 Bridge 队列。
7. Fabric Mod 执行动作，Bridge 记录 ack、进度、终态；Orchestrator 把同一
   `traceId` 的闸门、仲裁、规划、任务和终态投影为 telemetry，管理端只读这个投影。

### 4.2 目标模式闭环

操作员开启目标模式后，运行链路不再等待评论：

```text
身体快照 → worldFactsFromSnapshot → planSurvival（合法候选）
         → 模型候选排序（可失败回退）→ GoalRuntime → Bridge → Fabric Mod
         → result/changes → settle → 重新观察
```

- `SurvivalGoalPlanner` 决定阶段、前置条件、合法技能和安全候选；模型只能选择
  候选 id，不能直接发明技能或参数。
- 规划器只读取身体已上报的事实；缺失字段保持 `unverified`，不会补造进度。
- 未配置模型、只有一个候选、超时、坏 JSON、未知 id 或预算超限时回退确定性任务。
- 一次只下发一个任务，终态后才继续；完成必须有已确认世界变化。
- 同一移动策略连续失败会换区域重新观察；失败上限只选择最长退避，不永久停掉目标。
- 操作员接管、急停或换目标会取消当前命令，控制权仍按 Bridge sticky owner 规则处理。

详细说明见[自主生存闭环](../operations/autonomy.md)。

### 4.3 三层节奏

```text
Reflex       20–100ms      血量、岩浆、坠落、卡住；可抢占一切
Execution    1–3s          推进当前技能、局部纠错、上报进度
GoalRuntime  终态后         选阶段、恢复失败、改道并重新观察
Showrunner   20–60s+       节目节奏、承诺、人格表达
```

低层不需要理解节目目标，高层不能绕过安全反射。

## 5. 状态机

### 控制权

```text
AGENT --takeover--> OPERATOR --release--> AGENT
  │                                    ▲
  +----------- stop / 断线 ------------> NONE
```

- 三态互斥，sticky owner 跨 Bridge 重连保持。
- 接管取消 Agent 当前动作；急停释放按键、停止任务并静音。
- 显式 release 才恢复 Agent，旧 generation 拒绝。

### Bridge 任务

`queued → accepted → running → completed | failed | timeout | cancelled`。

终态不可逆；取消必须传递到 Mod，断线释放输入并取消未完成项。

### 承诺

`reserved → spoken → fulfilled | failed | expired | retracted`。

状态写入与事件在同一事务；禁止跳过 `spoken`，重启后从开放状态恢复。

## 6. 进程与端口

| 进程 | 地址 | 通道 |
| --- | --- | --- |
| Orchestrator | `127.0.0.1:4321` | `/control`、`/ingress`、`/bridge`、`/health` |
| Ingress | `127.0.0.1:4322` | `/health` |
| Voice | `127.0.0.1:4323` | `/voice`、`/health` |
| Vite | `127.0.0.1:5173` | 开发界面 |

所有服务默认只绑 loopback。Orchestrator、Ingress、Voice 共用 ingress token；
Bridge 使用独立 token。协议消息都经 zod 校验。

管理端首屏和正常操作不请求 `4324`，不加载 MP4 或 MJPEG。

### 6.1 Agent telemetry 契约

`packages/contracts/src/telemetry.ts` 定义管理端可观测事件：

```text
ingress_received → gated/dropped → arbitrated → planned
  → task_queued → task_running/progress → task_settled/failed
  → voice_started/voice_settled
```

另有 `settings_applied` 和 `connection_changed` 两类系统事实。每个事件最多带
`traceId`、`taskId`、`decisionId`、`goalId`、阶段、状态、耗时、脱敏摘要和错误码。
`traceId` 对评论是平台事件 id，对目标任务是 GoalRuntime 生成的 `goal:...`；任务
先以 Bridge command id 入队，收到 ack 后用真实 `taskId` 终态回填。管理端分组时
同时用 `traceId`、`taskId`、`decisionId` 做并查集，所以语音或 Bridge 帧即使只带
task/decision 也会归回同一条评论，而不依赖到达顺序。

控制面在 `/control` 上发送两类消息：

- `event`：单条 append-only 事实，便于低延迟更新；
- `telemetry`：替换整个有界快照（最多 160 条），确保重连和实时视图一致；
- `ready.payload.telemetry`：新连接先拿到同一快照，不依赖补播 socket buffer。

每个事件都经 `AgentTelemetry.record` 的 allow-list 与 zod 校验后写
`agent_event`。摘要由结构化字段拼接；控制面边界不接收 prompt、模型原文、
弹幕原文或 chain-of-thought。Ingress 只上报计数、drop reason、重连次数和
无文本的 `recent` 事实。

管理端对未知值使用 `unknown` / “未上报” / “未接入”，不把缺失指标显示为零。
当前判断只展示后端生成的 `AgentJudgement`（摘要、意图、通用依据、下一步和
置信来源），不从决策原文反推。

## 7. 数据流原则

- 原始评论是可过期证据；决策、动作、承诺、记忆版本保留可解释链路。
- 领域层通过端口访问存储、模型和游戏身体，不直接耦合基础设施。
- 模型失败降级为模板，Bridge 不可用时技能不发命令；两者都写 incident。
- 配置凭据保存在本机文件，API Key 不回传、不入库、不写日志。

## 8. 身体抓流兼容边界

Issue #55 的最终决定是**解除管理端依赖，保留可选录制/调试能力**：

- 管理端已删除 `LiveHero`、`pond-loop.mp4`、poster、`4324` 的 CSP 允许项和
  MJPEG `<img>` 消费；
- `FrameServer` 仍由 `CraftMateBodyClient` 挂在 loopback `4324`，只有
  `FrameDemand` 被录制端请求时才截图，未请求时保持空闲；
- 该端口不参与控制权、liveness、Bridge 命令或首屏；没有它管理端仍完整工作；
- 删除身体侧采集需要先确认没有外部录制/调试消费者，因此不在本次改造中删除。

未来若接入外部录制，应由录制工具显式 opt-in；管理端不应重新把视频作为默认主路径。

## 9. 演进接缝

| 接缝 | 当前实现 | 扩展方式 |
| --- | --- | --- |
| 平台来源 | dyhub → `AudienceEvent` | 新增 Source 实现，不改仲裁 |
| 模型 | OpenAI Compatible Provider | 新增 Provider，不改 Stage A/B |
| TTS | Volcengine Seeduplex | 新增 Voice Provider，不改决策 |
| 游戏身体 | Fabric 1.20.1 compat | 版本差异限制在 Mod compat；协议用语义 ID |
| 存储 | SQLite | 表视图可演进；迁移只向前追加 |

新增能力必须先通过现有契约、回放和降级测试，再扩大运行面。
