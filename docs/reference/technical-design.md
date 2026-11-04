# 技术设计

> 本文是实现细节真源：参数、协议、决策内核、模型、语音、人格、记忆。系统边界见[架构总览](architecture.md)，启动与排错见[运行手册](../operations/runbook.md)。

## 1. 关键参数

| 事项 | 取值 | 详见 |
| --- | --- | --- |
| 游戏 | Minecraft Java 1.21.11 + Fabric Loader 0.20.1 | §3 |
| 运行时 | Node.js ≥ 22.5、TypeScript、zod | §4 |
| 管理端 | Tauri 2 + React | §10 |
| Orchestrator | `127.0.0.1:4321`，`/control`、`/ingress`、`/bridge` | §2 |
| Voice | `127.0.0.1:4323/voice` | §6 |
| 模型 | DeepSeek / OpenAI 兼容协议 | §5 |
| 语音 | 豆包 Seeduplex WebSocket | §6 |
| 存储 | SQLite WAL + FTS5 | §9 |
| 时间 | 协议用 tick，数据库用 epoch ms | §2 |

## 2. 本机协议

### 2.1 安全

- 所有监听默认 `127.0.0.1`，HTTP upgrade 分路径鉴权。
- Orchestrator、Ingress、Voice 共用 `~/.craftmate/ingress-token`；Bridge 使用
  `~/.craftmate/bridge.token`。文件权限 `0600`。
- `/ingress` 与 `/voice` 要求 loopback 和正确 `hello.token`，失败分别以 `4401` 关闭。
- 所有帧先经 zod 校验；非法协议消息断开并记录 incident。

### 2.2 控制面

```ts
// client -> orchestrator
{ type: 'hello' }
{ type: 'comment', payload: AudienceEvent }
{ type: 'operator', payload: { kind: 'whisper' | 'takeover' | 'release' | 'stop', text: string } }

// orchestrator -> client
{ type: 'ready', payload: { persona: PersonaSummary, snapshot: ShowSnapshot } }
{ type: 'decision' | 'stats' | 'snapshot' | 'operator' | 'source' | 'voice' | 'subtitle' | 'error', payload: ... }
```

### 2.3 Ingress

```ts
// ingress -> orchestrator
{ type: 'hello', role: 'ingress', token: string }
{ type: 'event', payload: AudienceEvent }
{ type: 'health', payload: SourceHealth }

// orchestrator -> ingress
{ type: 'ready' } | { type: 'error', payload: { code: string, detail: string } }
```

### 2.4 Bridge v1 摘要

```json
{ "v":1, "type":"hello", "token":"...", "capabilities":["camera","build"], "skills":["mine_block"] }
{ "v":1, "type":"welcome", "sessionId":"s-1", "heartbeatMs":1000, "watchdogMs":500 }
{ "v":1, "type":"cmd", "id":"c-42", "op":"mine_block", "args":{"block":"minecraft:iron_ore","count":8}, "deadlineTick":12400, "idempotencyKey":"plan-17-s3" }
{ "v":1, "type":"ack" | "progress" | "result" | "cancel" | "event", "...": "..." }
```

- 时间用 tick；坐标和方块用语义 ID，不暴露 Java 类型。
- 每个动作带 `idempotencyKey`；取消带 taskId，且不得继续产生副作用。
- 队列有界，满时拒绝低优先级；能力白名单决定可下发技能。

错误码集合：`E_SCHEMA`、`E_UNKNOWN_OP`、`E_PRECONDITION`、`E_BUSY`、`E_TIMEOUT`、
`E_CANCELLED`、`E_WORLD_CHANGED`、`E_PERMISSION`、`E_INTERNAL`。完整语义见
[Bridge 设计](bridge.md)。

## 3. 游戏执行层

`mods/craftmate-body` 是 Fabric 客户端 Mod。

### 模块

```text
core       协议、状态机、预算，禁止 Minecraft 类型
api        WorldView / PlayerOps / CameraOps / HudOps / EventSource
compat     Mixin、映射和版本差异
sensor     tick 采样并聚合
reflex     安全规则，最高优先级
behavior   可取消长任务
actuator   单 tick 原子操作
nav        寻路计算与提交
camera/hud 演出与状态
control    Agent / Operator / None 三态仲裁
```

### 硬规则

- tick 线程不访问文件、网络、数据库或模型；每 tick 逻辑预算 2ms。
- 寻路在 worker 线程基于区块快照计算，回 tick 线程校验提交。
- 世界状态先合并再推送，目标频率 10–20Hz。
- `pauseOnLostFocus:false`；直播必须使用专用存档。
- `fabric.mod.json` 只声明实测版本范围。

基线选 1.21.11 是因为当前 Fabric 生态和真实身体在该版本完成开发验证；换版本时新增
compat，不改 core。

## 4. 决策内核

### Stage A

零模型、零网络，处理：

- 空文本、过长文本、控制字符和不可打印内容。
- 注入短语、角色覆盖、系统指令声称。
- 冷却、重复输入、非指令事件。

