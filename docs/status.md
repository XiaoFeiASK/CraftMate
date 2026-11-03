# 实现状态

> 本文只回答两件事：**现在能跑什么**，**还差什么**。是事实清单，不是计划。
> 下一步做什么看 [交付计划](delivery-plan.md)，架构设计看 [架构纵览](architecture.md)。

判定标准：

- **已实现**：能在这台机器上用仓库里的命令复现。
- **部分**：写清哪一段是假的。
- **未实现**：没有代码占位。

最后核对：2026-11-03（合并方向 A / B / C 的 M1–M2 切片）。

## 1. 能跑起来的东西

```bash
npm install
./start.command    # 桌面窗口 + orchestrator
npm run typecheck
npm test
npm run build
npm run db:check
```

2026-11-03 实测：`npm run typecheck`、`npm test`、`npm run build`、
`db:check` / `db:check:file`（合并 A 的保留审计后为 26 个对象 / 19 个索引）通过。
桌面窗口需 Rust / Cargo，已在本机实际启动验证。

方向 B 补充：Orchestrator + Voice 已用真实进程联调（fake TTS / 仅字幕模式），
控制台能看到说话状态、字幕与急停取消；真实 TTS 供应商与 BlackHole / OBS 路由
尚未联调。

## 2. 当前状态

### 2.1 管理端 `apps/admin-console`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 启动器式单窗口布局 | 已实现 | 自绘标题栏、分组侧栏、全幅场景、同窗操作抽屉。 |
| 场景主视觉 | 部分 | 循环池塘视频占位，不是实时游戏画面；开启「减弱动态」时只显示封面帧。 |
| 实时评论 / 决策流 | 已实现 | 通过 WebSocket 接收 `decision` 与 `snapshot`。 |
| 连接状态与自动重连 | 已实现 | 指数退避，有单测。 |
| 操作员四类指令 | 已实现 | 接管、交还、急停、耳语；急停后需显式交还。 |
| 直播资料设置 | 已实现 | 主线、进度、世界、版本、账号、接入参数与人格权重可编辑；写入 SQLite，重启恢复。 |
| 界面偏好 | 已实现 | 主题（跟随系统 / 浅 / 深）、字号、强调色、减弱动效；存本机 `localStorage`，即时生效。 |
| 人格展示 | 已实现 | 展示身份、语气、价值观、边界、音色与权重条；权重修改会进入仲裁。 |
| 记忆 / 回放 | 未实现 | 只在设计里定义。 |

### 2.2 桌面宿主 `apps/desktop-shell`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Tauri 2 外壳与窗口配置 | 已实现 | 无边框、1280×800，承载 admin-console 构建产物。 |
| 窗口控制 API | 已实现 | 前端调用 Tauri Window API，非 Tauri 环境降级为无操作。 |
| 本机实际启动 | 已实现 | macOS 窗口可启动并连上 Orchestrator。 |

### 2.3 控制面 `services/orchestrator`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| WebSocket 控制服务 | 已实现 | `/control`，`hello` 握手，消息 zod 校验。 |
| 健康检查 | 已实现 | `GET /health`，返回运行统计。 |
| 监听地址与端口 | 已实现 | 默认 `127.0.0.1:4321`，`CRAFTMATE_HOST` / `CRAFTMATE_PORT` 可覆盖。 |
| 启动时接入 SQLite | 已实现 | `createPersistentShow()` 建库、跑迁移、恢复最近决策。 |
| 模拟弹幕 | 已实现 | `tools/mock.ts`，脚本化样本，不是真实平台。 |
| `/ingress` 通道 | 已实现 | 只接受 loopback + 共享 token；`hello` 后才收 `event` / `health`，失败会明确关闭并记日志。 |
| 真实抖音接入 | 部分 | `services/ingress` 已有 dyhub 适配、归一化、限流与重连；用 fake dyhub 覆盖断线、房间关闭、坏输入与洪峰，尚未接真实房间。 |
| `/bridge` 通道 | 部分 | 协调器、队列、模拟身体与 WebSocket 适配已实现；尚未接入 Orchestrator 的 upgrade 路由与真实 Fabric Mod。 |

