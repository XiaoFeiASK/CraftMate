# 实现状态

> 本文只回答两件事：**现在能跑什么**，**还差什么**。是事实清单，不是计划。
> 下一步做什么看 [交付计划](delivery-plan.md)，架构设计看 [架构纵览](architecture.md)。

判定标准：

- **已实现**：能在这台机器上用仓库里的命令复现。
- **部分**：写清哪一段是假的。
- **未实现**：没有代码占位。

最后核对：2026-11-02（工作区，含未提交改动）。

## 1. 能跑起来的东西

```bash
npm install
./start.command    # 桌面窗口 + orchestrator
npm run typecheck
npm test
npm run build
npm run db:check
```

2026-11-02 实测：`npm run typecheck` 通过，`npm test` 23 项全绿，`db:check` 报告
24 个对象 / 17 个索引。桌面窗口需 Rust / Cargo，已在本机实际启动验证。

## 2. 当前状态

### 2.1 管理端 `apps/admin-console`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 启动器式单窗口布局 | 已实现 | 自绘标题栏、分组侧栏、全幅场景、同窗操作抽屉。 |
| 场景主视觉 | 部分 | 静态示意图，不是实时游戏画面。 |
| 实时评论 / 决策流 | 已实现 | 通过 WebSocket 接收 `decision` 与 `snapshot`。 |
| 连接状态与自动重连 | 已实现 | 指数退避，有单测。 |
| 操作员四类指令 | 已实现 | 接管、交还、急停、耳语；急停后需显式交还。 |
| 人格展示 | 部分 | 只显示身份和权重，不能编辑。 |
| 记忆 / 回放 / 设置页 | 未实现 | 只在设计里定义。 |

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
| `/ingress` 通道 | 已实现 | 接受 `hello` / `event` / `health`，并把 `source` 广播给控制台。 |
| 真实抖音接入 | 部分 | `services/ingress` 已有 dyhub 适配、归一化、限流与重连；未接真实房间，无自动化测试。 |
| `/bridge` 通道 | 未实现 | 只有 schema，设计见 [技术设计](technical-design.md)。 |

### 2.4 契约 `packages/contracts`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 观众事件 schema | 已实现 | 评论、礼物、点赞、进场、在线人数。 |
| 决策 schema | 已实现 | 含 `priority` 与可空 `skill`。 |
| 优先级 schema | 已实现 | 8 级枚举，已进入 `Decision`。 |
| 控制面消息 | 已实现 | 客户端/服务端判别联合，有往返测试。 |
| Bridge 指令与错误码 | 部分 | `cmd` / `event` / 错误码 / 动作状态有 schema；`hello` / `ack` / `progress` / `result` / `cancel` 未定义，无实现。 |
| 逐技能参数 schema | 未实现 | `args` 仍是 `record(unknown)`。 |
| 来源健康状态 | 已实现 | `SourceHealth` 进入 `ShowSnapshot`，并有 `source` 消息，契约测试已覆盖。 |

### 2.5 Agent 内核 `packages/agent`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Stage A 规则闸门 | 已实现 | 空消息、注入、冷却、礼物、非指令事件。 |
| Stage B 打分 | 已实现 | 意图置信度 + 人格权重 + 阈值，纯确定性。 |
| 仲裁决策 | 已实现 | 六种决策 + 优先级排序，无模型调用。 |
| 人格结构 | 已实现 | 结构化人格、权重、边界；当前只有「大肥鱼」一个实例。 |
| 承诺账本 | 已实现 | 内存状态机，禁止跳过「说出口」。 |
| 场次编排与运行模式 | 已实现 | `agent` / `operator` / `stopped` 三态。 |
| 持久化写端口 | 已实现 | `ShowRecorder` 端口；先写 source，再仲裁，再写 decision。 |
| Stage C 规划与模型 | 未实现 | 没有任何 Provider，也没有生成式回应。 |
| 记忆召回 | 未实现 | 只有 200 条决策的内存环形缓冲。 |

