<p align="center">
  <img src="docs/assets/craftmate-icon.png" width="112" alt="大肥鱼图标">
</p>

<h1 align="center">CraftMate</h1>

<hr>

<p align="center">
  <strong>用 Agent 玩《我的世界》，把整个过程做成一场可以互动的直播。</strong>
</p>

观众在直播间发评论，Agent 判断这条评论该不该听、能不能做到，然后真的在游戏里执行，
同时用自己的声音回应。它有一个稳定的人格，会记得常来的观众，也会记得自己答应过什么。
操作员随时可以接管、交还或急停。

```text
观众评论  →  理解意图  →  判断合理性  →  执行动作  →  说话回应
                              ↑                ↓
                          人格与记忆        游戏世界
```

## 核心能力

- **会玩的 Agent**：评论会经过三段仲裁，只有可行、合人格的动作才会进入游戏身体。
- **可持续的目标模式**：确定性生存规划器按身体事实选择阶段和技能，一次只推进
  一个可验证任务；失败会退避、改道并重新观察，而不是停在原地。
- **有性格的角色**：单一人格「大肥鱼」，权重会真正进入决策；版本可回滚。
- **有节奏的直播**：会拒绝、会先回应再执行、会记得承诺，不是有求必应的工具。
- **本机桌面控制台**：管理端是 Tauri 桌面程序，只做展示、配置和遥控。

## 运行形态

| 项 | 当前选择 |
| --- | --- |
| 游戏 | 《我的世界》Java 版 1.20.1 + Fabric Loader ≥0.15.11 + Fabric API 0.92.2 |
| 世界 | 本地单人世界，直播使用专用存档 |
| 直播 | 抖音，通过本机 dyhub sidecar 接入评论 |
| 模型 | DeepSeek / OpenAI 兼容接口 |
| 语音 | 豆包 Seeduplex 端到端实时语音 |
| 宿主 | macOS（Apple Silicon），后续适配 Windows |

## 系统一览

```text
┌──────────────── Console（Tauri 桌面端）────────────────┐
│ 直播控制 · 评论队列 · 决策日志 · 人格 · 接入状态        │
└──────────────────────────┬─────────────────────────────┘
                           │ 本机 WebSocket
┌──────────────────────────▼─────────────────────────────┐
│ Orchestrator（本机进程）                                │
│ 仲裁 · 规划 · 承诺 · 持久化 · 控制面                    │
└───┬──────────────┬──────────────┬──────────────────────┘
    │              │              │
 Ingress         Voice          Bridge
 抖音评论       Seeduplex      协调器 · 队列
 归一化限流     TTS · 字幕      看门狗 · 控制权

           Fabric Mod：感知 · 行为 · 原子操作
```

四个部分的边界：

- **接入端**只把平台事件变成统一格式，不做内容判断，不做游戏决策。
- **执行内核**负责「怎么想」：理解评论、判断合理性、生成计划、维护人格和记忆。
  它不知道 Minecraft API。
- **Bridge + Fabric Mod** 负责「怎么做」：Bridge 管协议、队列与看门狗，Mod 管感知、
  行为和原子操作。它们不知道观众是谁。
- **语音模块**负责「怎么说」：分句、合成、播放和打断。它不决定说什么。

管理端不参与运行逻辑。它崩了直播继续，它只是操作员的显示器和遥控器。

## 设计要点

| 主题 | 说明 |
| --- | --- |
| 三层循环 | 反射层保安全，执行层推进动作，导演层管理目标与节目节奏 |
| 评论三段 | Stage A 纯规则闸门、Stage B 分类打分、Stage C 只对胜出意图调用模型 |
| 六种决策 | 忽略、观察、口头回应、排队、立即执行、拒绝 |
| 先落库再出声 | 承诺先记录再说出口；播放失败如实上报，不能当没说过 |
| 人格与记忆 | 人格是版本化结构，`weights` 进入仲裁；原始评论是证据，不是指令 |
| 游戏安全 | 技能必须在能力白名单内；控制权跨重连保持，急停必须显式交还 |

