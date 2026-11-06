# 验证清单

> 本文区分自动化验证、本机真实验收和未验收项。计划与任务跟踪在
> [Issue #32](https://github.com/XiaoFeiASK/CraftMate/issues/32)。

最后核对：2026-11-06，`main` 工作区，Minecraft Java 1.20.1。

## 1. 自动化基线

```bash
npm install
npm run typecheck
npm test
npm run build
npm run db:check
npm run db:check:file
git diff --check

cd mods/craftmate-body
./gradlew test build
```

2026-11-06 当前工作区结果：

- `npm run typecheck`：通过；
- `npm test`：375 个测试、63 个 suite 全部通过；
- `npm run build`：Admin Console 生产构建通过；
- `npm run db:check`：32 个对象、29 个索引，约束/视图/FTS 通过；
- `npm run db:check:file`：真实 WAL 文件库通过；
- `./gradlew test build`：JUnit 与 Fabric 1.20.1 构建通过；
- `git diff --check`：通过。

构建产物 `mods/craftmate-body/build/libs/craftmate-body-0.1.0.jar` 的 SHA-256：
`689939222622012d1c9d4587cec2d0c4b040bb5f8bfae1643d30b59ff511e4c2`。
CI 不包含真实直播间、真实模型计费、真实音频硬件、Minecraft 图形进程或桌面安装包。

真实身体通道检查（需要 Minecraft 客户端已连接）：

```bash
npm run check:bridge
```

该检查等待真实 `mine_block` 完成，并校验结果包含每个目标方块的位置证据。默认挖
1 个 `minecraft:stone`；可用 `CRAFTMATE_CHECK_BLOCK` 和
`CRAFTMATE_CHECK_COUNT` 覆盖，最多 64 个。它验证协议和 Mod 执行器，不是完整的
“Agent 规划 → 执行”链路。

完整控制链路：

```bash
npm run check:control
CRAFTMATE_CHECK_COUNT=3 npm run check:control
```

该脚本通过 `/control` 注入“只砍 1 根木头”，要求规划器选择 `chop_tree`，再从
SQLite `action_attempt` 校验真实 Mod 完成的原木方块 ID 与坐标。

## 2. 状态定义

| 状态 | 判定 |
| --- | --- |
| 已实现 | 仓库命令可复现，或已有本机真实环境证据 |
| 部分 | 主路径存在，但关键环境、终态或长时间行为未验收 |
| 未实现 | 没有运行时代码占位 |

不能把协议测试、模拟身体或供应商返回成功写成游戏结果成功。目标里程碑必须有身体
`changes` 证据；`unconfirmed`、空结果或“动作看起来开始了”都不算完成。

## 3. 核心链路

| 链路 | 状态 | 已验证 | 未验收 |
| --- | --- | --- | --- |
| 管理端连接与操作指令 | 已实现 | WebSocket 自动重连、四类操作指令、服务端错误展示 | 长会话与真实直播画面下的操作体验 |
| Agent 可观测工作台 | 已实现 | telemetry contract/store/control-plane 测试，Ingress 计数与 drop reason，trace/task/decision join，任务生命周期，replay lookup | 真实直播间长时采样；桌面安装包本机视觉复核 |
| 配置真实闭环 | 已实现 | settings/integrations 同时保存、运行中 provider/语音/Ingress 重载、重启恢复、密钥不广播 | 真实模型/语音供应商断网与部分失败组合 |
| Orchestrator 持久化 | 已实现 | 迁移、重启恢复、承诺恢复、目标运行时恢复、决策优先级、回放 | 4 小时连续运行 |
| Stage A/B 仲裁 | 已实现 | 注入、冷却、意图、权重、优先级单测 | 真实直播间分布下的阈值调优 |
| Stage C 模型 | 部分 | OpenAI 兼容请求、坏输出降级、模板兜底、零价格 token 记账 | 当前 DeepSeek 端点稳定性、长 JSON、成本和成功率实播采样 |
| 目标运行时 | 部分 | 确定性规划、单任务在途、终态证据、失败退避和改道均有自动测试 | 从空手到末影龙的真实长链路 |
| 技能结果契约 | 已实现 | 终态回填决策、`changes`/`unconfirmed` 渲染、坏结果被契约拒绝、重启后读回 | 真实技能样本量与“待确认”操作的重试策略 |
| 身体事件时间线 | 已实现 | `world_event` 按 session 递增、重启续号、控制台显示最近事件 | 长会话容量、`reflex` 之外的事件类型 |
| 语音 | 部分 | Seeduplex 真实鉴权、24kHz PCM、约 200ms 首包、一次真实 `spoken` | BlackHole/OBS 路由、首字延迟 P95、长会话 |
| 本机音频 | 部分 | macOS 播放器曾产生 `spoken` | 设备路由；`AudioQueueStart (-66681)` 需现场处理 |

## 4. 自主闭环与模型额度

**已实现（2026-11-06）**

- 目标模式由 `GoalRuntime` + 确定性 `SurvivalGoalPlanner` 驱动，不调用大模型。
- 九个阶段：木头/工作台、石具、食物、庇护所/床、铁器、下界、末影之眼、要塞、
  末地/末影龙。
- 一次最多下发一个技能；终态后重新读取身体事实并规划。
- 同一移动策略连续失败会换区域重新观察；达到失败上限只进入最长 6 秒退避，
  不再把目标永久标成 blocked。
- 真实 1.20.1 日志中确认 `goal_runtime.enabled=1`、目标 `active`、Agent 下发
  `goto` 后连续走完多段路径；无任务时出现 `idle action=...`。

**模型额度检查（2026-11-06）**

- `model_cost` 最近两条成功记录为 2026-11-05 18:46 与 20:03（本地时间），
  模型 `deepseek-v4.1-flash`，token 用量分别为 `1326/131`、`1598/297`；
- 本地未配置每百万 token 单价，因此两行 `cost=0.0`；迁移 0012 保证以后仍能
  看到 token 用量；
- 2026-11-06 目标模式持续运行时没有新增模型行，符合确定性规划器不调用模型的
  设计；
- 当前 YYAPI/DeepSeek 端点曾返回 HTTP 502。供应商恢复前，不应通过刷新余额判断
  Agent 是否运行，应查 `goal_runtime`、`decision_log` 和客户端技能日志。

**未验收**

- 模型驱动的目标规划（当前不是产品路径）。
- 供应商长期稳定性、真实扣费单价和余额联动。
- 从目标模式开启到击杀末影龙的全链路。

## 5. 抖音评论

**已实现**：dyhub 订阅、事件归一化、10 分钟去重、512 有界队列、每秒上限、指数退避、
健康上报、Orchestrator 自动启停。

**自动化**：本地 dyhub stand-in 覆盖订阅、断线重连、房间关闭、坏输入和洪峰。

**Issue #55 新增**：Ingress 上报 `received/forwarded/queued/dropped`、
`dropReasons`、`reconnects` 和有界的无文本 `recent` 事实；控制面把所有事实
投影为 `ingress_received`，再按结果投影 `gated` 或 `dropped`。管理端
在 metrics 未到达或房间未配置时显示 unknown/未配置，不显示伪造的零。

**UI 本机检查（2026-11-05）**：Web 预览在 1280×720、850×900、580×900
三档宽度均无横向溢出；设置抽屉在窄屏可打开；导航图标在折叠文字后有可访问名称；
合成评论经过真实控制面、Ingress 计数、任务和 replay 链路时，工作台会更新且
不显示注入的弹幕原文；点击「查看回放」后时间轴在 1280×720、850×900、
580×900 三档都进入视口并可读取来源与决策。实时事件流每组只渲染最近 4 条、
最多 5 组，并标注收起数量。

**配置与房间切换（2026-11-05）**：从设置界面把房间改为测试房间后，控制面返回
「已保存到当前场次」，integrations 文件写入新 room id，fake dyhub 收到新房间
订阅；Ingress 的 `received/forwarded/queued/dropped` 与 gate/relay 去重窗口
一起清零，再按新房间重新累计。连续重启 Orchestrator 两次后，配置文件和 UI
仍显示新房间。

**隐私检查（2026-11-05）**：提交唯一测试耳语后，界面只显示「耳语已记录」及
“内容只在服务端留存”，工作台、事件流和服务端提示均未渲染耳语原文。

**未验收**：

- 真实抖音房间字段，尤其 `gift.repeatCount` / `groupCount`。
- 实播评论延迟、洪峰和封禁/风控行为。

## 6. 游戏身体

### 6.1 环境

- Minecraft Java 1.20.1，客户端 Fabric Loader 0.20.1（Mod 依赖
  `>=0.15.11`），Fabric API `0.92.2+1.20.1`；
- 专用服务端世界 `craftmate-autonomy`，开发端口 `25599`；
- 客户端 Bridge 为目标 `ws://127.0.0.1:4321/bridge`，可选帧端口 `4324`；
- 真实的客户端、服务端和 Orchestrator 进程，不使用 `SimBody`。

### 6.2 2026-11-06 实机证据

| 能力 | 结果 | 证据 |
| --- | --- | --- |
| 连续 A* 路径 | 通过 | 一次规划 38 个路点，真实客户端连续走完并有逐点位移日志 |
| 单格台阶/地形跟随 | 通过 | 路径包含上下台阶，未因短暂远离目标误判卡住 |
| 挖方块 | 通过 | `mine_block` 确认同一位置方块变为空气并返回方块 ID/坐标 |
| 吃食物 | 通过 | 饥饿值、手持堆叠和 `food_consumed` 变化确认 |
| 楼梯脱困 | 通过 | 无可行路径时挖出可用台阶并离开坑位 |
| 自动垫桥 | 通过 | 5 格壕沟连续放置 5 块橡木板并走到对岸；服务端 `execute if block` 核对两端木板块 |
| 近战 | 通过 | 7 格内骷髅触发战斗，3 次有效命中击杀并获得“怪物猎人”进度 |
| 远距离动物 | 通过 | 先用 `goto` 接近，再攻击并收集；不再站远处空挥 |
| 镜头限速 | 通过（代码与实机观察） | `ViewSlew`/`CameraController` 平滑转向，交互瞄准仍命中 |
| 空闲游走 | 通过（短时） | 无 Agent 任务时出现 `idle action=look/walk/fetch`，新任务立即中断 |

自动垫桥是真实世界中的多块确认，不是单元测试或模拟身体结果。挖方块、吃食物和
脱困均在 1.20.1 实例完成。

### 6.3 已实现但未完整实机验收

- `craft`、`collect_items`、`deposit`：有证据判定和纯逻辑测试，真实容器/配方书
  延迟、满包、预测回滚和多人竞争仍需样本。
- `place_block` / `pillar_up`：有逐块确认测试；`pillar_up` 的独立实机高度、材料
  耗尽和洞穴顶条件仍需复验。
- 1.20.1 真实渲染管线中的第三人称、HUD 和手部一致性；离轴挖掘仍只能用真实视线
  完成，不能宣称任意镜头角度都可交互。
- 真实岩浆、高处坠落、溺水和苦力怕反射；`threat` 在战斗中的取消关系有自动化
  测试，但仍需多轮实战。
- 窗口失焦、断线重连、接管/急停后输入释放的长时间现场复核。
- 60 分钟和 4 小时稳定性、独立发布存档。

### 6.4 生存链未验收

以下不能因为部件存在就标记完成：

- 床：造床、放置、夜间睡眠、跨夜确认；
- 熔炉/铁器：真实挖铁、燃料、熔炼、铁镐；
- 下界：黑曜石、传送门点燃、烈焰人；
- 末影之眼、要塞定位；
- 末地传送门、末影水晶、末影龙死亡。

当前目标状态停在食物阶段，`dragon-dead` 仍是 `unverified`。完整末影龙链路尚未
在真实存档中跑通。

## 7. 明确不存在

- `services/supervisord`。
- 自动配置的 BlackHole/OBS 集成。
- 抖音开放平台 SDK。
- embedding 或向量库。
- 自动沉淀长期记忆的技能。
- 桌面多平台打包、Fabric 集成测试或发布流水线。
- 模型驱动的自主生存规划器（当前目标是确定性的）。

以上出现实现时，必须同步本清单和[架构总览](../reference/architecture.md)。