### 2.6 存储 `packages/storage` + `db/`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| v1 schema | 已实现 | `0001_initial.sql`，15 张表（含 FTS 主表）+ 4 个视图。 |
| 约束与视图校验 | 已实现 | `npm run db:check`，内存库与真实 WAL 文件库两种模式。 |
| 连接与迁移执行器 | 已实现 | WAL、外键、`busy_timeout`；checksum 漂移直接失败。 |
| `SessionStore` / `SourceStore` / `DecisionStore` / `ActionStore` | 已实现 | 启动恢复、事件去重、决策落库、动作幂等。 |
| 存储层自动化测试 | 已实现 | 覆盖事件去重、重启恢复、场次幂等启动三项主路径。 |
| 承诺落库 | 部分 | `commitment` 表已建，`Show` 尚未写承诺状态迁移。 |
| 记忆与待审仓储 | 未实现 | 只有表结构。 |
| 保留策略执行 | 部分 | `SourceStore.expireRawText()` 已实现，没有定时任务调用它。 |

### 2.7 接入端 `services/ingress`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| dyhub 订阅 | 已实现 | 订阅 `/ws?roomId=…&types=…`，事件到达即回调，不是轮询。 |
| 事件归一化 | 已实现 | `chat` / `gift` / `member` / `like` / `room` → `AudienceEvent`；`roomStatus` 转健康状态。 |
| 去重与背压 | 已实现 | 10 分钟内存去重、每秒上限、512 有界队列，礼物与人气优先保留。 |
| 重连与健康 | 已实现 | 指数退避 1s→30s，健康推到 orchestrator，再广播给控制台。 |
| `/health` | 已实现 | `GET :4322/health`，返回源状态、计数、丢弃数、上游连接。 |
| 真实房间联调 | 未实现 | 只用 `tools/fake/dyhub.mjs` 验证过，尚未接 dyhub 实机。 |

### 2.7 接入端 `services/ingress`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| dyhub WebSocket 适配 | 已实现 | 订阅 `/ws`，处理连接状态与重连。 |
| 事件归一化 | 已实现 | `DanmakuEvent → AudienceEvent`，`roomStatus` 转健康状态。 |
| 去重、限流、背压 | 已实现 | 10 分钟进程内窗口、每秒上限、有界队列，丢弃计数。 |
| 上报 `/ingress` | 已实现 | 带 60 秒缓冲，Orchestrator 重启后补发。 |
| 联调桩 | 部分 | `tools/fake/dyhub.mjs` 可手工联调；尚未接入 `npm test`。 |

### 2.8 语音与游戏执行

| 目标 | 状态 | 说明 |
| --- | --- | --- |
| 语音 `services/voice` | 未实现 | 没有 TTS、分句、音频路由、字幕。设计见 [技术设计](technical-design.md) §6。 |
| Bridge 服务 | 未实现 | 只有 `packages/contracts/src/bridge.ts` 的 schema。 |
| Fabric Mod | 未实现 | 没有 `mods/`、没有 Gradle 工程、没有 Fabric 依赖。 |
| OBS / 抖音 SDK | 未实现 | 没有推流集成，没有平台 SDK。 |

## 3. 已知缺口

按「会不会让下一步做错」排序，不按工作量。

1. **承诺还没落库**。`Show` 的承诺只存在内存，重启后 `commitment_open` 为空。
2. **存储层没有测试**。迁移、去重、幂等键都依赖 SQL 约束，当前靠 `db:check` 间接验证。
3. **Ingress 没有自动化测试**。断线、房间关闭、洪峰只靠手工联调，未进 `npm test`。
4. **Bridge 只有一半契约**。缺 `hello` / `ack` / `progress` / `result` / `cancel`，无法表达「已接受 / 执行中 / 已完成 / 超时」。
5. **`Decision.skill` 恒为 `null`**。`EXECUTE` 目前只是标签，没有技能与参数，Bridge 无从下发。
6. **`MemoryAudienceStore` 没有上限**。冷却和投票记录只增不减，长直播会缓慢泄漏。
7. **`Show.seen` 只在内存**。重启后依赖数据库唯一索引去重，但内存层仍会重新消费。
8. **管理端没有服务端错误提示**。`error` 消息在连接层被忽略，界面无呈现。
9. **`db:check` 不是迁移测试**。它验证 schema，不验证「老库升级到新库」。

## 4. 明确不存在的东西

避免接手的人误以为有代码可读：

- 没有 `services/supervisord`、`services/voice`。
- 没有 `mods/`，没有 Gradle 工程，没有 Fabric 依赖。
- 没有模型 Provider，没有 embedding，没有向量库。
- 没有 OBS 集成，没有抖音开放平台 SDK。
- 没有 CI 配置，没有发布流水线。

这些东西出现时，本文对应行必须同步改成「已实现」或「部分」，否则就是文档落后于代码。