默认角色是社区二创的「大肥鱼」。人格、外部接入与授权边界见
[外部集成](docs/guides/integrations.md)和[技术设计](docs/reference/technical-design.md)。

## 现在到哪了

最后核对：2026-11-06。

**已经落地**

- 启动器式管理端、Tauri 桌面宿主、本机 WebSocket 控制面。
- 确定性 Stage A/B、Stage C 规划与模板降级、人格权重、承诺状态机、记忆召回。
- SQLite 持久化、重启恢复、决策回放、保留清理、模型成本预算。
- 目标模式 `GoalRuntime`：九个生存阶段、身体事实驱动的确定性规划、幂等命令、
  终态证据校验、失败退避和改道重观察。
- dyhub 评论接入、归一化、去重、背压与健康上报。
- 豆包 Seeduplex 实时语音、字幕、抢占和失败上报。
- Bridge 协议、队列、幂等、控制权、看门狗，以及真实 Fabric 1.20.1 身体。
- 真实 1.20.1 存档中已验证连续 A* 路径、挖方块、吃食物、楼梯脱困、战斗、自动
  垫桥和空闲游走；技能结果以世界变化而不是 API 返回值确认。

**还没有闭环**

- 真实抖音房间字段、洪峰和风控行为未验收。
- Seeduplex 已产生真实 PCM，但 BlackHole/OBS 路由和实播音频延迟未验收。
- 床、熔炉、铁器、下界、要塞、末地和击败末影龙的真实存活链路未验收。
- 目标模式目前使用确定性规划器，不调用大模型；模型额度不变不代表 Agent 没在
  执行。真实供应商、模型驱动目标和长时间直播仍分别验收。
- 60 分钟 / 4 小时稳定性、真实直播画面和独立发布存档未验收。

