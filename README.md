# CraftMate

用 Agent 玩《我的世界》，把整个过程做成一场可以互动的直播。

观众在直播间发评论，Agent 判断这条评论该不该听、能不能做到，然后真的在游戏里执行，同时用自己的声音回应。它有一个稳定的人格，会记得常来的观众，也会记得自己答应过什么。

```text
观众评论  →  理解意图  →  判断合理性  →  执行动作  →  说话回应
                              ↑                ↓
                          人格与记忆        游戏世界
```

## 核心能力

- **会玩的 Agent**：评论会真的变成游戏里的动作，不是念弹幕的机器人。
- **有性格的角色**：单一人格，可版本化调整；说话和决策都受人格影响。
- **有节奏的直播**：会拒绝、会讨价还价、会记得承诺，不是有求必应的工具。
- **本地桌面程序**：管理端是原生桌面应用，不是浏览器后台。

## 运行形态

| 项 | 选择 |
| --- | --- |
| 游戏 | 《我的世界》Java 版，基线 1.21.11，可切换 1.2x 其他版本 |
| 世界 | 本地单人世界，为直播新建存档 |
| 账号 | 专用游戏账号，由 Agent 直接操作 |
| 直播 | 抖音专用开播号，竖屏 1080×1920 |
| 宿主 | macOS（Apple Silicon），后续适配 Windows |

## 系统一览

```text
┌──────────────── Console（Tauri 桌面端）────────────────┐
│ 直播控制 · 评论队列 · 决策日志 · 人格 · 接入状态         │
└──────────────────────────┬─────────────────────────────┘
                           │ 本机 IPC / WebSocket
┌──────────────────────────▼─────────────────────────────┐
│ Orchestrator（本机进程）                                 │
│ 仲裁 · 承诺 · 持久化 · 控制面                           │
└───┬──────────────┬──────────────┬──────────────────────┘
    │              │              │
 接入端         语音服务        Bridge
 抖音评论       TTS · 字幕      协调器 · 队列
 归一化限流     打断 · 状态      队列 · 看门狗

              Fabric Mod：反射 · 行为 · 寻路 · 相机
```

四个部分的边界：

- **接入端**只把平台事件变成统一格式，不做内容判断，不做游戏决策。
- **执行内核**负责「怎么想」：理解评论、判断合理性、决定节目节奏、维护人格和记忆。它不知道 Minecraft API。
- **Bridge + Fabric Mod** 负责「怎么做」：Bridge 管协议、队列与看门狗，Fabric Mod 管反射、行为、寻路、相机与 HUD。它们不知道观众是谁。
- **语音模块**负责「怎么说」：审查、分句、合成、混音、打断。它不决定说什么。

管理端不参与运行逻辑。它崩了直播继续，它只是操作员的显示器和遥控器。

> 当前已落地管理端、Orchestrator、Ingress、Voice、Bridge 协调器与 Fabric 游戏身体；
> 真实抖音房间、直播画面采集和长时验收仍未完成，详见 [实现状态](docs/status.md)。

## 设计要点

| 主题 | 一句话 |
| --- | --- |
| 三层循环 | 反射层 20–100ms 保安全，执行层 1–3s 推进步骤，导演层 20–60s 管目标与节奏 |
| 评论三段 | Stage A 纯规则闸门、Stage B 分类打分、Stage C 只对胜出意图调用强模型 |
| 六种决策 | 忽略、观察、口头回应、排队、立即执行、拒绝 |
| 先说话后执行 | 1 秒内先给观众反馈，动作在后台推进，不让观众等结果 |
| 先落库再出声 | 承诺先记录再说出口，超时要解释，不能当没说过 |
| 人格与记忆 | 人格是版本化结构，`weights` 真正进入仲裁；原始评论是证据，不是指令 |

默认角色是社区二创的「大肥鱼」，设定、音色与授权边界见 [技术设计](docs/technical-design.md) 的人格与语音章节。

## 现在到哪了

当前已落地：启动器式管理端、Tauri 桌面宿主、本机 WebSocket 控制面、确定性的 Stage A/B 仲裁、人格与承诺状态机、SQLite 持久化、可编辑并脱敏保存的服务配置、抖音评论 Ingress、带鉴权的 Voice 服务，以及 Bridge 协议、协调器与有界队列。

DeepSeek、豆包 Seeduplex 实时语音与 Fabric 游戏身体已接入本机主流程。Seeduplex
已产生真实音频与 `spoken` 事件，当前机器的 macOS 音频输出也曾返回
`AudioQueueStart failed (-66681)`。真实抖音房间、直播画面采集、方块最终删除和
长时验收仍待完成。逐项事实以
[实现状态](docs/status.md) 为准。

## 快速开始

