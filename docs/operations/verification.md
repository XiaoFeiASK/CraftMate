# 验证清单

> 本文只记录可复现的自动化结果和真实环境证据。计划跟踪见
> [Issue #32](https://github.com/XiaoFeiASK/CraftMate/issues/32)。

最后核对：2026-11-16，Minecraft Java 1.20.1。

## 1. 自动化基线

```bash
npm run typecheck
npm test
npm run build
npm run db:check
npm run db:check:file
git diff --check

cd mods/craftmate-body
./gradlew test build
```

2026-11-16 当前工作区：

- `npm run typecheck`：通过；
- `npm test`：706 个测试、75 个 suite 全部通过；
- `npm run build`：Admin Console 生产构建通过；
- `npm run db:check` / `db:check:file`：迁移、约束、视图、FTS 和真实 WAL 文件库通过；
- `./gradlew test build`：232 个 JUnit 测试与 Fabric 1.20.1 构建通过；
- `git diff --check`：通过。

CI 不覆盖真实直播间、供应商计费、音频硬件、Minecraft 图形进程或桌面安装包。

真实身体通道检查需要 Minecraft 已连接：

```bash
npm run check:bridge
```

该命令等待真实 `mine_block` 完成，并校验每个目标方块的位置证据。默认挖 1 个
`minecraft:stone`；可用 `CRAFTMATE_CHECK_BLOCK` 和 `CRAFTMATE_CHECK_COUNT`
覆盖，最多 64 个。

完整控制链路：

```bash
npm run check:control
CRAFTMATE_CHECK_COUNT=3 npm run check:control
```

脚本通过 `/control` 注入“只砍 1 根木头”，再核对 `decision_log` 与
`action_attempt` 中的真实方块 ID、坐标和终态。逐场景矩阵见
[场景回归](scenarios.md)。

## 2. 状态定义

| 状态 | 判定 |
| --- | --- |
| 已实现 | 仓库命令可复现，或已有本机真实环境证据 |
| 部分 | 主路径存在，但关键环境、终态或长时间行为未验收 |
| 未实现 | 没有运行时代码 |

协议测试、模拟身体或供应商返回成功都不能写成游戏结果成功。目标里程碑必须有
身体 `changes` 证据；`unconfirmed`、空结果或“动作看起来开始了”都不算完成。

## 3. 核心链路

| 链路 | 状态 | 已自动化验证 | 未验收 |
| --- | --- | --- | --- |
| 管理端连接与操作指令 | 已实现 | 自动重连、四类操作指令、服务端错误展示 | 长会话和真实直播画面 |
| Agent 可观测工作台 | 已实现 | telemetry 契约、trace/task/decision 关联、任务生命周期、replay | 真实直播间长时采样、桌面安装包视觉复核 |
| 配置真实闭环 | 已实现 | settings/integrations 同步保存、热重载、重启恢复、密钥不广播 | 供应商断网和部分失败组合 |
| Orchestrator 持久化 | 已实现 | 迁移、重启恢复、承诺恢复、目标恢复、回放 | 4 小时连续运行 |
| Stage A/B 仲裁 | 已实现 | 注入、冷却、意图、权重、优先级 | 真实直播间分布下的阈值调优 |
| Stage C 模型 | 部分 | OpenAI 兼容请求、坏输出降级、模板兜底、token 记账 | 供应商稳定性、长 JSON、成本和成功率采样 |
| 目标运行时 | 部分 | Mission/Survival 规划、单任务在途、观察间隔、终态证据、失败退避和恢复 | 从空手到末影龙的真实长链路 |
| 技能结果契约 | 已实现 | 终态回填、`changes`/`unconfirmed`、坏结果拒绝、重启读回 | 真实样本量和待确认操作的重试策略 |
| 身体事件时间线 | 已实现 | `world_event` 递增、重启续号、控制台显示 | 长会话容量、非 `reflex` 事件 |
| 语音 | 部分 | Seeduplex 鉴权、24kHz PCM、首包和一次真实 `spoken` | BlackHole/OBS 路由、首字延迟 P95、长会话 |

## 4. 自主闭环

**已实现**

- `MissionGoalPlanner` 决定安全门、有界验收和任务链方向；`SurvivalGoalPlanner`
  编译阶段任务；模型不参与目标模式的逐步执行。
- 一次最多下发一个技能；终态后等待新观察再规划。
- 低血量、近身威胁、食物、可用镐和工作台是确定性前置，不能由观众提议或模型跳过。
- 完成必须带身体世界证据；空结果、`unconfirmed` 和旧快照不推进里程碑。
- 失败分类、路线黑名单、恢复路径、最长 6 秒退避和重新观察均有自动化覆盖。
- 铁套材料和工作台就绪时可编译 `run_plan`，连续完成熔炼和制作；契约和身体都强制
  32 步/180 秒上限、禁止嵌套、目标族白名单和类型化 guard。矿族 guard 会等待
  最多 5 秒的有界观察，扫描完成仍不满足时返回明确原因，不把未扫完当作不存在。
- Agent 任务树支持滞回、两次失败拉黑、只失效当前分支、生存任务压栈和检查点恢复；
  `goalProgress.taskTree` 只读投影当前路径、节点、检查点年龄和阻塞原因。
- B：第三人称构图以躯干中心为目标，pitch 为 60% 看向意图 + 40% 身体 pitch；
  第一人称和操作员接管路径不变。已有纯函数单元测试，待真机多朝向/贴墙验收。
- A：铁矿族匹配覆盖 `iron_ore` / `deepslate_iron_ore`，矿脉状态走
  `NOT_OBSERVED → OBSERVED_NOT_PLANNED → CANDIDATE_READY`；可见面要求真实暴露面
  和进入该面的视线。已有 Java/领域单测，待真实存档链路复现。
- 目标运行时恢复、观察间隔、死亡预占和策略熔断均有自动化覆盖。

**未验收**

- 从目标模式开启到击杀末影龙的全链路。
- 真实存档中的长时间 `run_plan`、站点复用、多段返地表和重启续跑。
- B 真机：多个朝向、俯仰、横移、贴墙、第一人称、操作员接管/释放。
- A 真机：脸上有铁矿石时稳定进入候选、选择、接近和挖掘；不可达矿石给出明确原因。
- C 真机：从 `CraftMate-4h-2026-11-13w` 原地继续，最终背包含
  `iron_pickaxe`、`iron_sword` 和四件铁护甲。
- 4 小时无人接管稳定性、感知 P95 和策略熔断现场表现。

## 5. 真实环境证据

### 2026-11-11

专用 1.20.1 存档、Fabric Loader 0.20.1：

- `check:control` 注入“只砍 1 根木头”通过，证据为
  `minecraft:oak_log at 4,73,196`，`action_attempt` 为 `completed`；
- 空场节拍生成 `idle:*` 的 `ACK_ONLY / ambient` 决策，并进入语音和字幕；
- 坠落反射写入 `world_event`，生成 `system:reflex:falling:*` 台词，未授予技能；
- 目标提议复测通过：模型首次误带技能，纠正重试后 `skill=null`。

同轮待观察项：草方块破坏后掉落未确认入包会按 `E_PRECONDITION` 失败；
`chop_tree` 4 根在树冠遮挡目标射线时于 180 秒超时。

### 2026-11-06 身体能力

| 能力 | 结果 | 证据 |
| --- | --- | --- |
| 连续 A* 路径 | 通过 | 38 个路点连续走完并有逐点位移 |
| 单格台阶/地形跟随 | 通过 | 路径包含上下台阶，未误判卡住 |
| 挖方块 | 通过 | 同位置方块变为空气并返回 ID/坐标 |
| 吃食物 | 通过 | 饥饿值、手持堆叠和 `food_consumed` 变化 |
| 楼梯脱困 | 通过 | 无路径时挖台阶离开坑位 |
| 自动垫桥 | 通过 | 5 格壕沟逐块确认并到达对岸 |
| 近战 | 通过 | 7 格内骷髅触发战斗并击杀 |
| 远距离动物 | 通过 | 先接近再攻击和收集 |
| 空闲游走 | 通过（短时） | `idle action=look/walk/fetch`，新任务中断 |

以下仍未完整实机验收：

- `craft`、`collect_items`、`deposit` 的真实容器/配方书延迟、满包和回滚；
- `place_block` / `pillar_up` 的独立高度、材料耗尽和洞穴顶条件；
- 第三人称、HUD、离轴挖放、容器交互和战斗的长时间稳定性；
- 真实岩浆、坠落、溺水、苦力怕反射的重复样本；
- 窗口失焦、断线重连、接管/急停后的输入释放；
- 床、熔炉、铁套、钻石、下界、要塞、末地和末影龙的真实存活链路；
- 60 分钟和 4 小时稳定性。

## 6. 抖音与语音

**抖音已实现**：dyhub 订阅、归一化、10 分钟去重、512 有界队列、每秒上限、
指数退避、健康上报、Orchestrator 自动启停。

**自动化**：本地 dyhub stand-in 覆盖订阅、断线重连、房间关闭、坏输入和洪峰；
Ingress 上报 `received/forwarded/queued/dropped`、`dropReasons`、`reconnects`
和有界无文本 `recent` 事实。

**本机检查**：Web 预览在三档宽度无横向溢出；工作台不渲染耳语或弹幕原文；
房间切换后计数和去重窗口清零，重启后仍显示新房间。

**未验收**：真实抖音房间字段、评论延迟、洪峰和风控。

**语音已实现**：Seeduplex 实时 WebSocket、24kHz PCM、字幕、抢占和失败上报。

**未验收**：BlackHole/OBS 路由、实播音频延迟、设备切换和长会话。

## 7. 明确不存在

- `services/supervisord`。
- 自动配置的 BlackHole/OBS 集成。
- 抖音开放平台 SDK。
- embedding 或向量库。
- 自动沉淀长期记忆的技能。
- 桌面多平台打包、Fabric 集成测试或发布流水线。
- 从自由文本直接生成任意技能的目标规划器。

以上出现实现时，必须同步本清单和[架构总览](../reference/architecture.md)。
