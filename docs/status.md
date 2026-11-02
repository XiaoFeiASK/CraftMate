# 实现状态

> 这份文档只回答两件事：**现在能跑什么**，**还差什么**。
> 它是事实清单，不是计划。下一步做什么看 [delivery-plan.md](delivery-plan.md)。

判断标准：标「已实现」的条目必须能在本机用仓库里的命令复现；标「部分」的必须写清
哪一段是假的；标「未实现」的不能有代码占位。

最后核对：2026-11-02（`main`）

## 1. 能跑起来的东西

```bash
npm install
npm run dev        # orchestrator + Vite 管理端
npm run typecheck
npm test
npm run build
npm run db:check
```

桌面窗口需要 Rust / Cargo，当前开发机未安装，所以 Tauri 窗口尚未实际启动验证。

## 2. 分层与当前状态

### 2.1 管理端（`apps/admin-console`）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 启动器式单窗口布局 | 已实现 | 自绘标题栏、分组侧栏、全幅场景、同窗操作抽屉。 |
| 场景主视觉 | 部分 | 静态示意图，不是实时游戏画面。 |
| 实时评论 / 决策流 | 已实现 | 通过 WebSocket 接收 `decision` 与 `snapshot`。 |
| 连接状态与自动重连 | 已实现 | 指数退避，有单测。 |
| 操作员四类指令 | 已实现 | 接管、交还、急停、耳语；急停后需显式交还。 |
| 人格展示 | 部分 | 只显示身份和权重，不能编辑。 |
| 记忆 / 回放 / 设置页 | 未实现 | 只在文档里定义。 |

### 2.2 桌面宿主（`apps/desktop-shell`）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Tauri 2 外壳与窗口配置 | 已实现 | 无边框、1280×800、承载 admin-console 构建产物。 |
| 窗口控制 API | 已实现 | 前端调用 Tauri Window API，非 Tauri 环境降级为无操作。 |
| 本机实际启动 | 未验证 | 缺 Rust / Cargo。 |

### 2.3 控制面（`services/orchestrator`）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| WebSocket 控制服务 | 已实现 | `/control`，`hello` 握手，消息 zod 校验。 |
| 健康检查 | 已实现 | `GET /health`，返回运行统计。 |
| 监听地址可配置 | 已实现 | 默认 `127.0.0.1`；容器需要 `CRAFTMATE_HOST=0.0.0.0`。 |
| 模拟弹幕 | 已实现 | `tools/mock.ts`，脚本化样本，不是真实平台。 |
| 真实抖音接入 | 未实现 | 没有 ingress 服务，没有签名、重连、风控。 |
| 持久化 | 未实现 | 全部状态在内存，重启即丢。 |

### 2.4 契约（`packages/contracts`）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 观众事件 schema | 已实现 | 评论、礼物、点赞、进场、在线人数。 |
| 决策 schema | 已实现 | 意图、决策类型、分数、阶段、理由。 |
| 优先级 schema | 已实现 | 8 级优先级；**尚未进入 `Decision`**，见下方已知缺口。 |
| 控制面消息 | 已实现 | 客户端/服务端消息判别联合，有往返测试。 |
| Bridge 指令与错误码 | 部分 | 只有 schema 和技能名白名单，没有协议实现。 |

### 2.5 Agent 内核（`packages/agent`）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Stage A 规则闸门 | 已实现 | 空消息、注入、冷却、礼物、非指令事件。 |
| Stage B 打分 | 已实现 | 意图置信度 + 人格权重 + 阈值，纯确定性。 |
| 仲裁决策 | 已实现 | 六种决策 + 优先级排序，无模型调用。 |
| 人格结构 | 已实现 | 结构化人格、权重、边界；当前只有「大肥鱼」一个实例。 |
| 承诺账本 | 已实现 | 内存状态机，禁止跳过「说出口」。 |
| 场次编排与运行模式 | 已实现 | agent / operator / stopped 三态。 |
| Stage C 规划与模型 | 未实现 | 没有任何 Provider，也没有生成式回应。 |
| 记忆召回 | 未实现 | 只有 200 条决策的内存环形缓冲。 |

### 2.6 语音（目标：`services/voice`）

未实现。没有 TTS、没有分句、没有音频路由、没有字幕。相关设计见
[technical-design.md](technical-design.md) 第 9 节。

### 2.7 游戏执行（目标：`mods/` + Bridge）

未实现。当前只有 `packages/contracts/src/bridge.ts` 的 schema。没有 Bridge 服务、
没有 Fabric Mod、没有技能执行器。

### 2.8 存储（`db/`）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| v1 schema | 已实现 | `db/migrations/0001_initial.sql`，15 张表（含 FTS 主表）+ 4 个读模型视图。 |
| 约束与视图校验 | 已实现 | `npm run db:check`，内存库与真实 WAL 文件库两种模式。 |
| 迁移执行器 | 未实现 | 没有建库、没有版本写入、没有校验和比对。 |
| 仓储实现 | 未实现 | 没有 SQLite 连接池、没有 Store 实现。 |
| 保留策略执行 | 未实现 | 只有 `raw_expires_at_ms` 字段，没有清理任务。 |

## 3. 已知缺口

按「会不会让下一步做错」排序，不按工作量。

1. **`Decision` 契约缺 `priority`**。DDL 里 `decision_log.priority` 是必填，
   运行时 `Decision` 没有这个字段。M1.1 落库前必须先补契约，不能用默认值糊过去。
2. **`MemoryAudienceStore` 没有上限**。冷却和投票记录只增不减，长直播会缓慢泄漏。
3. **`Show.decisions` 与 `Show.seen` 都是内存**。`seen` 只存 event id，
   重启后无法去重，这正是 M1.1 要解决的。
4. **Bridge schema 没有对应实现**。它现在是「设计意图的编码」，不是可用协议。
5. **管理端没有服务端错误提示**。WebSocket `error` 事件会切到 `error` 状态，
   但服务端下发的 `error` 消息没有界面呈现，只在连接层被忽略。
6. **`db:check` 不是迁移测试**。它验证 schema 本身，不验证「老库升级到新库」。

## 4. 明确不存在的东西

避免接手的人误以为有代码可读：

- 没有 `services/supervisord`、`services/ingress`、`services/voice`。
- 没有 `mods/`，没有 Gradle 工程，没有 Fabric 依赖。
- 没有模型 Provider，没有 embedding，没有向量库。
- 没有 OBS 集成，没有抖音开放平台 SDK。
- 没有 CI 配置，没有发布流水线。

这些东西出现时，本文档对应行必须同步改成「已实现」或「部分」，否则就是文档落后于代码。

## 5. 本地环境

| 依赖 | 是否必需 | 说明 |
| --- | --- | --- |
| Node.js ≥ 22.5 | 必需 | `node:sqlite` 需要；当前引擎下限写进 `package.json`。 |
| Rust / Cargo | 仅桌面宿主 | 没有时 `npm run dev` 仍然可用。 |
| Minecraft + Fabric | 仅游戏执行 | 当前阶段不需要。 |
| OBS / BlackHole | 仅推流 | 当前阶段不需要。 |

SQLite 是嵌入式库，**不需要也不应该**单独跑数据库进程。`npm run db:check:file`
会在 `.tmp-db/` 里建一个真实的 WAL 文件库，校验完连同 `-wal` / `-shm` 一起删除。