### Stage B

确定性意图分类和打分：

```text
score = intentConfidence * personaWeight + salience - fatiguePenalty
```

输出按优先级排序；同意图可累计投票，被近期回应过的观众进入跟进窗口。

### Stage C

只对胜出意图调用模型，输出 JSON 计划：

- `speech`：给观众的话。
- `skill`：可选技能，必须通过契约校验和当前能力白名单。
- 非法技能允许一次契约纠正；再失败写入 incident 并降级模板。

六种仲裁输出是 `ignore`、`observe`、`reply`、`queue`、`execute`、`reject`。

## 5. 模型接入

| 变量 | 说明 |
| --- | --- |
| `CRAFTMATE_MODEL_URL` | OpenAI 兼容端点 |
| `CRAFTMATE_MODEL_KEY` | Bearer API Key；未设置则不调用 |
| `CRAFTMATE_MODEL` | 模型名 |
| `CRAFTMATE_MODEL_PROVIDER` | 成本账本中的 Provider 名 |
| `CRAFTMATE_MODEL_TIMEOUT_MS` | 请求超时；超时降级模板 |
| `CRAFTMATE_MODEL_PRICE_IN` / `_OUT` | 每百万 token 单价 |
| `CRAFTMATE_MODEL_HOURLY_LIMIT` | 滚动一小时预算 |
| `CRAFTMATE_MODEL_KEY_LIMIT` | 单 Key 累计预算 |

观众文本只放在用户 JSON 字段；系统提示只包含人格、技能契约和输出格式。成本按小时
与 Provider 记账，超预算不调用模型。

## 6. 语音

Voice 只接收 Orchestrator 的已批准台词。

```text
decision + commitment -> utterance -> sentence queue -> Seeduplex -> PCM player
```

| 事项 | 规则 |
| --- | --- |
| Provider | 只使用 `volcengine-realtime`；旧一次性 TTS 已删除 |
| 协议 | 每句建立会话，`session.create` + `speech_text_buffer.commit` |
| 音频 | 接收 24kHz `pcm_s16le`，会话结束前流式播放 |
| 抢占 | 高优先级可在短句边界打断；`stop` 清空队列并中止当前会话 |
| 失败 | 上报 `E_AUDIO_PLAYBACK` 或供应商错误，不伪造 `spoken` |

配置项见[外部集成](../guides/integrations.md#豆包-seeduplex-实时语音)。

## 7. 人格

人格是版本化结构，不是普通提示词。

| 分区 | 作用 |
| --- | --- |
| identity | 名字、身份、长期形象 |
| values | 判断偏好和优先级 |
| style | 句长、称呼、节奏、禁忌 |
| boundaries | 不执行的内容和表达边界 |
| weights | 进入 Stage B 的可量化权重 |

版本只追加；修改权重会改变仲裁结果，回滚激活旧版本但不覆盖历史。当前默认人格是社
区二创「大肥鱼」。

## 8. 记忆与承诺

### 记忆

```text
Source（不可变证据，可过期原文）
  -> ReviewCandidate（待审）
  -> Memory revision（批准后版本化）
```

- Stage C 只召回 `active` 且已批准的记忆。
- 召回预算约 1200 token，超限按分区裁剪。
- 观众证据按哈希引用，避免原文进入提示；不自动把对话写入长期记忆。

### 承诺

```text
reserve(session, utterance, traceId)
  -> 落库 reserved
  -> voice speaking
  -> spoken
  -> fulfilled | failed | expired | retracted
```

写事务先于语音播放；Voice 播放前以只读连接校验承诺存在且未关闭。

## 9. 存储设计

数据库约定、对象清单、迁移和保留策略见[数据模型](data-model.md)。要点：

- SQLite WAL、外键开启、`busy_timeout=5000`。
- 证据 append-only；记忆、人格、承诺用版本或事件保留历史。
- 原始评论 24 小时置空，保留哈希、ID、结构化指标和清理审计。
- 仓储不猜决策默认优先级；契约 `Decision.priority` 必填。

## 10. 管理端

- React 通过 `/control` 接收快照、决策、健康、语音与字幕。
- Tauri 只承载窗口，不复制业务逻辑。
- 设置写入 SQLite 或本机私有配置；凭据保存后脱敏展示。
- 操作员指令为 `whisper`、`takeover`、`release`、`stop`，急停后必须显式交还。

## 11. 测试策略

| 层 | 覆盖 |
| --- | --- |
| 契约 | zod 往返、非法输入、Bridge 帧 |
| 领域 | Stage A/B、承诺、人格、规划降级 |
| 基础设施 | 存储迁移、恢复、去重、保留审计、成本 |
| 服务 | 控制面、Ingress supervisor、Voice 协议、播放反馈 |
| 数据库 | 内存库和真实 WAL 文件库校验 |

测试命令与最新证据见[验证清单](../operations/verification.md)。
