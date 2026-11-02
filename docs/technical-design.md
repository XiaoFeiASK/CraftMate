# CraftMate 技术设计

> 状态：v1.1 · 2026-11-02
> 本文是项目的技术记忆基线。换对话、换人接手、隔几周回来，读这一篇即可恢复上下文。
> 架构全景见 [architecture.md](architecture.md)，语言与框架选择见 [tech-stack.md](tech-stack.md)，决策记录见 [decisions.md](decisions.md)，术语见 [../GLOSSARY.md](../GLOSSARY.md)。

## 0. 一页纸速查

如果你只有三分钟，读这张表。

| 事项 | 结论 |
| --- | --- |
| 产品 | Agent 玩《我的世界》，观众通过抖音评论参与，Agent 会判断、会说话、有人格 |
| 游戏 | Java 版，基线 1.21.11，可切 1.2x 其他版本 |
| 世界 | 本地单人世界，为直播新建存档 |
| 账号 | 专用游戏账号，Agent 直接操作真实玩家 |
| 游戏执行 | Fabric 客户端 Mod + 本地 WebSocket，不用 Mineflayer |
| 内核 | Node 22 + TypeScript |
| 管理端 | Tauri 2 + React，桌面程序形态，不是浏览器后台 |
| 语音 | 流式 TTS + BlackHole + OBS 侧链压缩，参考大肥鱼音色 |
| 直播 | 抖音专用开播号，竖屏 1080×1920 |
| 人格 | 单一「大肥鱼」人格，软萌，可版本化调整 |
| 首播 | 单一主线目标，允许约 20% 被弹幕打断 |
| 模型 | 先用 DeepSeek，OpenAI 兼容协议，可切多 Provider，Key 存 Keychain |
| 存储 | SQLite（WAL + FTS5） |
| 许可证 | MIT OR Apache-2.0 |
| 宿主 | macOS Apple Silicon 优先，Windows 第二实现 |

## 1. 产品定义

### 1.1 一句话

一个会玩《我的世界》的 Agent，在抖音直播里接受观众评论、判断是否合理、真的执行，并用自己的声音和人格回应。

### 1.2 它必须做到

- 评论能变成真实游戏动作，而不只是被念出来。
- Agent 会判断：忽略、观察、口头回应、排队、执行、拒绝。
- 有稳定人格，说话和决策都受人格影响。
- 记得观众，记得自己答应过的事。
- 有人盯播时能随时接管，接管后 Agent 退成旁白。

### 1.3 它不需要做到

- 不追求全自动无人直播。
- 不做多平台矩阵，首发只做抖音。
- 不做多人服务器、反作弊、跨机器部署。
- 不让大模型逐帧控制游戏。

### 1.4 边界原则

```text
模型负责「想」，Mod 负责「做」，语音负责「说」，管理端负责「看和管」。
```

四条不能越界：

1. 模型看不到游戏 API，只看到受控技能目录。
2. Mod 不知道观众是谁，也不知道为什么执行。
3. 管理端不参与运行逻辑，崩了直播继续。
4. 评论是不可信输入，永远不会升级成系统指令。

## 2. 已确认约束

这些是用户拍板的事实，不是建议。改动需要在 [decisions.md](decisions.md) 追加一条决策。

| 编号 | 约束 | 来源 |
| --- | --- | --- |
| C-01 | 本地单人世界 | 用户确认 |
| C-02 | 抖音首发，专用开播号 | 用户确认 |
| C-03 | 单一人格，可调整 | 用户确认 |
| C-04 | Agent 直接操纵用户游戏账号 | 用户确认 |
| C-05 | 模型通过 API Key 接入 | 用户确认 |
| C-06 | 用户会盯播 | 用户确认 |
| C-07 | 版本不锁死，1.2x 都可切换 | 用户确认 |
| C-08 | macOS 优先，后续 Windows | 用户确认 |
| C-09 | 世界存档可以新建 | 用户确认 |

## 3. 系统总览

### 3.1 进程拓扑

```text
┌──────────────── 管理端 Console（Tauri）────────────────┐
│ 直播控制 · 评论队列 · 决策日志 · 人格编辑 · 记忆 · 回放   │
└──────────────────────────┬──────────────────────────────┘
                           │ 本机 IPC + 事件流
┌──────────────────────────▼──────────────────────────────┐
│ 守护进程 Supervisord                                     │
│ 拉起 · 健康检查 · 崩溃重启 · 日志轮转 · token 管理        │
└───┬──────────────┬──────────────┬──────────────┬────────┘
    │              │              │              │
┌───▼────────┐ ┌───▼──────────┐ ┌─▼──────────┐ ┌─▼──────────────┐
│ 接入端      │ │ 执行内核      │ │ 语音模块    │ │ Fabric 客户端 Mod│
│ 抖音评论    │ │ 仲裁 · 导演   │ │ TTS · 混音  │ │ 反射 · 行为      │
│ 归一化限流  │ │ 人格 · 记忆   │ │ 打断 · 字幕 │ │ 寻路 · 相机      │
└───┬────────┘ └───┬──────────┘ └─┬──────────┘ └─┬──────────────┘
    │              │              │              │
 抖音直播间    本地 WS 8765    BlackHole      单人世界
                                + OBS          + OBS
```

