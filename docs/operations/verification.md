# 验证清单

> 本文区分自动化验证、本机真实验收和未验收项。计划与任务跟踪在
> [Issue #32](https://github.com/XiaoFeiASK/CraftMate/issues/32)。

最后核对：2026-11-04，工作区 `main`。

## 1. 自动化基线

```bash
npm install
npm run typecheck
npm test
npm run build
npm run db:check
npm run db:check:file
```

2026-11-03 CI 在 `c0c0562` 通过 Node 类型检查、测试、控制台构建和两种数据库检查。
2026-11-04 开始区分契约目录与 Fabric 当前身体目录：契约 19 个技能，当前身体
10 个技能；`mine_block` 终态要求“开始破坏时记录的同一位置”变为空气，并在结果
中返回方块 ID 和位置证据。

游戏侧单独验证：

```bash
cd mods/craftmate-body
./gradlew build
```

真实身体通道验收（需要 Minecraft 客户端已连接到运行中的 CraftMate）：

```bash
npm run check:bridge
```

该检查等待真实 `mine_block` 完成，并校验结果包含每个目标方块的位置证据。
默认挖 1 个 `minecraft:stone`；可用 `CRAFTMATE_CHECK_BLOCK` 和
`CRAFTMATE_CHECK_COUNT` 覆盖，最多 64 个。

音频播放器单独检查：

```bash
swiftc -typecheck services/voice/src/native/pcm-stream-player.swift
```

CI 不包含真实直播间、真实模型计费、真实音频硬件、Minecraft 图形进程或桌面安装包。

## 2. 状态定义

| 状态 | 判定 |
| --- | --- |
| 已实现 | 仓库命令可复现，或已有本机真实环境证据 |
| 部分 | 主路径存在，但关键环境、终态或长时间行为未验收 |
| 未实现 | 没有运行时代码占位 |

不能把协议测试、模拟身体或供应商返回成功写成游戏结果成功。

## 3. 核心链路

| 链路 | 状态 | 已验证 | 未验收 |
| --- | --- | --- | --- |
| 管理端连接与操作指令 | 已实现 | WebSocket 自动重连、四类操作指令、服务端错误展示 | 长会话与真实直播画面下的操作体验 |
| Orchestrator 持久化 | 已实现 | 迁移、重启恢复、承诺恢复、决策优先级、回放 | 4 小时连续运行 |
| Stage A/B 仲裁 | 已实现 | 注入、冷却、意图、权重、优先级单测 | 真实直播间分布下的阈值调优 |
| Stage C 模型 | 部分 | YYAPI/DeepSeek 真实请求返回计划；坏输出降级有测试 | 长 JSON 稳定性、成本和成功率实播采样 |
| 语音 | 部分 | Seeduplex 真实鉴权、24kHz PCM、约 200ms 首包、一次真实 `spoken` | BlackHole/OBS 路由、首字延迟 P95、长会话 |
| 本机音频 | 部分 | macOS 播放器曾产生 `spoken` | 设备路由；`AudioQueueStart (-66681)` 需现场处理 |

## 4. 抖音评论

**已实现**：dyhub 订阅、事件归一化、10 分钟去重、512 有界队列、每秒上限、指数退避、
健康上报、Orchestrator 自动启停。

**自动化**：本地 dyhub stand-in 覆盖订阅、断线重连、房间关闭、坏输入和洪峰。

**未验收**：

- 真实抖音房间字段，尤其 `gift.repeatCount` / `groupCount`。
- 实播评论延迟、洪峰和封禁/风控行为。

## 5. 游戏身体

**已实现**

- `mods/craftmate-body` 支持 Minecraft 1.21.11 / Fabric Loader 0.20.1。
- HMCL 开发实例进入真实单人世界，连接 Bridge，上报世界快照。
- `mine_block` 命令进入真实 Mod 执行状态机并被接受；完成结果包含同一目标位置
  和开始破坏时的方块 ID。

**未验收**

- 真实环境重复验收 `mine_block`：遮挡、外部移除、方块变更和完整破坏终态。
- 实际移动落点、放置、建造等终态。
- 窗口失焦时 tick 与安全释放。
- 60 分钟和 4 小时稳定性。
- 正式账号、独立存档和 1.2x 其他版本。

`bridge-mcpfabric` 仍只是候选适配声明，未接入运行时。

## 6. 明确不存在

- `services/supervisord`。
- 自动配置的 BlackHole/OBS 集成。
- 抖音开放平台 SDK。
- embedding 或向量库。
- 自动沉淀长期记忆的技能。
- 桌面多平台打包、Fabric 集成测试或发布流水线。

以上出现实现时，必须同步本清单和[架构总览](../reference/architecture.md)。
