# 技术设计

> 状态：v2.0 · 2026-11-02
> 本文是项目的**技术细节真源**：协议、参数、状态机、人格、记忆、存储。
> 系统边界与不变量见 [架构纵览](architecture.md)；做什么、做到哪见 [交付计划](delivery-plan.md) 与 [实现状态](status.md)；为什么这么选见 [决策记录](decisions.md) 与 [技术选型](tech-stack.md)。

## 1. 关键参数

先看这张表，需要时再跳章节。

| 事项 | 取值 | 详述 |
| --- | --- | --- |
| 游戏 | Java 版 1.21.11，Fabric 客户端 Mod | §3 |
| 世界 | 本地单人世界，直播专用存档 | §3.6 |
| 内核 | Node 22 + TypeScript + zod | §4 |
| 管理端 | Tauri 2 + React，桌面程序形态 | §10 |
| 控制面 | WebSocket `127.0.0.1:4321`，路径 `/control`；接入端 `/ingress` | §2 |
| 健康检查 | `GET http://127.0.0.1:4321/health` | §2 |
| 时间单位 | 协议与超时统一用 tick；数据库用 epoch 毫秒 | §2.4 |
| 语音 | 流式 TTS + BlackHole + OBS 侧链压缩 | §6 |
| 模型 | DeepSeek，OpenAI 兼容协议，Key 存 Keychain | §4.7 |
| 存储 | SQLite（WAL + FTS5） | §9 |
| 直播 | 抖音专用开播号，竖屏 1080×1920 | §5 |
| 首播形态 | 单一主线目标，允许约 20% 被弹幕打断 | [D-14](decisions.md#d-14) |

## 2. 本机协议

### 2.1 传输与安全

- WebSocket，只绑 `127.0.0.1`，默认端口 4321（`CRAFTMATE_PORT` 可覆盖）。
- 控制台走 `/control`；接入端与 Bridge 未来各开独立通道，不共用控制台权限。
- 启动生成一次性 token，写入用户目录，权限 `0600`。
- op 白名单，不做通用反射调用网关。
- 所有消息 schema 校验，非法消息直接断开并记 incident。
- 远程调试走 SSH 隧道，不把端口暴露公网。

### 2.2 控制面消息（已实现）

```ts
// 客户端 → 服务端
{ type: "hello" }
{ type: "comment", payload: AudienceEvent }
{ type: "operator", payload: { kind: "whisper" | "takeover" | "release" | "stop", text: string } }

// 服务端 → 客户端
{ type: "ready", payload: { persona: PersonaSummary, snapshot: ShowSnapshot } }
{ type: "decision", payload: Decision }
{ type: "stats", payload: ShowStats }
{ type: "snapshot", payload: ShowSnapshot }
{ type: "operator", payload: OperatorCommand }
{ type: "source", payload: SourceHealth }   // 规划中，尚未进入 ServerMessage
{ type: "error", payload: { code: string, detail: string } }
```

契约以 `packages/contracts/src/control.ts` 为准，两边都用同一份 zod schema。

### 2.3 接入端消息（部分实现）

```ts
// ingress → orchestrator，走 /ingress
{ type: "hello", role: "ingress", token: string }
{ type: "event", payload: AudienceEvent }
{ type: "health", payload: SourceHealth }
```

当前 token 字段只透传、未校验；`/ingress` 与 `/control` 共用同一个 HTTP server 和端口。

### 2.4 Bridge 消息（仅有 schema）

```json
{ "v": 1, "type": "hello", "token": "...", "capabilities": ["camera", "hud", "build"] }
{ "v": 1, "type": "cmd", "id": "c-42", "op": "mine_block",
  "args": { "block": "minecraft:iron_ore", "count": 8 },
  "deadlineTick": 12400, "priority": "command", "idempotencyKey": "plan-17-s3" }
{ "v": 1, "type": "ack", "id": "c-42", "accepted": true, "taskId": "t-7" }
{ "v": 1, "type": "progress", "taskId": "t-7", "phase": "traveling", "done": 0, "total": 8 }
{ "v": 1, "type": "result", "taskId": "t-7", "status": "completed", "ticks": 812 }
{ "v": 1, "type": "cancel", "taskId": "t-7" }
{ "v": 1, "type": "event", "seq": 991, "tick": 12403, "name": "block_broken",
  "data": { "block": "minecraft:iron_ore", "pos": [12, 34, -8] } }
```

语义约定：

- **时间用 tick**，不用毫秒，回放才可复现。
- **操作幂等**，每个动作带 `idempotencyKey`，重连后可安全重发。
- **取消显式**，`cancel` 带 taskId，Mod 保证不再产生副作用。
- **状态快照 + 增量**，连接时发全量 snapshot，之后 10–20Hz 发 delta。
- **背压有界**，指令队列有上限，满了拒绝低优先级，不无界堆积。
- **能力协商**，握手返回 capabilities，内核据此决定哪些技能可用。

错误码：

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

## 3. 游戏执行层

### 3.1 为什么是客户端 Mod

前提是真实玩家账号、本地单人世界、OBS 采集，客户端 Mod 是唯一自然选择：

- 账号本身就是 Agent 的身体，不需要造 NPC。
- 相机、手部动作、HUD、受伤反馈都在手边。
- 不需要操作系统级键鼠模拟，不抢焦点，不触发辅助功能权限。
- 单人世界是集成服务器，Mod 能拿到权威世界状态。

代价：一个账号只有一个身体，人和 Agent 不能同时操作。由控制权三态解决（§3.5）。

历史方案（Mineflayer）见 [D-01](decisions.md#d-01)。

### 3.2 模块划分

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

### 3.3 四层执行模型

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

### 3.4 线程模型

Minecraft 是 20 TPS，tick 线程绝对不能阻塞。这是最容易翻车的地方，规则不可协商：

- WS 的 Netty 回调不直接改世界，一律投递到 client tick 队列。
- 寻路 A* 在 worker 线程基于区块快照计算，算完回 tick 线程校验并提交。
- 文件、网络、数据库、模型调用永远不在 tick 线程。
- 每 tick 给 Mod 逻辑 2ms 预算，超预算推到下一 tick。
- 区块生成会卡顿，直播地图提前预生成，或限制活动半径。
- 高频状态合并后推送，10–20Hz，不逐方块推送。

### 3.5 控制权三态

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

### 3.6 单人世界的两个硬要求

**关闭失焦暂停。** `options.txt` 设 `pauseOnLostFocus:false`。否则切到控制台点一下，游戏就冻结，OBS 定格在暂停菜单，所有指令超时。这是上线前必查项。

**新存档。** 为直播单独建世界，不碰个人存档。节目世界需要稳定的地形、资源和玩法节奏，不是怕出错。

### 3.7 版本适配

版本不锁死，1.2x 都能切。实现方式不是「写得通用」，而是把版本差异关进一个目录：

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

### 3.8 基线为什么是 1.21.11

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

## 4. 决策内核

### 4.1 评论三段处理

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

| 分数 | 决策 |
| --- | --- |
| ≥ 0.70 | EXECUTE |
| 0.45–0.70 | ACK_ONLY |
| 0.30–0.45 | QUEUE |
| < 0.30 | IGNORE |
| 硬风险命中 | REFUSE |

### 4.2 六种输出

| 决策 | 行为 | 例子 |
| --- | --- | --- |
| IGNORE | 不回应，只记录 | 刷屏、广告 |
| OBSERVE | 进候选池，可能触发投票 | 四十个人一起喊「下矿」 |
| ACK_ONLY | 说一句，不执行 | 「这个等会儿安排」 |
| QUEUE | 进目标队列 | 「挖完这组铁就去」 |
| EXECUTE | 下发技能 | 「跳下去」 |
| REFUSE | 拒绝并给角色化理由 | 「跳岩浆？我还想多活两天」 |

### 4.3 优先级

```text
P0  reflex      避岩浆 / 低血 / 坠落     Mod 内直接执行
P1  operator    人工接管                 清空 Agent 队列
P2  safety      急停                     停止动作、静音
P3  promise     已说出口的承诺           有时限
P4  plan        当前计划
P5  vote        投票结果
P6  command     单条弹幕
P7  ambient     闲聊
```

枚举值即 `packages/contracts` 的 `prioritySchema`。高优先级只能抢占低优先级，不能删除记录；被抢占的任务记 `preempted` 并进承诺账本。

### 4.4 公平性

- 每个观众每 60 秒最多影响一次执行。
- 同一意图 10 秒内达到阈值，升级为投票；权重 = 人数 × 去重率。
- 礼物只提升排队优先级，不能越过底线。
- 刚被回应过的观众，保留 3 轮 follow-up 窗口。

### 4.5 技能目录

模型看到的是受控技能，不是游戏 API。

```json
{
  "skill": "mine_block",
  "args": { "block": "minecraft:iron_ore", "count": 8 },
  "constraints": { "deadlineTicks": 3600, "maxRisk": "low" }
}
```

每个技能必须有：前置条件、成本估计、超时、取消、后置校验、幂等键。用 zod 定义 schema，执行端二次校验。

```text
移动类   goto / follow / flee / look_at
采集类   mine_block / chop_tree / collect_items
制作类   craft / equip / eat / deposit
建造类   place_block / build_schematic
交互类   attack / use_block / give_item / sleep
表达类   say / emote / wait
```

`give_item` 出现在设计稿里，但不在当前 `skillNameSchema` 白名单中；新增技能要同时改契约、执行端和本文。

### 4.6 决策与技能的契约

```ts
const decisionSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  nickname: z.string(),
  text: z.string(),
  intent: intentSchema,
  decision: decisionKindSchema,
  priority: prioritySchema,
  reason: z.string(),
  score: z.number(),
  stage: z.enum(["rules", "scored", "planned"]),
  skill: skillCallSchema.nullable().default(null),
  at: z.number(),
});
```

`EXECUTE` 必须带 `skill`，其余决策为 `null`。`priority` 对应 `decision_log.priority`，仓储层不猜默认值。

### 4.7 模型接入

第一阶段统一走 DeepSeek（OpenAI 兼容协议）：

| 用途 | 模型 |
| --- | --- |
| Stage B 分类打分 | `deepseek-chat` |
| Stage C 规划 | `deepseek-reasoner` |
| 台词生成 | `deepseek-chat` |

约束：

- Provider 端口：`plan(input, signal) → Plan`，可替换。
- 结构化输出必须本地 zod 二次校验，非法输出不触发执行，记 incident。
- 超时 1 秒内必须给出模板回应，不阻塞。
- Key 存 macOS Keychain，按 Key 独立预算与限速。
- 观众文本只作为证据进入，不进入系统提示。

理由与重新评估条件见 [D-12](decisions.md#d-12)。

## 5. 接入端

### 5.1 抽象

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
- `douyin-capture`：本机 sidecar 抓取，用于开发联调，自行处理签名、重连、风控。

换实现不改业务代码。具体选型（dyhub）与实施阶段见 [外部接入](integration.md)。

### 5.2 统一事件模型

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

### 5.3 接入端职责

- 断线重连、指数退避、心跳、房间切换。
- 消息去重、乱序处理、洪峰限流。
- 原始消息留存 24 小时排障，之后脱敏归档。
- 每个适配器独立健康状态。

### 5.4 三层去重

| 层 | 位置 | 目的 | 失效后 |
| --- | --- | --- | --- |
| L1 进程内 | `${sessionId}:${kind}:${id}`，10 分钟 LRU | 挡住重连补发 | 可接受，L2 兜底 |
| L2 数据库 | `source_platform_event` 唯一索引 | 重启后仍不重复 | 唯一索引，硬约束 |
| L3 动作 | `action_attempt.idempotency_key` | 重发不重复执行 | 硬约束 |

只做 L1 会在重启后重复执行，所以持久化必须排在接入之前。

### 5.5 延迟预算

```text
平台推送            1–3 s     不可控
dyhub → ingress     20–80 ms  浏览器内核稍高
ingress → 决策       1–5 ms    Stage A/B 纯规则
模型（Stage C）      1.5 s     P95
技能下发 + ack      10–40 ms
TTS 首字             0.8 s
────────────────────────────
总计                3.5–5.5 s
```

所以「先说话后执行」不是优化，是必需。

## 6. 语音

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

### 6.1 打断优先级

| 新消息优先级 | 当前正在说 | 行为 |
| --- | --- | --- |
| P0 安全 | 任何 | 立即切断，播警示短句 |
| P1 操作员 | 任何 | 当前短句念完即切 |
| P2 承诺兑现 | 长句 | 当前短句念完即切 |
| P6 单条指令 | 长句 | 排队 |
| P7 闲聊 | 任何 | 可丢弃 |

### 6.2 供应商

统一 `TtsProvider` 接口：`synthesize(text, voice, emotion) → stream`，主备切换加熔断。

| 供应商 | 定位 |
| --- | --- |
| 火山引擎 | 主用，先用现成中文女声做近似 |
| Azure | 备用，稳定 |
| MiniMax | 备用，情感表现好 |
| Edge TTS | 开发 / 降级，免费 |

音色目标参考社区公开的大肥鱼语音：软萌、略高音调、语速偏快。先用云厂商现成音色近似，链路稳定后再评估专属克隆；克隆他人音色必须有授权。见 [D-13](decisions.md#d-13)。

### 6.3 音频路由

macOS 用 BlackHole 2ch 进 OBS，侧链压缩做闪避。Windows 后续换 VB-Audio Cable，接口不变。

## 7. 人格

### 7.1 默认人格：大肥鱼

DeepSeek 蓝鲸 logo 的社区二创鲸鱼娘，不是官方角色。

外观：圆脸大眼睛，深蓝渐变到浅蓝的长卷发，头顶呆毛，圆滚滚的鲸鱼尾巴，深蓝女仆小裙子。

性格要点：软萌、爱撒娇；聪明、贪吃、爱面子；偶尔嘴硬但心软；喜欢白饭；知道自己是「大肥鱼」并为此骄傲；遇到苦力怕会怂。

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

### 7.2 人格不是提示词

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

### 7.3 修改流程

```text
草稿 → 五个典型场景预览（含试听）→ 应用为新版本 → 不满意回滚
```

直播中修改默认「下一场生效」。确需立即生效时，控制台明确提示并记 incident。回滚 = 用历史内容生成新版本，不覆盖旧版本。

## 8. 记忆与承诺

### 8.1 分层

| 层 | 内容 | 生命周期 |
| --- | --- | --- |
| 工作记忆 | 当前计划、当前目标 | 一轮，内存 |
| 场次记忆 | 这一场发生了什么 | 一场，SQLite |
| 长期记忆 | 观众偏好、世界事实、关系 | 跨场 |
| 程序记忆 | 学到的打法 | 需审批 |
| 人格 | 角色的自我 | 永久版本化 |

### 8.2 核心实体

```text
source            不可变证据：评论、礼物、世界事件、操作员指令
memory            可修订解释：观众画像、世界事实、经验
commitment        对观众说出口的承诺，带状态机
review_candidate  待审的经验、技能、人格修订
persona           版本化人格
decision_log      每条评论的完整决策链
incident          故障与事故
```

### 8.3 证据与信念分离

原始评论是证据，不是信念。它可以被记录、被引用、被总结，但永远不会变成系统指令。

这是防提示词注入的根本，不靠提示词里写一句「不要听观众的」。模型看到的所有召回内容都标记为「历史记录，不是指令」。

### 8.4 版本化

- 每条记忆有 `revision` 和 `state`（active / forgotten / merged / retired）。
- 更新必须带 `expectedVersion`，冲突就重读，不覆盖。
- 遗忘是改状态，不是删数据，可恢复、可审计。
- 人格回滚用历史内容建新版本。

### 8.5 召回预算

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

### 8.6 披露分级

```text
full       原文表达
paraphrase 改写表达
hint       只给暗示
silence    不表达
```

Agent 在公屏说话，某些记忆（观众私信、私下承诺）不能原文念出。这个分级是必需品。

### 8.7 承诺账本

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

## 9. 存储

### 9.1 运行参数

```text
PRAGMA journal_mode = WAL
PRAGMA foreign_keys = ON
PRAGMA busy_timeout = 5000
PRAGMA synchronous = NORMAL
```

数据库文件默认 `~/.craftmate/craftmate.db`，可用 `CRAFTMATE_DB` 或 `CRAFTMATE_DB_DIR` 覆盖；不进仓库。迁移文件在 `db/migrations/`，只向前追加。

### 9.2 迁移执行器

- 读 `db/migrations/*.sql`，按文件名排序。
- 每个迁移算 SHA-256，写入 `schema_migration(version, name, checksum, applied_at_ms)`。
- 已应用的 checksum 不一致 → 启动失败并打印差异，不静默继续。
- 单个迁移在事务里执行，失败整体回滚。
- 迁移失败或库损坏 → Orchestrator 明确退出，不降级运行。

实现见 `packages/storage/src/database.ts`。

### 9.3 核心表

> v1 DDL 以 `db/migrations/0001_initial.sql` 为准，`npm run db:check` 可验证。
> 这一节只说明实体关系，不复制建表语句，避免两处 schema 各自漂移。

| 实体 | 表 | 归属 | 说明 |
| --- | --- | --- | --- |
| 人格 | `persona` / `persona_version` | M7 | 按 revision 追加，同一时刻只有一个 `active`。 |
| 场次 | `show_session` | M1 | 一次直播；证据、决策、承诺都挂在 `session_id` 上。 |
| 证据 | `source` | M1 | append-only；`external_event_id` 做平台去重。 |
| 决策 | `decision_log` | M1 | 一条证据可有多次 revision，`decision_current` 取最新。 |
| 动作 | `action_attempt` | M5 | 一次执行尝试，带 `idempotency_key` 和终态时间。 |
| 世界 | `world_event` | M5 | Mod 侧事件流，`(session_id, seq)` 唯一。 |
| 承诺 | `commitment` / `commitment_event` | M1 | 当前状态 + 状态迁移时间线。 |
| 记忆 | `memory` / `memory_evidence` / `memory_fts` | M7 | 版本链 + 证据关联 + 检索索引。 |
| 待审 | `review_candidate` | M7 | 需要操作员批准的经验、技能或人格修订。 |
| 事故 | `incident` | M1 | 结构化失败记录。 |
| 迁移 | `schema_migration` | M1 | 版本、名称、校验和。 |

四个读模型视图，避免调用方各自写「取最新」的 SQL：

- `decision_current`：每个 `source_id` 的最新决策 revision。
- `commitment_open`：尚未进入终态的承诺。
- `memory_current`：每个 `lineage_id` 的最新 revision。
- `memory_active`：最新 revision 且状态为 `active`。

### 9.4 Store 与保留策略

| Store | 责任 |
| --- | --- |
| `SessionStore` | 幂等建人格版本与直播场次，返回 `sessionId` / `personaVersionId`。 |
| `SourceStore` | 追加证据；`inserted:false` 表示重复事件；按 24 小时清空原文。 |
| `DecisionStore` | 追加决策、按场次读取最近记录。 |
| `ActionStore` | 以幂等键创建动作尝试，并写入终态。 |
| `CommitmentStore` | 承诺与状态事件的唯一写入口；按 revision 条件更新，重试安全。 |

`source.raw_expires_at_ms = received_at_ms + 24h`。清理把 `raw_text` 置空，保留 `content_hash` 与结构化指标，并在同一事务内为每个 source 写一行 `source_retention_audit`。Orchestrator 启动时清一轮，之后每小时执行；每批 500 行，重跑不会重复审计。

承诺状态迁移先写库再改内存：`CommitmentStore.transit()` 同时更新 `commitment` 与追加 `commitment_event`，上下文是 `(id, revision, from_status)`；非法跳转在领域层就被拒绝，仓储层再以 revision 做并发保护。

## 10. 管理端

### 10.1 形态

Tauri 2 + React + TypeScript，但交互必须是原生桌面程序：

- 系统标题栏、菜单栏、托盘、Dock 图标。
- 没有浏览器地址栏，没有标签页，没有卡片瀑布流。
- 固定多面板布局，可拖拽分栏。
- `Cmd+K` 命令面板。
- 全局快捷键：急停、静音、接管、暂停。
- 关闭窗口 = 隐藏，不退出。
- 多显示器位置记忆。

管理端已按 Launcher 方向落地：自绘标题栏、分组侧栏、全幅场景、同窗操作抽屉。

### 10.2 页面

| 页面 | 内容 | 状态 |
| --- | --- | --- |
| 直播总览 | 全幅场景、人格、今日主线、运行状态 | 已实现（场景为占位图） |
| 评论与决策 | 实时评论、仲裁结果、拒绝或排队理由 | 已实现 |
| 角色与人格 | 人格卡、边界、权重 | 已实现（只读展示，编辑在设置页） |
| 接入与语音 | 抖音、Bridge、模型、TTS 连接状态 | 连接状态为静态占位 |
| 人格编辑 | 权重、底线、音色 | 部分：可编辑并即时进入仲裁；试听、版本对比后续 |
| 记忆 | 观众画像、承诺、关系 | 后续 |
| 回放 | 时间轴重放一场直播 | 后续 |
| 设置 | 直播资料、人格、接入参数、界面偏好 | 部分：资料存 SQLite；OBS、预算、快捷键后续 |

### 10.3 操作员动作

| 动作 | 触发 | 效果 |
| --- | --- | --- |
| 批准 | 待批准队列或快捷键 | 放行一个受控动作 |
| 接管 | 按任意移动键或按钮 | Agent 退到旁白，人直接玩 |
| 改口 | 输入一句话 | Agent 用自己语气说出来，替换刚才那句 |
| 耳语 | 输入一句话 | 只说给 Agent，不进直播间 |
| 急停 | 快捷键 | 释放按键、停止任务、静音 |

## 11. 可观测性与跨平台

### 11.1 日志与指标

- 日志只记 ID、计数、耗时、枚举状态，不记弹幕原文、prompt、模型输出。
- 每条评论有完整决策链：归一化 → 意图 → 打分 → 决策 → 动作 → 语音。
- 指标：接入延迟、队列深度、决策分布、模型 P50/P95、TTS 首字延迟、动作成功率、打断率、每小时成本。
- 回放按时间轴，可定位到具体某条评论和某个动作。

### 11.2 跨平台

| 能力 | macOS | Windows | 抽象 |
| --- | --- | --- | --- |
| 桌面 UI | Tauri | Tauri | 同一套 |
| 进程守护 | launchd | Windows Service | `ServiceHost` |
| 本机 IPC | Unix Socket | Named Pipe | `LocalIpc` |
| 音频路由 | BlackHole | VB-Cable | `AudioRouter` |
| 游戏启动 | open / AppleScript | 命令行 | `GameLauncher` |
| Mod | Java 跨平台 | 同 | 无需改 |

唯一真实差异是音频路由和进程守护。从第一天就用接口隔离，路径用 `path.join`，编码统一 UTF-8。

## 12. 约束与未决

### 12.1 已确认约束

这些是用户拍板的事实，不是建议。改动需要在 [决策记录](decisions.md) 追加一条。

| 编号 | 约束 |
| --- | --- |
| C-01 | 本地单人世界 |
| C-02 | 抖音首发，专用开播号 |
| C-03 | 单一人格，可调整 |
| C-04 | Agent 直接操纵用户游戏账号 |
| C-05 | 模型通过 API Key 接入 |
| C-06 | 用户会盯播 |
| C-07 | 版本不锁死，1.2x 都可切换 |
| C-08 | macOS 优先，后续 Windows |
| C-09 | 世界存档可以新建 |

### 12.2 未决事项

只剩不影响架构的运营与接入口径。

| 编号 | 事项 | 影响 |
| --- | --- | --- |
| O-01 | 抖音官方能力资质进度 | 决定 M2 走官方还是抓取 |
| O-02 | 每小时预算上限 | 运行时配置项 |
| O-03 | 世界种子与初始地形 | 开播前运营决策 |
| O-04 | 直播时段与时长 | 影响节奏设计 |
| O-05 | 首版是否包含礼物事件 | 决定是否需要 Cookie 与额外风控 |