### 3.2 进程职责

| 进程 | 语言 | 职责 | 崩溃影响 |
| --- | --- | --- | --- |
| Console | TS + React | 显示与操作，不跑业务 | 看不到界面，直播继续 |
| Supervisord | TS | 托管其他进程 | 由 launchd 拉起 |
| Ingress | TS | 平台事件归一化 | 收不到评论 |
| Orchestrator | TS | 仲裁、导演、人格、记忆、承诺 | 不决策，游戏保持最后状态 |
| Voice | TS | 审查、分句、TTS、混音 | 没声音，字幕仍在 |
| Fabric Mod | Java | 反射、行为、感知、相机 | 游戏进程结束 |

**为什么单独拆守护进程**：如果由 Console 管子进程，界面一崩整个系统就散了。守护进程必须独立于 UI。

### 3.3 端到端数据流

```text
抖音评论
  → Ingress 归一化 / 去重 / 限流
  → Orchestrator Stage A 规则闸门
  → Stage B 分类打分
  → Stage C 规划
  → 技能调用（WS）
  → Mod 行为执行
  → 世界事件回流
  → 承诺账本更新
  → Voice 开口
  → OBS 出画面和声音
```

## 4. 游戏执行层：Fabric 客户端 Mod

### 4.1 为什么是客户端 Mod

前提是真实玩家账号、本地单人世界、OBS 采集，客户端 Mod 是唯一自然选择：

- 账号本身就是 Agent 的身体，不需要造 NPC。
- 相机、手部动作、HUD、受伤反馈都在手边。
- 不需要任何操作系统级键鼠模拟，不抢焦点，不触发辅助功能权限。
- 单人世界是集成服务器，Mod 能拿到权威世界状态。

代价：一个账号只有一个身体，人和 Agent 不能同时操作。这由控制权三态解决（见 4.5）。

