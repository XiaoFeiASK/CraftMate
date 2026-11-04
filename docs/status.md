# 实现状态

> 本文只回答两件事：**现在能跑什么**，**还差什么**。是事实清单，不是计划。
> 下一步做什么看 [交付计划](delivery-plan.md)，架构设计看 [架构纵览](architecture.md)。

判定标准：

- **已实现**：能在这台机器上用仓库里的命令复现。
- **部分**：主路径存在，但关键环节仍是模拟、占位或未经真实环境验证。
- **未实现**：没有代码占位。

最后核对：2026-11-04，分支 `fix/issue-32-ai-agent-implementation`。真实服务和游戏的验收与自动化测试分开记录。

## 1. 验证基线

```bash
npm install
npm run typecheck
npm test
npm run build
npm run db:check
npm run db:check:file
```

2026-11-03 的 [CI](https://github.com/XiaoFeiASK/CraftMate/actions/runs/41637021532) 在 `c0c0562` 上通过类型检查、测试、控制台构建及两种数据库检查。2026-11-04 合并前在本机重新验证了当前分支：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 182 项通过，0 失败 |
| `npm run build` | 通过 |
| `npm run db:check` | 27 个对象 / 23 个索引，通过 |
| `npm run db:check:file` | 真实 WAL 文件库通过 |
| `./gradlew build` | Fabric Mod 构建通过 |
| `swiftc -typecheck` | PCM 流播放器通过 |

该 CI 不包含真实直播间、模型、音频、Minecraft 或桌面安装包验收。

## 2. 当前状态

### 2.1 管理端 `apps/admin-console`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 启动器式单窗口布局 | 已实现 | 自绘标题栏、分组侧栏、全幅场景、同窗操作抽屉。 |
| 场景主视觉 | 部分 | 游戏未连接时明确显示离线状态；连接后不播放演示素材。直播画面采集仍未实现。 |
| 实时评论 / 决策流 | 已实现 | 通过 WebSocket 接收 `decision` 与 `snapshot`。 |
| 连接状态与自动重连 | 已实现 | 指数退避，有单测。 |
| 操作员四类指令 | 已实现 | 接管、交还、急停、耳语；急停后需显式交还。 |
| 直播资料设置 | 已实现 | 主线、进度、世界、版本与人格可写入 SQLite；接入凭据写入本机私有配置并脱敏展示。 |
| 界面偏好 | 已实现 | 主题、字号、强调色、减弱动效；存本机 `localStorage`，即时生效。 |
| 人格展示 | 已实现 | 展示身份、语气、价值观、边界、音色与权重条；权重修改会进入仲裁。 |
| 接入与语音面板 | 已实现 | 模型、抖音和端到端实时语音均可在设置中新增与修改，保存后热更新。 |
| 服务端错误提示 | 已实现 | `error` 消息显示在接入面板，不再静默丢弃。 |
| 记忆 / 回放 | 已实现 | 侧栏「记忆与版本」「回放」：审核/忘记记忆、人格版本回滚、按 traceId 查时间轴。 |
| Stage C 展示 | 已实现 | 决策流显示 `speech`、技能名、provider/model/耗时与降级标记。 |
| Bridge 状态 | 已实现 | 「接入与语音」显示身体、控制权与队列，数据来自 `/bridge` 健康快照。 |

### 2.2 桌面宿主 `apps/desktop-shell`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Tauri 2 外壳与窗口配置 | 已实现 | 1280×800，承载 admin-console 构建产物。 |
| 窗口控制 API | 已实现 | 前端调用 Tauri Window API，非 Tauri 环境降级为无操作。 |
| 本机实际启动 | 已实现 | macOS 窗口可启动并连上 Orchestrator。 |

### 2.3 控制面 `services/orchestrator`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| WebSocket 控制服务 | 已实现 | `/control`，`hello` 握手，消息 zod 校验。 |
| 健康检查 | 已实现 | `GET /health`，返回运行统计。 |
| 监听地址与端口 | 已实现 | 默认 `127.0.0.1:4321`，`CRAFTMATE_HOST` / `CRAFTMATE_PORT` 可覆盖。 |
| 启动时接入 SQLite | 已实现 | `createPersistentShow()` 建库、跑迁移、恢复最近决策与未完成承诺。 |
| `/ingress` 通道 | 已实现 | 只接受 loopback + 共享 token；`hello` 后才收 `event` / `health`，失败会明确关闭并记日志。 |
| `/bridge` 装配 | 已实现 | 已挂载至 Orchestrator 的 HTTP upgrade；没有真实身体时如实显示未连接。 |
| Voice 链接 | 已实现 | 启动时连接 `ws://127.0.0.1:4323/voice`，转发 `speak` / 急停并广播状态与字幕。 |
| 真实抖音接入 | 部分 | 管理端保存房间号、dyhub 地址后会启停 Ingress；dyhub 与真实房间仍需现场联调。 |

### 2.4 契约 `packages/contracts`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 观众事件 schema | 已实现 | 评论、礼物、点赞、进场、在线人数。 |
| 决策 schema | 已实现 | 含 `priority` 与可空 `skill`。 |
| 优先级 schema | 已实现 | 8 级枚举，已进入 `Decision`。 |
| 控制面消息 | 已实现 | 客户端/服务端判别联合，含 `speak`、`voice`、`subtitle`，有往返测试。 |
| Ingress 契约 | 已实现 | `hello` / `event` / `health`，服务端 `ready` / `error`，含关闭码。 |
| Voice 契约 | 已实现 | 统一 `VoiceUtterance` / `VoiceEvent` / `VoiceStatus`，字幕与语音共用同一文本。 |
| Bridge v1 完整帧 | 已实现 | `hello` / `welcome` / `cmd` / `ack` / `progress` / `result` / `cancel` / `event` / 心跳 / 所有权，含 schema 与往返测试。 |
| 逐技能参数 schema | 已实现 | `skillArgsSchema` 覆盖 19 个技能，`skillCallSchema` 在解析时校验 `args`。 |
| 运营数据契约 | 已实现 | `opsSnapshotSchema` / `replayResponseSchema` / `bridgeHealthSchema`。 |
| 来源健康状态 | 已实现 | `SourceHealth` 进入 `ShowSnapshot`，并有 `source` 消息。 |

### 2.5 Agent 内核 `packages/agent`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Stage A 规则闸门 | 已实现 | 空消息、注入、冷却、礼物、非指令事件。 |
| Stage B 打分 | 已实现 | 意图置信度 + 人格权重 + 阈值，纯确定性。 |
| 仲裁决策 | 已实现 | 六种决策 + 优先级排序，无模型调用。 |
| 人格结构 | 已实现 | 结构化人格、权重、边界；当前只有「大肥鱼」一个实例。 |
| 承诺账本 | 已实现 | 状态机禁止跳过「说出口」；写端口先落库再更新内存，启动时恢复未完成承诺。 |
| 场次编排与运行模式 | 已实现 | `agent` / `operator` / `stopped` 三态。 |
| 持久化写端口 | 已实现 | `ShowRecorder` 端口；先写 source，再仲裁，再写 decision。 |
| Stage C 规划与模型 | 已实现 | `Planner` + `OpenAICompatibleProvider`；超时模板保底，坏输出记 incident，技能还必须属于当前游戏身体声明可执行的白名单。 |
| 记忆召回 | 已实现 | 仅召回已批准且 active 的记忆，按约 1200 token 预算裁剪，按哈希观众引用过滤。 |
| 成本预算 | 部分 | 按小时和 provider 汇总已记录成本，超限改走模板；“Key”尚未区分实际 API Key。 |

### 2.6 存储 `packages/storage` + `db/`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| v1 schema | 已实现 | `0001`–`0006`（含规划字段、成本账本），27 个对象 / 23 个索引。 |
| 约束与视图校验 | 已实现 | `npm run db:check`，内存库与真实 WAL 文件库两种模式。 |
| 连接与迁移执行器 | 已实现 | WAL、外键、`busy_timeout`；checksum 漂移直接失败。 |
| `SessionStore` / `SourceStore` / `DecisionStore` / `ActionStore` / `SettingsStore` / `CommitmentStore` | 已实现 | 启动恢复、事件去重、决策落库、动作幂等、按场次保存配置、承诺状态迁移。 |
| 存储层自动化测试 | 已实现 | 覆盖去重、重启恢复、承诺恢复与非法迁移、保留审计、空库/升级/checksum 漂移。 |
| 承诺落库 | 已实现 | `reserve → spoken → …` 在同一事务写状态和事件；重启由 `commitment_open` 恢复。 |
| 记忆与待审仓储 | 已实现 | `MemoryStore` 把草稿停在 `review_candidate`，批准后才写 `memory` 与证据。 |
| 人格版本 | 已实现 | `PersonaVersionStore` 追加版本、激活旧版、不覆盖历史。 |
| 回放查询 | 已实现 | `ReplayStore` 按 traceId 合并来源/决策/承诺/动作，不依赖内存缓冲。 |
| 成本账本 | 已实现 | `0006_model_cost` + `CostStore`，滚动一小时查询。 |
| 保留策略执行 | 已实现 | 启动时先清一轮，之后每小时按批清理；原文置空、哈希保留、逐条写审计。 |

### 2.7 接入端 `services/ingress`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| dyhub 订阅 | 已实现 | 订阅 `/ws?roomId=…&types=…`，事件到达即回调，不是轮询。 |
| 事件归一化 | 已实现 | `chat` / `gift` / `member` / `like` / `room` → `AudienceEvent`；`roomStatus` 转健康状态。 |
| 去重与背压 | 已实现 | 10 分钟内存去重、每秒上限、512 有界队列，礼物与人气优先保留。 |
| 重连与健康 | 已实现 | 指数退避 1s→30s，健康推到 orchestrator，再广播给控制台。 |
| `/health` | 已实现 | `GET :4322/health`，返回源状态、计数、丢弃原因、上游连接。 |
| 端到端自动化测试 | 已实现 | 本地测试用 dyhub stand-in 覆盖订阅、断线重连、房间关闭、坏输入与洪峰；正式启动不注入假来源。 |
| 真实房间联调 | 未实现 | 尚未接 dyhub 实机校准字段映射。 |

### 2.8 语音 `services/voice`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 分句 | 已实现 | 按句末与软边界切分，单句不超过 35 字；有单测。 |
| 有界优先级队列 | 已实现 | 队列满时淘汰最低优先级的排队项；高优先级可在短句边界抢占。 |
| 急停与取消 | 已实现 | `stop` 清空队列并中止当前合成/播放，状态如实上报 `cancelled`。 |
| 端到端实时语音 | 已实现 | 豆包 Seeduplex WebSocket，`session.create` + `speech_text_buffer.commit`，原始 `pcm_s16le` 在会话结束前直接送入流式播放器。 |
| 字幕与状态 | 已实现 | `speaking` 先于合成发出并用于更新承诺状态；失败保留可诊断错误，不伪造播放。 |
| 配置失效策略 | 已实现 | 未配置或配置错误时语音明确不可用，不降级到旧 HTTP TTS 或伪造语音。 |
| 鉴权与 loopback | 已实现 | 与 Orchestrator 共用 `~/.craftmate/ingress-token`，伪造 token 以 4401 关闭。 |
| 真实 TTS 供应商 | 已实现 | Seeduplex 已完成真实鉴权、PCM 合成、首包延迟和一次真实 `spoken` 事件；管理端保存后可热切换。 |
| 本机音频输出 | 部分 | 真机曾完成 `spoken`，也多次返回 `AudioQueueStart failed (-66681)`；Voice 会如实上报 `E_AUDIO_PLAYBACK`，设备与路由仍需现场校准。 |
| 音频路由 | 未实现 | BlackHole / OBS 侧链压缩需手工配置，未自动化。 |
| 决策自动说话 | 已实现 | Stage C 产出 `speech` 后，先落库承诺再交给 Voice；操作员接管/急停时不开口。 |
| 承诺闸门 | 已实现 | Voice 进程以只读方式打开数据库校验承诺；库不存在或已关闭时拒绝播放。 |

### 2.9 Bridge `packages/bridge` + `packages/bridge-mcpfabric`

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Wire 协议 v1 | 已实现 | 完整帧、能力协商、错误码、幂等键与 fail-closed token 校验。 |
| 协调器与队列 | 已实现 | 有界队列、单运行项、终态不可逆、接管/急停取消全部未完成项。 |
| 控制权 | 已实现 | sticky owner 跨 socket 重连；显式 release 才恢复 Agent；旧 generation 被拒绝。 |
| 看门狗 | 已实现 | 默认 250ms 心跳，2s 无心跳时本地释放按键；断线释放输入；自停状态跨重连保持。 |
| 动作记账 | 已实现 | `MemoryActionPort` 与复用 `action_attempt` 的 `SqliteActionPort`。 |
| WebSocket 适配 | 已实现 | `createBridgeUpgrade()` 挂到既有 HTTP server，不另开监听端口。 |
| 测试替身 | 测试专用 | `SimBody` 只服务自动化协议测试，不进入正式启动或管理端。 |
| 接入 Orchestrator | 已实现 | `/bridge` 已挂在控制面 HTTP upgrade 上，健康快照每 2 秒广播给控制台。 |
| MCPFabric 适配清单 | 部分 | 静态候选映射与声明校验尚未接入运行时，也未验证真实 MCPFabric 的工具和安全能力。 |
| 真实 Fabric Mod | 已实现 | `mods/craftmate-body` 支持 Minecraft 1.21.11 / Fabric Loader 0.20.1；HMCL 配置的真实开发实例已连接、上报世界快照，并接受 `mine_block` 进入执行状态机。 |
| 真机与长时验收 | 未完成 | 方块最终删除、窗口失焦、tick 零 I/O、60 分钟与 4 小时均未验证；最近一次挖矿因目标遮挡终止，不能记为成功。 |

## 3. 已知缺口

按「会不会让下一步做错」排序，不按工作量。

1. **真实抖音房间未校准**。断线、房间关闭、洪峰已有自动化测试，但 `gift` 的
   `repeatCount` / `groupCount` 仍需一次实机联调证伪。
2. **模型已可用，但长时间 JSON 稳定性待压测**。YYAPI/DeepSeek 已完成真实请求验证；
   价格和长时成功率仍需实播采样。
3. **音频路由未配置**。Seeduplex 已返回真实 PCM、产生真实 `spoken`，同时存在
   macOS `AudioQueueStart` 失败；BlackHole 与 OBS 仍需手工配置，首字延迟 P95
   需实播采样。
4. **真实动作与长时验收未完成**。HMCL/Fabric 真实世界已连接，暂停界面的就绪
   判定已修正，但方块最终删除、实际移动结果、窗口失焦和 60 分钟稳定性仍需逐项验收。
5. **长时与故障注入未做**。60 分钟彩排、4 小时稳定、镜头/切片都没有运行报告。
6. **记忆目前靠人工提案**。没有从对话自动沉淀经验的技能，召回只有主体过滤，FTS 排序
   尚未使用。

方向 A 的 M1 已闭合：承诺恢复、去重收敛（内存 2000 条快速路径 + 数据库裁决）、
有界观众历史（500 人 / 每意图 200 样本）、保留清理与审计、迁移升级测试。2026-11-03
另用 `~/.craftmate/craftmate.db` 的副本做了一次 v6 升级与进程重启：迁移数未增加、
6 条旧决策仍在、新建的 `spoken` 承诺在第二次启动后仍可读回。
M3/M4 的「开口前已落库」有自动化（`speech.test.ts`）与真实进程（Orchestrator +
Voice 不可用状态）两条证据。

## 4. 明确不存在的东西

避免接手的人误以为有代码可读：

- 没有 `services/supervisord`。
- BlackHole / OBS 仍需手动配置；真实抖音房间和真实 Minecraft 身体仍待现场联调。
- `mods/craftmate-body/` 是真实 Fabric 工程；测试替身不进入正式启动。
- 没有 embedding，没有向量库；模型只有 OpenAI 兼容 Provider 一个实现。
- 没有 OBS 集成，没有抖音开放平台 SDK。
- GitHub Actions CI 已覆盖 Node 类型检查、测试、控制台构建和数据库 schema 校验；没有桌面端多平台打包、Fabric Mod 集成测试或发布流水线。

这些东西出现时，本文对应行必须同步改成「已实现」或「部分」，否则就是文档落后于代码。