```bash
npm install
./start.command          # 桌面窗口 + Orchestrator + Voice
./start.command --web    # 浏览器预览 + Orchestrator + Voice
./stop.command           # 结束本项目的全部本地开发进程
npm run dev              # 跳过环境检查，直接启动
```

服务配置在管理端「设置 → 接入」中填写。API Key 保存到本机
`~/.craftmate/integrations.json`（权限 `0600`），设置接口不会回传明文。

验证：

```bash
npm run typecheck
npm test
npm run build
npm run db:check
npm run db:check:file
```

桌面窗口需要 Rust / Cargo；没有时用 `./start.command --web`。完整环境、端口、数据库位置与排错见 [本地开发](docs/local-setup.md)。

## 仓库结构

```text
craftmate/
├─ apps/
│  ├─ admin-console/     React 管理端
│  └─ desktop-shell/     Tauri 2 桌面宿主
├─ services/
│  ├─ orchestrator/      本机 WebSocket 控制面、持久化与运行时入口
│  ├─ ingress/           抖音评论接入、归一化与限流
│  └─ voice/             分句、TTS 队列、字幕与播放
├─ packages/
│  ├─ contracts/         观众、决策、控制面、Ingress、Voice 与 Bridge 契约
│  ├─ agent/             Agent 领域、Stage C 规划、场次编排与端口
│  ├─ storage/           SQLite 连接、迁移与 Store
│  ├─ bridge/            Bridge 协调器、队列与 WS 适配
│  ├─ bridge-mcpfabric/  MCPFabric 技能映射与安全握手
│  └─ local-auth/        本机共享 token 与 loopback 校验
├─ db/                   schema 与迁移
├─ tools/                开发与维护脚本
├─ docs/                 架构、技术细节、计划与状态
├─ licenses/             MIT 与 Apache-2.0 全文
├─ start.command         一键启动本机开发环境
└─ stop.command          一键停止本机开发环境
```

`services/supervisord/` 仍属于目标态；`mods/craftmate-body/` 是当前真实的
Fabric 1.21.11 游戏身体。

## 文档地图

先看这张表，再决定读哪一篇。

| 文档 | 回答什么问题 |
| --- | --- |
| [架构纵览](docs/architecture.md) | 系统怎么分层、边界在哪、哪些不变量不能破 |
| [技术设计](docs/technical-design.md) | 协议、参数、状态机、人格、记忆、存储的细节 |
| [外部接入](docs/integration.md) | 抖音评论与游戏身体怎么接，为什么选 dyhub / mcpfabric |
| [Bridge 执行通道](docs/bridge.md) | `/bridge` 协议、队列、安全边界与真机约束 |
| [Bridge 运行报告](docs/bridge-run-report.md) | Bridge 的验证范围、阻塞项与验收结论 |
| [功能更新计划](docs/delivery-plan.md) | 核心互动流程与近期工作 |
| [实现状态](docs/status.md) | 现在能跑什么、哪些是部分实现、还缺什么 |
| [本地开发](docs/local-setup.md) | 怎么启动、怎么验证、常见问题 |
| [技术选型](docs/tech-stack.md) | 为什么用 TS / Tauri / Java，而不是 Python / Go / Electron |
| [决策记录](docs/decisions.md) | 已拍板的技术决策、后果与重新评估条件 |
| [术语表](GLOSSARY.md) | 场次、仲裁、承诺、证据等词的精确定义 |
| [数据库约定](db/README.md) | 迁移、幂等、保留策略与 schema 校验 |

三条推荐阅读路径：

1. **第一次接触**：README → 架构纵览 → 技术设计 §1「关键参数」→ 实现状态。
2. **准备动手**：本地开发 → 实现状态 → 交付计划的当前里程碑。
3. **接外部系统**：外部接入 → Bridge 执行通道 → 技术设计 §2「本机协议」→ 决策记录。

## 参考与许可

记忆模型、注意力策略与流水线设计参考了以下开源项目，代码均为独立实现：

- [PowerContext](https://github.com/oceanbase/powercontext)（Apache-2.0）：证据与记忆分离、版本化、待审队列、召回预算。
- [SeekMemory](https://github.com/NeverENG/SeekMemory)（MIT / Apache-2.0）：注意力闸门、后续回复窗口、取消语义、人格版本链。
- [AstrBot](https://github.com/AstrBotDevs/AstrBot)（AGPL-3.0）：仅参考阶段编排与策略选择器结构，不引用其代码。
- [dafeiyu-astrbot](https://github.com/whyever77/dafeiyu-astrbot)（MIT）：大肥鱼社区人格的性格参考。

项目采用 MIT OR Apache-2.0 双许可，可任选其一。完整文本见 [licenses/](licenses/README.md)。