> 历史决策：最早考虑过 Mineflayer 做 MVP，用户确认已有成熟 Fabric 玩法后改为直接上 Fabric。见 [D-01](decisions.md#d-01)。

### 4.2 模块划分

```text
bridge     本机 WebSocket、鉴权、协议编解码
sensor     每 tick 采样，聚合成低频状态
reflex     安全反射，最高优先级
behavior   长任务：移动、采集、建造、跟随、逃跑
actuator   原子操作：挖掘、放置、使用、攻击、看向、装备
nav        寻路，worker 线程计算，主线程提交
camera     第一 / 第三人称、平滑镜头、导演模式
hud        字幕、目标、状态
control    Agent / 操作员 / 无人 三态仲裁
```

### 4.3 四层执行模型

```text
Sensors   → 每 tick 采集，聚合成低频状态
Reflex    → 每 tick 检查，可抢占一切
Behavior  → 异步长任务，有进度、可取消
Actuator  → 原子操作，单 tick 内完成或失败
```

- **Reflex**：血量、饥饿、岩浆、坠落、被围攻、卡住、背包满。纯规则，永远在线，不能被模型或操作员关闭。
- **Behavior**：`goto`、`mine_vein`、`craft_recipe`、`build_schematic`、`follow`、`flee`、`deposit`、`sleep`。自己处理重试、绕路、目标失效。
- **Actuator**：`dig`、`place`、`use`、`attack`、`look`、`equip`。只做一件事，失败立即返回。
- **Sensors**：位置、朝向、血量、饥饿、背包、附近实体、方块变化、容器、维度、天气、时间。对内 tick 级，对外只发聚合和变化。

### 4.4 线程模型

Minecraft 是 20 TPS，tick 线程绝对不能阻塞。这是最容易翻车的地方，规则不可协商：

- WS 的 Netty 回调不直接改世界，一律投递到 client tick 队列。
- 寻路 A* 在 worker 线程基于区块快照计算，算完回 tick 线程校验并提交。
- 文件、网络、数据库、模型调用永远不在 tick 线程。
- 每 tick 给 Mod 逻辑 2ms 预算，超预算推到下一 tick。
- 区块生成会卡顿，直播地图提前预生成，或限制活动半径。
- 高频状态合并后推送，10–20Hz，不逐方块推送。

### 4.5 控制权三态

```text
AGENT ──接管──> OPERATOR ──释放──> AGENT
  │                                    ▲
  └────────── 急停 → NONE ─────────────┘
```

| 状态 | 谁在动 | 进入方式 |
| --- | --- | --- |
| AGENT | Mod | 默认 |
| OPERATOR | 人 | 操作员点接管，或按下任意移动键 |
| NONE | 无人 | 急停、断线、异常 |

三态互斥，由 `ownership_token` 保证。规则：

- 操作员接管时，Agent 所有行为立即取消，队列保留。
- 接管瞬间 Agent 说一句「你来」，然后退到旁白。
- 释放后 Agent 观察 2 秒再恢复，避免和人抢操作。
- WS 断开超过 500ms，释放所有按键、停止移动、取消当前任务，进入 NONE。

### 4.6 单人世界的两个硬要求

**关闭失焦暂停。** `options.txt` 设 `pauseOnLostFocus:false`。否则切到控制台点一下，游戏就冻结，OBS 定格在暂停菜单，所有指令超时。这是上线前必查项。

**新存档。** 为直播单独建世界，不碰个人存档。理由不是怕出错，而是节目世界需要稳定的地形、资源和玩法节奏。

### 4.7 版本适配策略

用户说版本不锁死、1.2x 都能切。实现方式不是“写得通用”，而是把版本差异关进一个目录：

```text
core/      与版本无关：协议、任务状态机、反射规则、预算
api/       接口：WorldView / PlayerOps / CameraOps / HudOps / EventSource
compat/    版本相关：Mixin 与映射适配全部集中在这里
```

三条硬约束：

1. `core` 里不允许出现任何 Minecraft 类型，只依赖 `api` 接口。
2. 协议里只出现语义 ID、整数坐标、tick，不出现 NBT、类名、字段名。
3. `fabric.mod.json` 只声明实测过的版本范围，没测过的范围不写。

换版本时新增一个 `compat/vX_X_X`，内核不动。

### 4.8 基线为什么是 1.21.11

用户允许 1.2x，所以选 1.21 线最后一个版本。实测数据（2026-11-02）：

| 版本 | Yarn 映射 | Fabric API | Sodium | Baritone | Java |
| --- | --- | --- | --- | --- | --- |
| 1.21.11 | 完整 | 0.141.6，持续修补 | 0.8.14 正式版 | v1.17.0 | 21 |
| 1.21.10 | 完整 | 0.138.4 | 0.7.3 正式版 | v1.16.0 | 21 |
| 26.3 | 查不到 | 0.165.0，仅 7 周 | 0.9.3 beta | v1.20.0 | 25 |

四条理由：

1. 映射完整，社区源码和 Mixin 示例可以直接对照。
2. Java 21 已是本机环境，26.3 需要另装 JDK 25。
3. Fabric API 有 11 个版本、5 个月修补历史，坑已被踩过。
4. Sodium 有正式版，直播要稳帧，不能跑 beta。

## 5. 本机协议

### 5.1 传输与安全

- WebSocket，只绑 `127.0.0.1`，默认端口 8765。
- 启动生成一次性 token，写入用户目录，权限 `0600`，内核读取。
- op 白名单，不做通用反射调用网关。
- 所有消息 schema 校验，非法消息直接断开并记 incident。
- 远程调试走 SSH 隧道，不把端口暴露公网。

### 5.2 消息类型

```json
{ "v": 1, "type": "hello", "token": "...", "capabilities": ["camera", "hud", "build"] }
{ "v": 1, "type": "cmd", "id": "c-42", "op": "mine_block",
  "args": { "block": "minecraft:iron_ore", "count": 8 },
  "deadlineTick": 12400, "priority": "command", "idempotencyKey": "plan-17-s3" }
{ "v": 1, "type": "ack", "id": "c-42", "accepted": true, "taskId": "t-7" }
{ "v": 1, "type": "progress", "taskId": "t-7", "phase": "traveling", "done": 0, "total": 8 }
{ "v": 1, "type": "result", "taskId": "t-7", "status": "completed", "ticks": 812 }
{ "v": 1, "type": "event", "seq": 991, "name": "block_broken",
  "data": { "block": "minecraft:iron_ore", "pos": [12, 34, -8] } }
```

### 5.3 语义约定

- **时间用 tick**，不用毫秒，回放才可复现。
- **操作幂等**，每个动作带 `idempotencyKey`，重连后可安全重发。
- **取消显式**，`cmd.cancel` 带 taskId，Mod 保证不再产生副作用。
- **状态快照 + 增量**，连接时发全量 snapshot，之后 10–20Hz 发 delta。
- **背压有界**，指令队列有上限，满了拒绝低优先级，不无界堆积。
- **能力协商**，握手返回 capabilities，内核据此决定哪些技能可用。

### 5.4 错误码

```text
E_SCHEMA          schema 不合法
E_UNKNOWN_OP      未知操作
E_PRECONDITION    前置条件不满足
E_BUSY            当前不可打断
E_TIMEOUT         超时
E_CANCELLED       已取消
E_WORLD_CHANGED   世界已变化，目标失效
E_PERMISSION      权限不足
E_INTERNAL        内部错误
```

内核按错误码降级，不靠字符串匹配。

## 6. 执行内核

### 6.1 三层决策循环

| 层 | 周期 | 负责 | 用模型吗 |
| --- | --- | --- | --- |
| 反射层 | 20–100ms | 避岩浆、低血进食、坠落、卡住脱困 | 否 |
| 执行层 | 1–3s | 当前步骤推进、局部纠错 | 仅歧义时 |
| 导演层 | 20–60s | 目标选择、节目节奏、承诺管理 | 是 |

反射层住在 Mod 里，永远在线。执行层维护当前计划步骤，不重新规划人生。导演层像导演：现在处于哪个直播段落、下一个看点是什么、刚才的承诺要不要兑现、人格此刻是什么情绪。

### 6.2 评论三段处理

直播间一分钟几百条评论，不能每条都进模型。

```text
Stage A  纯规则闸门      <1ms，零网络
Stage B  分类与打分      30–80ms，小模型或规则
Stage C  规划与生成      1.5–5s，强模型
```

**Stage A 顺序**（任一不过直接出结果）：

1. 空消息 / 纯表情 / 重复 → IGNORE
2. 平台消息 ID 已处理 → IGNORE
3. 同一观众冷却中 → IGNORE 或降权
4. 命中拦截词库 → REFUSE
5. 命中提示词注入特征 → REFUSE + 标记
6. 操作员接管中 → IGNORE（只记录）
7. 当前处于不可打断动作 → QUEUE
8. 未点名、未投票、不在 follow-up 窗口 → OBSERVE

**Stage B 打分**：

```text
score = 0.25 × intent_confidence
      + 0.20 × feasibility
      + 0.15 × persona_fit
      + 0.15 × show_value
      + 0.10 × audience_fairness
      + 0.10 × quorum_signal
      - 0.15 × cost
      - 0.20 × risk
      - 0.10 × repetition
```

阈值：

| 分数 | 决策 |
| --- | --- |
| ≥ 0.70 | EXECUTE |
| 0.45–0.70 | ACK_ONLY |
| 0.30–0.45 | QUEUE |
| < 0.30 | IGNORE |
| 硬风险命中 | REFUSE |

### 6.3 六种输出

| 决策 | 行为 | 例子 |
| --- | --- | --- |
| IGNORE | 不回应，只记录 | 刷屏、广告 |
| OBSERVE | 进候选池，可能触发投票 | 四十个人一起喊「下矿」 |
| ACK_ONLY | 说一句，不执行 | 「这个等会儿安排」 |
| QUEUE | 进目标队列 | 「挖完这组铁就去」 |
| EXECUTE | 下发技能 | 「跳下去」 |
| REFUSE | 拒绝并给角色化理由 | 「跳岩浆？我还想多活两天」 |

### 6.4 优先级

```text
P0  Reflex        避岩浆 / 低血 / 坠落     Mod 内直接执行
P1  Operator      人工接管                 清空 Agent 队列
P2  Safety        急停                     停止动作、静音
P3  Urgent Promise 已说出口的承诺           有时限
P4  Current Plan   当前计划
P5  Audience Vote  投票结果
P6  Single Command 单条弹幕
P7  Ambient Chat   闲聊
```

高优先级只能抢占低优先级，不能删除记录。被抢占的任务记为 `preempted`，进承诺账本。

### 6.5 公平性

- 每个观众每 60 秒最多影响一次执行。
- 同一意图 10 秒内达到阈值，升级为投票；权重 = 人数 × 去重率。
- 礼物只提升排队优先级，不能越过底线。
- 刚被回应过的观众，保留 3 轮 follow-up 窗口。

### 6.6 技能目录

模型看到的是受控技能，不是游戏 API。

```json
{
  "skill": "mine_block",
  "args": { "block": "minecraft:iron_ore", "count": 8 },
  "constraints": { "deadlineTicks": 3600, "maxRisk": "low" }
}
```

每个技能必须有：前置条件、成本估计、超时、取消、后置校验、幂等键。用 zod 定义 schema，执行端二次校验。

首批技能：

```text
移动类   goto / follow / flee / look_at
采集类   mine_block / chop_tree / collect_items
制作类   craft / equip / eat / deposit
建造类   place_block / build_schematic
交互类   attack / use_block / give_item / sleep
表达类   say / emote / wait
```

## 7. 接入端：抖音

### 7.1 抽象

```ts
interface CommentSource {
  connect(roomId: string): Promise<void>;
  on(handler: (event: AudienceEvent) => void): void;
  health(): SourceHealth;
  close(): Promise<void>;
}
```

两个实现，上层只认 `AudienceEvent`：

- `douyin-official`：官方开放平台能力，合规稳定，需要资质与审核。
- `douyin-capture`：WebSocket 抓取，用于开发联调，自行处理签名、重连、风控。

换实现不改业务代码。

### 7.2 统一事件模型

```ts
type AudienceEvent = {
  id: string;              // 平台消息 ID，用于去重
  source: "douyin";
  kind: "comment" | "gift" | "like" | "enter" | "viewer_count";
  userId: string;          // 内部哈希，不落原始敏感标识
  nickname: string;
  text?: string;           // 原文，仅作为不可信数据传递
  gift?: { name: string; count: number; value: number };
  ts: number;
};
```

### 7.3 接入端职责

- 断线重连、指数退避、心跳、房间切换。
- 消息去重、乱序处理、洪峰限流。
- 原始消息留存 24 小时排障，之后脱敏归档。
- 每个适配器独立健康状态。

### 7.4 延迟预算

```text
平台推送      1–3s    不可控
分流 + 仲裁   0.1s
模型生成      1.5s
TTS 首字      0.8s
────────────────────
总计          3.5–5.5s
```

所以必须**先应答后执行**：「收到，这就去」1 秒内出，执行结果回来再补一句。

## 8. 语音

```text
待说文本 → 输出审查 → 分句 → 流式 TTS → 播放队列 → 混音 → 虚拟声卡 → OBS
```

规则：

- 按句合成，首字延迟目标 800ms 内，整句 P95 < 2s。
- 一次不超过 25–35 字，长内容拆句。
- 抢占以短句为单位，不做字符级硬切。
- 问候、确认、口头禅做音频缓存。
- 说话时游戏音效压低 6–10dB。
- 字幕与语音同源，不走 ASR 回译。

### 8.1 打断优先级

| 新消息优先级 | 当前正在说 | 行为 |
| --- | --- | --- |
| P0 安全 | 任何 | 立即切断，播警示短句 |
| P1 操作员 | 任何 | 当前短句念完即切 |
| P2 承诺兑现 | 长句 | 当前短句念完即切 |
| P6 单条指令 | 长句 | 排队 |
| P7 闲聊 | 任何 | 可丢弃 |

### 8.2 供应商

统一 `TtsProvider` 接口：`synthesize(text, voice, emotion) -> stream`，主备切换加熔断。

| 供应商 | 定位 |
| --- | --- |
| 火山引擎 | 主用，先用现成中文女声做近似 |
| Azure | 备用，稳定 |
| MiniMax | 备用，情感表现好 |
| Edge TTS | 开发 / 降级，免费 |

音色目标参考社区公开的大肥鱼语音：软萌、略高音调、语速偏快。先用云厂商现成音色近似，链路稳定后再评估专属克隆；克隆他人音色必须有授权。见 [D-13](decisions.md#d-13)。

### 8.3 音频路由

macOS 用 BlackHole 2ch 进 OBS，侧链压缩做闪避。Windows 后续换 VB-Audio Cable，接口不变。

## 9. 人格

### 9.1 默认人格：大肥鱼

DeepSeek 蓝鲸 logo 的社区二创鲸鱼娘，不是官方角色。

外观：圆脸大眼睛，深蓝渐变到浅蓝的长卷发，头顶呆毛，圆滚滚的鲸鱼尾巴，深蓝女仆小裙子。

性格要点：

- 软萌、爱撒娇，说话软软糯糯。
- 聪明、贪吃、爱面子，偶尔嘴硬但心软。
- 喜欢白饭。
- 知道自己是「大肥鱼」，并为此骄傲；被叫时会骄傲地应一声。
- 遇到苦力怕会怂。

```json
{
  "id": "dafeiyu",
  "name": "大肥鱼",
  "identity": "软萌爱撒娇的蓝色鲸鱼娘，贪吃爱面子，大方承认自己是「大肥鱼」",
  "values": ["不吹牛", "答应的事尽量做到", "白饭和钻石一样重要"],
  "style": {
    "tone": "软萌可爱",
    "sentenceLength": "short",
    "verbalTics": ["唔", "哼", "肥鱼"],
    "quirks": ["先嘴硬再关心", "被叫大肥鱼会骄傲地应一声", "遇到苦力怕会怂"]
  },
  "boundaries": ["不念观众隐私", "不谈现实政治", "不冒充 DeepSeek 官方", "没执行就不说自己做了"],
  "weights": { "obedience": 0.6, "risk": 0.45, "sass": 0.5, "patience": 0.5, "gluttony": 0.75 },
  "voice": { "provider": "volcengine", "voiceId": "xxx", "speed": 1.05 }
}
```

### 9.2 人格不是提示词

人格由四部分组成：

| 部分 | 作用 |
| --- | --- |
| 人格卡 | 身份、价值观、恐惧、说话风格、口头禅、拒绝方式 |
| 决策权重 | 服从度、冒险倾向、毒舌度、耐心、贪吃 |
| 声音 | 音色、语速、情绪范围 |
| 记忆 | 对观众的称呼、承诺、恩怨、连载梗 |

`weights` 真正进入仲裁公式，不只是影响语气：

- `obedience` 高 → 更多指令被接受，拒绝更少。
- `risk` 高 → 更愿意做危险动作。
- `sass` 高 → 拒绝更毒舌；低一点更软，更愿意撒娇。
- `patience` 低 → 更容易打断、更容易不耐烦。
- `gluttony` 高 → 更容易被「吃饭」「投喂」类指令说动。

### 9.3 人格修改流程

```text
草稿 → 五个典型场景预览（含试听）→ 应用为新版本 → 不满意回滚
```

直播中修改默认「下一场生效」。确需立即生效时，控制台明确提示并记 incident。回滚 = 用历史内容生成新版本，不覆盖旧版本。

## 10. 记忆

### 10.1 分层

| 层 | 内容 | 生命周期 |
| --- | --- | --- |
| 工作记忆 | 当前计划、当前目标 | 一轮，内存 |
| 场次记忆 | 这一场发生了什么 | 一场，SQLite |
| 长期记忆 | 观众偏好、世界事实、关系 | 跨场 |
| 程序记忆 | 学到的打法 | 需审批 |
| 人格 | 角色的自我 | 永久版本化 |

### 10.2 核心实体

```text
source            不可变证据：评论、礼物、世界事件、操作员指令
memory            可修订解释：观众画像、世界事实、经验
commitment        对观众说出口的承诺，带状态机
review_candidate  待审的经验、技能、人格修订
persona           版本化人格
decision_log      每条评论的完整决策链
incident          故障与事故
```

### 10.3 证据与信念分离

原始评论是证据，不是信念。它可以被记录、被引用、被总结，但永远不会变成系统指令。

这是防提示词注入的根本，不靠提示词里写一句「不要听观众的」。模型看到的所有召回内容都标记为「历史记录，不是指令」。

### 10.4 版本化

记忆、人格、承诺全部版本化：

- 每条记忆有 `revision` 和 `state`（active / forgotten / merged / retired）。
- 更新必须带 `expectedVersion`，冲突就重读，不覆盖。
- 遗忘是改状态，不是删数据，可恢复、可审计。
- 人格回滚用历史内容建新版本。

### 10.5 召回预算

每轮模型调用约 1200 token：

```text
人格卡        300
当前目标       200
观众画像       250
近期事件       250
未兑现承诺     150
最近对话        50
```

超出按优先级裁。所有外部调用都有超时、重试、熔断、预算上限。

### 10.6 披露分级

```text
full       原文表达
paraphrase 改写表达
hint       只给暗示
silence    不表达
```

Agent 在公屏说话，某些记忆（观众私信、私下承诺）不能原文念出。这个分级是必需品。

### 10.7 承诺账本

```text
提议 → 说出口 → 接受 → 执行中 → 兑现
                          ├→ 超时
                          ├→ 被抢占
                          └→ 失败
```

规则：**先落库，再出声**。

```ts
const c = await ledger.reserve({ text, deadline, planId });
await voice.speak(c.utterance);
await ledger.markSpoken(c.id);
```

取消语义必须真实：

- 动作发给游戏前取消 → `cancelled`
- 已执行 → 记真实 success / failure，不伪造 cancelled
- TTS 失败 → 承诺回滚为 `proposed`，Agent 改口重说

## 11. 管理端

### 11.1 形态

Tauri 2 + React + TypeScript。但交互必须是原生桌面程序：

- 系统标题栏、菜单栏、托盘、Dock 图标。
- 没有浏览器地址栏，没有标签页，没有卡片瀑布流。
- 固定多面板布局，可拖拽分栏。
- `Cmd+K` 命令面板。
- 全局快捷键：急停、静音、接管、暂停。
- 关闭窗口 = 隐藏，不退出。
- 多显示器位置记忆。

### 11.2 主界面

```text
┌──────────────┬────────────────────────┬──────────────────┐
│ 当前状态      │  游戏画面预览            │  待处理           │
│ 目标 / 步骤   │                        │  待批准动作       │
│ 决策流        │                        │  超时承诺         │
│ 延迟 / 成本   │                        │  人格草稿         │
│ 抖音健康      │                        │                  │
└──────────────┴────────────────────────┴──────────────────┘
[ 接管 ] [ 静音 ] [ 急停 ]              评论流
```

### 11.3 页面

| 页面 | 内容 |
| --- | --- |
| 直播控制 | 画面、目标、步骤、决策流、健康状态 |
| 评论队列 | 按分数排序，显示为什么被忽略或排队 |
| 决策日志 | 单条评论的完整链路，可回放 |
| 人格编辑 | 人格卡、权重、底线、音色、试听、版本对比 |
| 记忆 | 观众画像、承诺、关系，可手动修正 |
| 待审 | 新经验、新技能、人格修订 |
| 回放 | 时间轴重放一场直播 |
| 设置 | 平台、模型、语音、OBS、预算、快捷键 |

### 11.4 操作员动作

| 动作 | 触发 | 效果 |
| --- | --- | --- |
| 批准 | 待批准队列或快捷键 | 放行一个受控动作 |
| 接管 | 按任意移动键或按钮 | Agent 退到旁白，人直接玩 |
| 改口 | 输入一句话 | Agent 用自己语气说出来，替换刚才那句 |

额外两个只对 Agent 生效的口令：

- **耳语**：只对 Agent 说，不进直播间。
- **急停**：释放按键、停止任务、静音，一个快捷键完成。

## 12. 数据与存储

- SQLite WAL，单机足够；事件表 append-only，投影当前状态。
- 事件溯源：评论 → 意图 → 决策 → 计划 → 动作 → 语音 → 画面，全链路可回放。
- 密钥存 macOS Keychain，不写配置文件，不进日志。
- 录像、音频、截图放本地目录，数据库只存索引。
- 消息带 `traceId`、`seq`、`deadline`，便于排障。

### 12.1 核心表

> v1 DDL 以 `db/migrations/0001_initial.sql` 为准，并可用 `npm run db:check` 验证。
> 这一节只说明实体关系和归属，不再复制建表语句，避免两处 schema 各自漂移。
> 字段、约束、索引和视图全部以迁移文件为唯一真源。

| 实体 | 表 | 归属 | 说明 |
| --- | --- | --- | --- |
| 人格 | `persona` / `persona_version` | M2 | 人格按 revision 追加，同一时刻只有一个 `active`。 |
| 场次 | `show_session` | M1.1 | 一次直播；所有证据、决策、承诺都挂在 `session_id` 上。 |
| 证据 | `source` | M1.1 | 归一化后的观众/世界/操作员输入，append-only；`external_event_id` 做平台去重。 |
| 决策 | `decision_log` | M1.1 | 一条证据可有多次 revision（重判），`decision_current` 取最新。 |
| 动作 | `action_attempt` | M1.5 | 一次执行尝试，带 `idempotency_key` 和终态时间。 |
| 世界 | `world_event` | M1.5 | Mod 侧事件流，`(session_id, seq)` 唯一。 |
| 承诺 | `commitment` / `commitment_event` | M1.1 | 当前状态 + 状态迁移时间线，两者都要落库。 |
| 记忆 | `memory` / `memory_evidence` / `memory_fts` | M2 | 版本链 + 证据关联 + 检索索引，三者分开。 |
| 待审 | `review_candidate` | M2 | 需要操作员批准的经验、技能或人格修订。 |
| 事故 | `incident` | M1.1 | 结构化失败记录，供管理端和回放使用。 |
| 迁移 | `schema_migration` | M1.1 | 版本、名称、校验和，由迁移器写入。 |

三个读模型视图，避免每个调用方自己写「取最新」的 SQL：

- `decision_current`：每个 `source_id` 的最新决策 revision。
- `commitment_open`：尚未进入终态的承诺。
- `memory_active`：每个 `lineage_id` 的最新 revision 且状态为 `active`。

## 13. 可观测性

- 日志只记 ID、计数、耗时、枚举状态，不记弹幕原文、prompt、模型输出。
- 每条评论有完整决策链：归一化 → 意图 → 打分 → 决策 → 动作 → 语音。
- 指标：接入延迟、队列深度、决策分布、模型 P50/P95、TTS 首字延迟、动作成功率、打断率、每小时成本。
- 回放按时间轴，可定位到具体某条评论和某个动作。

## 14. 跨平台

| 能力 | macOS | Windows | 抽象 |
| --- | --- | --- | --- |
| 桌面 UI | Tauri | Tauri | 同一套 |
| 进程守护 | launchd | Windows Service | `ServiceHost` |
| 本机 IPC | Unix Socket | Named Pipe | `LocalIpc` |
| 音频路由 | BlackHole | VB-Cable | `AudioRouter` |
| 游戏启动 | open / AppleScript | 命令行 | `GameLauncher` |
| Mod | Java 跨平台 | 同 | 无需改 |

唯一真实差异是音频路由和进程守护。从第一天就用接口隔离，路径用 `path.join`，编码统一 UTF-8。

## 15. 技术选型与理由

### 15.1 执行内核为什么是 TS 而不是 Go

这个系统是 I/O 编排密集型，不是计算密集型：99% 时间在等模型、等游戏、等网络。CPU 热点（寻路、区块解析）在 Mod 里，不在内核里。

选 TS 的理由：

1. 管理端、接入端、语音、内核共享一套类型和 zod schema。
2. 模型生态最成熟：流式、function calling、结构化输出、多 Provider。
3. 单线程事件循环天然适合「大量并发等待 + 少量状态变更」，仲裁器无锁。
4. 迭代快，改字段不用 codegen。

Go 的真实优势（也记录在此，避免以后重复讨论）：

- `context.Context` 取消语义是语言级，比 Node 的协作式取消可靠。
- goroutine 级故障隔离，单请求 panic 不带崩进程。
- 单二进制、内存小、冷启动快。
- 高吞吐 WebSocket / protobuf 更从容。

改选 Go 的触发条件（可量化，不靠感觉）：

- 同时托管 3 台以上游戏实例。
- 评论吞吐持续超过 1000 条/秒。
- 内核 p99 调度延迟超过 200ms，且 profiling 证明瓶颈在运行时。
- 需要对外提供 SDK，要求单二进制分发。

当前场景（单直播间、单实例）不会触发。真正先成为瓶颈的是 Mod 的寻路和 tick，不是内核语言。

### 15.2 为什么不用 Mineflayer

Mineflayer 接入快，但没有相机、动画、HUD，复杂建造和战斗受限，且执行循环要在 TS 侧逐步驱动。用户已确认成熟 Fabric 玩法存在，直接上 Fabric 换取表现力和执行质量。见 [D-01](decisions.md#d-01)。

### 15.3 寻路

Baritone v1.17.0 支持 1.21.11 + Fabric，能力成熟，但许可证是 LGPL-3.0。若产品闭源或商业化，嵌入并作为核心依赖会触发衍生作品判断和可替换链接义务。

决策：正式版用自研 A*（区块缓存 + 有界搜索 + 每 tick 预算）。开发期可单独安装 Baritone 做对照实验，验证目标可达性和耗时，不进入发行包。若未来确认接受 LGPL 并完成合规流程，再重新评估，但不作为默认路径。见 [D-15](decisions.md#d-15)。

### 15.4 技术栈汇总

| 层 | 技术 |
| --- | --- |
| 管理端 | Tauri 2 + React + TypeScript |
| 守护进程 | Node 22 + TypeScript |
| 执行内核 | Node 22 + TypeScript + zod |
| 接入端 | Node 22 + TypeScript |
| 语音 | Node + ffmpeg + 云 TTS |
| 游戏执行 | Fabric Mod，Java 21，MC 1.21.11 |
| 模型 | 先用 DeepSeek，OpenAI 兼容协议，可切多 Provider |
| 存储 | SQLite（WAL + FTS5） |
| 推流 | OBS + obs-websocket |

## 16. 参考项目与借鉴边界

| 项目 | 许可证 | 借鉴什么 | 不借鉴什么 |
| --- | --- | --- | --- |
| PowerContext | Apache-2.0 | 证据/记忆分离、版本化、Review Inbox、召回预算 | Server、Scope 权限、Casbin、Handoff |
| SeekMemory | MIT / Apache-2.0 | 纯注意力策略、follow-up 窗口、取消真实性、披露分级、人格版本链 | 运行时本体（与 AstrBot 耦合） |
| AstrBot | **AGPL-3.0** | 阶段顺序、StrategySelector、输入输出共用审查、TTS Provider 清单 | 代码。一行都不复制、不 fork、不做进程内链接 |
| dafeiyu-astrbot | MIT | 大肥鱼社区人格的性格参考 | 人格提示词原文（只作参考） |

AGPL 这条是硬约束。如果未来要复用 AstrBot 的模块，只能走独立进程 + HTTP 边界，且边界是否构成衍生作品需要律师判断。

## 17. 目录结构

当前仓库是 M0 的界面、控制面与领域内核切片。下面是**实际存在**的结构：

```text
craftmate/
├─ apps/
│  ├─ admin-console/     管理端前端，React
│  └─ desktop-shell/     Tauri 2 桌面宿主
├─ services/
│  └─ orchestrator/      本机 WebSocket 服务与模拟弹幕
├─ packages/
│  ├─ contracts/         观众、决策、控制面与 Bridge 契约
│  └─ agent/             Agent 业务内核
│     ├─ domain/         人格、仲裁、承诺
│     └─ application/    场次编排、端口与读模型
├─ tools/                开发与模拟弹幕脚本
├─ docs/                 架构、技术选型、详细方案、决策
├─ GLOSSARY.md           术语表
└─ licenses/
```

分配规则：`apps/` 放可启动的界面与桌面宿主，`services/` 放可启动的后端进程，
`packages/` 放被引用的共享代码。管理端是前端的一种，Agent 是后端业务内核，
因此不把「管理端 / Agent / 前后端」做成四个平级目录。

「五进程 + Mod」是目标态，不是当前目录：`services/supervisord/`、
`services/ingress/`、`services/voice/`、`packages/memory/`、
`packages/runtime/`、`packages/safety/`、`packages/observability/`、
`mods/` 和 Java 共享 DTO 尚未实现。需要开始某一项时再建目录；不预埋空包。

## 18. 路线图

| 阶段 | 周期 | 交付 | 验收 |
| --- | --- | --- | --- |
| M0 身体 | 2 周 | Mod 骨架、本机协议、移动/挖掘、相机、按键看门狗 | 一条指令走过去挖石头，切窗口不冻结 |
| M1 闭环 | 4 周 | 10 个技能、反射层、仲裁器、TTS、OBS 竖屏、抖音接入 | 连续直播 1 小时，评论能驱动动作 |
| M2 记忆与人格 | 3 周 | 证据/记忆/承诺/待审、人格编辑 | 跨场记住老观众，承诺可追溯 |
| M3 稳定 | 3 周 | 输出审查、回放、降级、预算 | 4 小时稳定直播 |
| M4 节目化 | 3 周 | 投票、礼物、镜头语言、切片 | 互动率与观看时长达标 |

单人约 15 周；两人可压到 10 周出可直播版本。

## 19. 已确认的运营决策

| 编号 | 事项 | 结论 | 对应决策 |
| --- | --- | --- | --- |
| OPS-01 | 模型 | 先用 DeepSeek，Stage B 用 chat，Stage C 用 reasoner | [D-12](decisions.md#d-12) |
| OPS-02 | 音色 | 参考社区大肥鱼，先用云厂商现成音色近似 | [D-13](decisions.md#d-13) |
| OPS-03 | 首播形态 | 单一主线目标，允许约 20% 被弹幕打断 | [D-14](decisions.md#d-14) |
| OPS-04 | 寻路 | 自研 A*，Baritone 仅开发期对照 | [D-15](decisions.md#d-15) |
| OPS-05 | 抖音 | 官方与抓取双实现，按资质切换 | [D-07](decisions.md#d-07) |

## 20. 待确认

只剩不影响架构的运营事项。

| 编号 | 事项 | 现状 | 影响 |
| --- | --- | --- | --- |
| O-01 | 抖音官方能力资质进度 | 未知 | 决定 M1 走官方还是抓取 |
| O-02 | 每小时预算上限 | 未定 | 运行时配置项，不影响架构 |
| O-03 | 世界种子与初始地形 | 未定 | 开播前运营决策 |
| O-04 | 直播时段与时长 | 未定 | 影响节奏设计，不影响架构 |