### 2.4 契约 `packages/contracts`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 观众事件 schema | 已实现 | 评论、礼物、点赞、进场、在线人数。 |
| 决策 schema | 已实现 | 含 `priority` 与可空 `skill`。 |
| 优先级 schema | 已实现 | 8 级枚举，已进入 `Decision`。 |
| 控制面消息 | 已实现 | 客户端/服务端判别联合，有往返测试。 |
| Bridge 指令与错误码 | 部分 | `cmd` / `event` / 错误码 / 动作状态有 schema；`hello` / `ack` / `progress` / `result` / `cancel` 未定义，无实现。 |
| Bridge v1 完整帧 | 已实现 | `hello` / `welcome` / `ack` / `progress` / `result` / `cancel` / 心跳 / 所有权，含 schema 与往返测试。 |
| 逐技能参数 schema | 未实现 | `args` 仍是 `record(unknown)`。 |
| 来源健康状态 | 已实现 | `SourceHealth` 进入 `ShowSnapshot`，并有 `source` 消息，契约测试已覆盖。 |
| Voice 契约 | 已实现 | 统一 `VoiceUtterance` / `VoiceEvent` / `VoiceStatus`，字幕与语音共用同一文本。 |

### 2.5 Agent 内核 `packages/agent`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Stage A 规则闸门 | 已实现 | 空消息、注入、冷却、礼物、非指令事件。 |
| Stage B 打分 | 已实现 | 意图置信度 + 人格权重 + 阈值，纯确定性。 |
| 仲裁决策 | 已实现 | 六种决策 + 优先级排序，无模型调用。 |
| 人格结构 | 已实现 | 结构化人格、权重、边界；当前只有「大肥鱼」一个实例。 |
| 承诺账本 | 已实现 | 状态机禁止跳过「说出口」；写端口先落库再更新内存，启动时恢复未完成承诺。 |
| 场次编排与运行模式 | 已实现 | `agent` / `operator` / `stopped` 三态。 |
| 持久化写端口 | 已实现 | `ShowRecorder` 端口；先写 source，再仲裁，再写 decision。 |
| Stage C 规划与模型 | 未实现 | 没有任何 Provider，也没有生成式回应。 |
| 记忆召回 | 未实现 | 只有 200 条决策的内存环形缓冲。 |

### 2.6 存储 `packages/storage` + `db/`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| v1 schema | 已实现 | `0001`–`0004`，16 张表（含 FTS 主表与保留审计）+ 4 个视图。 |
| 约束与视图校验 | 已实现 | `npm run db:check`，内存库与真实 WAL 文件库两种模式。 |
| 连接与迁移执行器 | 已实现 | WAL、外键、`busy_timeout`；checksum 漂移直接失败。 |
| `SessionStore` / `SourceStore` / `DecisionStore` / `ActionStore` / `SettingsStore` / `CommitmentStore` | 已实现 | 启动恢复、事件去重、决策落库、动作幂等、按场次保存配置、承诺状态迁移。 |
| 存储层自动化测试 | 已实现 | 覆盖去重、重启恢复、承诺恢复与非法迁移、保留审计、空库/升级/checksum 漂移。 |
| 承诺落库 | 已实现 | `reserve → spoken → …` 在同一事务写状态和事件；重启由 `commitment_open` 恢复。 |
| 记忆与待审仓储 | 未实现 | 只有表结构。 |
| 保留策略执行 | 已实现 | Orchestrator 启动时先清一轮，之后每小时按批清理；原文置空、哈希保留、逐条写审计。 |