逐项事实见[验证清单](docs/operations/verification.md)；当前目标仍跟踪
[Issue #32](https://github.com/XiaoFeiASK/CraftMate/issues/32)。

## 快速开始

```bash
node -v           # 需要 v22.5+
npm install
./start.command          # 桌面窗口 + Orchestrator + Voice
./start.command --web    # 浏览器预览 + Orchestrator + Voice
./stop.command           # 结束本项目的本地开发进程
npm run dev              # 跳过环境检查，直接启动
```

在管理端「设置 → 接入」填写模型、语音、抖音和游戏配置。凭据保存到本机
`~/.craftmate/integrations.json`（权限 `0600`），控制面不会回传明文。
「设置 → 目标模式」默认关闭；开启后由目标运行时一次下达一个任务，评论先进入
「观众提议」收件箱，经过安全、目标和执行三层闸门。未验证的里程碑显示
`unverified`，不显示手工百分比。目标运行时使用 `planSurvival` 从身体上报的
世界事实重新规划；没有身体或世界证据时不会补造进度。

验证：

```bash
npm run typecheck
npm test
npm run build
npm run db:check
npm run db:check:file
```

构建游戏身体：

```bash
cd mods/craftmate-body
./gradlew build
```

桌面窗口需要 Rust / Cargo；没有时用 `./start.command --web`。完整环境、端口、数据库
位置与排错见[运行手册](docs/operations/runbook.md)。

## 仓库结构

```text
craftmate/
├─ apps/
│  ├─ admin-console/      React 管理端
│  └─ desktop-shell/      Tauri 2 桌面宿主
├─ services/
│  ├─ orchestrator/       本机控制面、持久化装配与运行时入口
│  ├─ ingress/            抖音评论接入、归一化与限流
│  └─ voice/              分句、实时语音、字幕与播放
├─ packages/
│  ├─ contracts/          观众、决策、控制面、Ingress、Voice 与 Bridge 契约
│  ├─ agent/              Agent 领域、规划、人格、承诺与端口
│  ├─ storage/            SQLite 连接、迁移与 Store
│  ├─ bridge/             Bridge 协调器、队列与 WS 适配
│  ├─ bridge-mcpfabric/   MCPFabric 候选映射
│  ├─ local-auth/         本机共享 token 与 loopback 校验
│  └─ local-config/       本机凭据配置
├─ db/                    schema 与迁移
├─ mods/craftmate-body/   Fabric 1.20.1 客户端 Mod
├─ tools/                 开发、环境加载与 schema 校验脚本
├─ docs/                  按功能分类的架构、运行、集成与验收文档
├─ licenses/              MIT 与 Apache-2.0 全文
├─ start.command          一键启动本机开发环境
└─ stop.command           一键停止本机开发环境
```

`services/supervisord/` 不存在，也不是当前实现。

## 文档地图

先看这张表，再决定读哪一篇。每个主题只保留一个权威文档。

| 文档 | 回答什么问题 |
| --- | --- |
| [架构总览](docs/reference/architecture.md) | 系统怎么分层、边界在哪、哪些不变量不能破 |
| [技术设计](docs/reference/technical-design.md) | 协议、参数、状态机、人格、记忆、存储的细节 |
| [相关项目调研](docs/research/related-projects.md) | 同类项目有哪些值得持续观察的技术方案 |
| [外部集成](docs/guides/integrations.md) | 模型、语音、抖音评论和游戏身体怎么接 |
| [Bridge 设计](docs/reference/bridge.md) | `/bridge` 协议、队列、控制权与真机约束 |
| [自主生存闭环](docs/operations/autonomy.md) | 目标模式怎么持续决策、Agent 与 Mod 如何分工、为什么模型额度可能不变 |
| [验证清单](docs/operations/verification.md) | 现在能跑什么、哪些是部分实现、还缺什么 |
| [运行手册](docs/operations/runbook.md) | 怎么启动、怎么验证、常见问题 |
| [决策记录](docs/decisions/adr.md) | 已拍板的技术决策、后果与重新评估条件 |
| [技术选型](docs/decisions/tech-stack.md) | 为什么用 TS / Tauri / Java，而不是 Python / Go / Electron |
| [术语表](docs/reference/glossary.md) | 场次、仲裁、承诺、证据等词的精确定义 |
| [数据模型](docs/reference/data-model.md) | 迁移、幂等、保留策略与 schema 校验 |

三条推荐阅读路径：

1. **第一次接触**：README → 架构总览 → 技术设计 §1 → 验证清单。
2. **准备动手**：运行手册 → 验证清单 → 外部集成。
3. **接外部系统**：外部集成 → Bridge 设计 → 技术设计 §2 → 决策记录。

## 参考与许可

记忆模型、注意力策略与流水线设计参考了以下开源项目，代码均为独立实现：

- [PowerContext](https://github.com/oceanbase/powercontext)（Apache-2.0）：证据与记忆分离、版本化、待审队列、召回预算。
- [SeekMemory](https://github.com/NeverENG/SeekMemory)（MIT / Apache-2.0）：注意力闸门、后续回复窗口、取消语义、人格版本链。
- [AstrBot](https://github.com/AstrBotDevs/AstrBot)（AGPL-3.0）：仅参考阶段编排与策略选择器结构，不引用其代码。
- [dafeiyu-astrbot](https://github.com/whyever77/dafeiyu-astrbot)（MIT）：大肥鱼社区人格的性格参考。
- [MaiBot](https://github.com/Mai-with-u/MaiBot)（GPL-3.0）：关注自然对话节奏、观众关系与长期记忆、插件生态。
- [MaiCraftMod](https://github.com/Mai-with-u/MaiCraftMod)（GPL-3.0-only）：关注 MCP 游戏能力目录、目标生命周期、可中断长任务和带证据的执行结果。
- [Amaidesu](https://github.com/Mai-with-u/Amaidesu)（MIT）：关注主动节目编排、Planner/Replyer 分工、场次回顾，以及虚拟形象和演播设备协同。

以上项目用于技术方案和功能方向参考，不代表复制或引入其代码。对比结论与后续观察点见[相关项目调研](docs/research/related-projects.md)。

项目采用 MIT OR Apache-2.0 双许可，可任选其一。完整文本见 [licenses/](licenses/README.md)。