### 2.7 接入端 `services/ingress`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| dyhub 订阅 | 已实现 | 订阅 `/ws?roomId=…&types=…`，事件到达即回调，不是轮询。 |
| 事件归一化 | 已实现 | `chat` / `gift` / `member` / `like` / `room` → `AudienceEvent`；`roomStatus` 转健康状态。 |
| 去重与背压 | 已实现 | 10 分钟内存去重、每秒上限、512 有界队列，礼物与人气优先保留。 |
| 重连与健康 | 已实现 | 指数退避 1s→30s，健康推到 orchestrator，再广播给控制台。 |
| `/health` | 已实现 | `GET :4322/health`，返回源状态、计数、丢弃数、上游连接。 |
| 真实房间联调 | 未实现 | 只用 `tools/fake/dyhub.mjs` 验证过，尚未接 dyhub 实机。 |

### 2.8 语音与游戏执行

| 目标 | 状态 | 说明 |
| --- | --- | --- |
| 语音 `services/voice` | 部分 | 有分句、有界优先级队列、短句边界抢占、急停、主备 TTS、熔断、字幕与状态上报；真实 TTS 供应商和音频路由尚未联调。 |
| 决策自动说话 | 未实现 | 需要方向 A 的 Stage C 生成可播文本；当前 Voice 只接操作员试听与显式命令，不自行编造回复。 |
| Bridge 服务 | 部分 | 协议、协调器、模拟身体与 WS 适配已实现；真实游戏端未接入。 |
| Bridge 协调器与队列 | 已实现 | `packages/bridge`：有界队列、幂等、终态、接管/急停、500ms 看门狗、WebSocket 适配。 |
| Bridge 模拟身体 | 已实现 | `SimBody` 与 `npm run dev:bridge` / `bridge:smoke` / `bridge:long-run`。 |
| Fabric Mod | 未实现 | 没有 `mods/`、没有 Gradle 工程、没有 Fabric 依赖。 |
| MCPFabric 适配清单 | 部分 | `packages/bridge-mcpfabric` 有技能映射与安全握手校验；未连接真实 mcpfabric。 |
| OBS / 抖音 SDK | 未实现 | 没有推流集成，没有平台 SDK。 |

## 3. 已知缺口

按「会不会让下一步做错」排序，不按工作量。

1. **Ingress 只对 fake dyhub 验证过**。断线、房间关闭、洪峰已有自动化测试，但真实房间的字段映射仍未校准。
2. **Bridge 未接真实身体**。协议、模拟身体、队列与看门狗已实现；`/bridge` 尚未由 B 的 HTTP upgrade 路由装配，Fabric Mod 与 mcpfabric 未接入。
3. **`Decision.skill` 恒为 `null`**。`EXECUTE` 目前只是标签，没有技能与参数，Bridge 无从下发。
4. **决策自动说话未接通**。承诺账本已可持久化，但还没有 Stage C 生成可播文本；Voice 目前只接操作员试听/显式命令。
5. **真实 TTS 与音频路由未联调**。Voice 只验证到 fake TTS / 仅字幕模式的真实进程链路。
6. **M4 运营界面未实现**。记忆审核、人格版本对比/回滚、按场次/traceId 回放时间轴仍未落地。

方向 A 的 M1 代码项已闭合：承诺恢复、去重收敛（内存 2000 条快速路径 + 数据库裁决）、
有界观众历史（500 人 / 每意图 200 样本）、保留清理与审计、迁移升级测试。**M1 出口
仍需环境验收**：真实 `~/.craftmate/craftmate.db` 的升级副本、桌面端重启联调，以及
由 B 提供发声链路后才能验证「开口前已落库」。

## 4. 明确不存在的东西

避免接手的人误以为有代码可读：

- 没有 `services/supervisord`。
- 没有真实 TTS 供应商凭据，也没有自动配置 BlackHole / OBS。
- 没有 `mods/`，没有 Gradle 工程，没有 Fabric 依赖。
- 没有模型 Provider，没有 embedding，没有向量库。
- 没有 OBS 集成，没有抖音开放平台 SDK。
- 没有 CI 配置，没有发布流水线。

这些东西出现时，本文对应行必须同步改成「已实现」或「部分」，否则就是文档落后于代码。
