# 运行手册

> 目标：从新环境启动 CraftMate，并知道每个进程、数据位置和常见错误。已验证范围见[验证清单](verification.md)。

## 1. 依赖

| 依赖 | 版本 | 必需性 |
| --- | --- | --- |
| Node.js | ≥ 22.5 | 必需 |
| npm | 随 Node | 必需 |
| Rust / Cargo | stable | 仅桌面窗口；无 Rust 用 `--web` |
| Minecraft + Fabric | 1.20.1 / Loader ≥0.15.11 / API 0.92.2+1.20.1 | 仅游戏动作 |
| OBS / BlackHole | — | 仅推流；当前手工配置 |

```bash
node -v
npm install
```

## 2. 启动

```bash
./start.command            # Orchestrator + Voice + Tauri 桌面窗口
./start.command --web      # Orchestrator + Voice + 浏览器预览
./start.command --web --no-open
./stop.command
./stop.command --dry-run
```

`start.command` 会检查 Node 版本、按需安装依赖并加载根目录 `.env`。也可以启动单个
进程：

```bash
npm run dev                 # 跳过启动器检查
npm run dev:orchestrator
npm run dev:voice
npm run dev:console
npm run dev:desktop         # 只启动桌面宿主
```

空场默认只生成环境台词，身体侧的空闲游走负责移动。设置
`CRAFTMATE_IDLE_GOAL=1` 后，评论空窗 90 秒且身体在线时会自动建立一个
「空场自由生存」目标，交给 `GoalRuntime` 推进；开启期间观众指令会进入
「观众提议」收件箱，而不是直接执行。设回 `0` 或重启即可恢复默认。

节拍间隔可用 `CRAFTMATE_IDLE_BEAT_MS`（默认 45000）和
`CRAFTMATE_REACTION_COOLDOWN_MS`（默认 30000）调整；小于 1000 的值会被忽略。

### 2.1 Minecraft 1.20.1 身体

当前开发环境使用单独启动的 1.20.1 服务端和 Fabric 客户端，不把游戏进程塞进
`start.command`：

| 进程 | 本机示例 | 说明 |
| --- | --- | --- |
| CraftMate Orchestrator | `127.0.0.1:4321` | 控制面与 `/bridge` |
| Minecraft 客户端 | `127.0.0.1:4324` | 可选录制/调试；不是 Agent 依赖 |
| Minecraft 服务端 | `25599` | 当前测试世界，客户端用快速连接进入 |

构建并更新客户端 Mod：

```bash
cd mods/craftmate-body
./gradlew build
cp build/libs/craftmate-body-0.1.0.jar \
  "$HOME/MC/.minecraft/mods/craftmate-body-0.1.0.jar"
```

客户端需要 Minecraft 1.20.1、Fabric Loader `>=0.15.11`（当前验证实例为 0.20.1）、
Fabric API `0.92.2+1.20.1`。服务端可以是原版 1.20.1；技能由客户端 Mod 执行，
但服务端仍负责最终方块、实体和容器结果。更新 jar 后必须重启客户端，不能只退出
世界，否则旧类仍留在 JVM 中。

服务端世界关闭“失焦暂停”，并使用专用存档；服务端端口、是否正版验证和世界名只
属于现场配置，不写入 Bridge 契约。

## 3. 服务与端口

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| Orchestrator | `http://127.0.0.1:4321/health` | `/control`、`/ingress`、`/bridge` |
| Ingress | `http://127.0.0.1:4322/health` | 由 Orchestrator 自动托管 |
| Voice | `http://127.0.0.1:4323/health` | WebSocket `/voice` |
| Vite | `http://127.0.0.1:5173` | 浏览器开发界面 |

Orchestrator、Ingress、Voice 共用 `~/.craftmate/ingress-token`；Bridge 使用
`~/.craftmate/bridge.token`。服务配置在管理端「设置 → 接入」修改；模型、语音和抖音
细节见[外部集成](../guides/integrations.md)。

`4324` 是身体侧可选的本地录制/调试端口，不是管理端依赖。管理端首屏、控制面和
Bridge 在主路径都不会请求它；没有 Minecraft 客户端时工作台会显示身体未接入。

## 4. 配置与环境

仓库 `.env` 只作首次默认值，已被 `.gitignore` 忽略；shell 环境变量优先。`.env.example`
列出变量模板。

| 变量 | 默认 / 示例 | 作用 |
| --- | --- | --- |
| `CRAFTMATE_HOST` | `127.0.0.1` | Orchestrator 监听地址 |
| `CRAFTMATE_PORT` | `4321` | Orchestrator 端口 |
| `CRAFTMATE_TOKEN` / `_FILE` | `~/.craftmate/ingress-token` | ingress/voice token |
| `CRAFTMATE_DB` / `CRAFTMATE_DB_DIR` | `~/.craftmate/craftmate.db` | SQLite 路径 |
| `CRAFTMATE_MODEL_*` | 见 `.env.example` | OpenAI 兼容模型与预算 |
| `CRAFTMATE_CONTROL_ORIGINS` | 空 | 额外允许的控制面浏览器 Origin，逗号分隔 |
| `TTS_PRIMARY_*` | 见 `.env.example` | Seeduplex 实时语音 |
| `DOUYIN_ROOM_ID` | 空 | 抖音 `web_rid` |
| `DYHUB_URL` | `ws://127.0.0.1:8757` | dyhub sidecar |

凭据保存到 `~/.craftmate/integrations.json`，权限 `0600`；API Key 不回传明文、不入库。

`CRAFTMATE_CONTROL_ORIGINS` 只用于本地第二预览端口或同机 Web 调试，例如
`http://localhost:5174`。默认允许列表不变，未配置时不会放宽；不要把它设为远程
域名来暴露控制面，远程控制仍需 `CRAFTMATE_ALLOW_REMOTE_CONTROL=1` 和显式网络防护。

## 5. 操作员控制

管理端提供四类指令：

| 指令 | 效果 |
| --- | --- |
| Takeover | 人获得游戏控制权，取消 Agent 当前任务 |
| Release | 显式交还，Agent 观察 2 秒后恢复 |
| Stop | 急停：释放输入、停止任务、静音 |
| Whisper | 只给 Agent 的指令，不进入直播间 |

急停后必须显式 Release；Bridge 控制权跨重连保持。

### 5.1 Agent 可观测工作台

桌面和 Web UI 右侧工作台只读控制面事实：

- 「当前判断」显示后端生成的摘要、当前意图、通用判断依据和下一步；没有判断时
  显示空态，不从弹幕或模型原文推断；
- 「目标与里程碑」显示目标运行时阶段、已验证里程碑、结构化 `nextTask`、连续失败和 `retryAt`；
  未建立目标、未验证里程碑不会显示成 100%；
- 「处理链路」按最近一条 `traceId` 展示接入、闸门、仲裁、规划、入队、执行、终态；
  没到达的阶段是“尚未到达”，被丢弃的后续阶段是“已跳过”；
- 「任务队列」「实时事件」展示真实任务、进度、失败和语音终态，并可跳转 replay；
- 「评论与决策」显示 Ingress 真实计数器、drop reason、重连和最近事件时间。

空态语义：

| 显示 | 含义 |
| --- | --- |
| 未配置抖音房间 | 设置里没有 room id；不是“0 条评论” |
| Ingress 状态未知 | Orchestrator 未收到 metrics，不能把缺失当零 |
| 身体未接入 | `/bridge` 没有当前身体，不能显示世界中 |
| 尚无判断 / 等待事件 | 没有后端事实，不是成功或健康证明 |
| 未验证 | 目标引擎还没有证据证明该里程碑完成 |

Ingress 指标来自子进程的真实 counters。`received` 是收到的原始事件数，
`forwarded` 是成功发到 Orchestrator 的数量（重连后补发的缓冲帧也算），`queued`
是 Gate 队列加尚未补发的有界缓冲，`dropped` 与 `dropReasons` 是去重/限流/队列满
、队列淘汰和 relay buffer full 的丢弃。每次重连补发后以及来源健康状态变化时
都会再发一帧 metrics，避免 UI 停留在补发前的旧 `forwarded` 或连接状态。
Orchestrator 用事实 id、时间和结果去重，避免 UI 重复。

### 5.2 配置闭环

「设置 → 接入」一次提交 show settings 与 integrations 两半：

1. 两半先校验，任一失败都不写入；
2. show settings 写入 SQLite 并立即作用于运行中的 Show；
3. integrations 原子写入 `~/.craftmate/integrations.json`，返回脱敏视图；
4. 运行中模型 provider、超时、语音和 Ingress supervisor 按新配置重载；更换
   抖音房间时，Ingress 的 gate/relay 计数、缓冲和去重窗口会一起清零，工作台
   先短暂显示 Ingress 未知，随后从新房间的 0 重新累计；
5. 控制面广播 `settings` / `integrations`，并记录 `settings_applied` 事件。

保存失败会回传 `E_SETTINGS` 并在面板显示服务端错误；重启后读取同一配置。
API Key 只出现在请求中，不进入广播、SQLite、日志或 telemetry。

### 5.3 回放边界

工作台按 trace 查询现有 replay。时间轴可能包含来源、决策、承诺和动作，但管理端
不渲染弹幕原文、提议原文、承诺语音原文或模型理由；这些证据仍可按保留策略留在
SQLite，用于本机审计。若需要外部录制，使用身体侧 `4324` 并显式连接；控制台不会
自动订阅视频。

### 5.4 自主目标模式

「设置 → 目标模式」开启后，Agent 按身体事实持续推进阶段，不需要每条评论或每次
手工指令。当前实现是确定性 `SurvivalGoalPlanner`，不会调用模型；模型额度不变
并不表示目标运行时停摆。

排查时先看：

```bash
sqlite3 -header -column "$HOME/.craftmate/craftmate.db" \
  "select goal_json, enabled, progress_json from goal_runtime;"

tail -f "$HOME/MC/craftmate-1.20.1/logs/latest.log"
```

- `[CraftMate] goto start ...`、`[CraftMate] goto · ...`：Agent 已下达技能。
- `[CraftMate] idle action=...`：没有技能在跑，Mod 正在空闲观察/走路/捡东西。
- `progress_json.nextTask` 为空且 `retryAt` 在未来：运行时在退避或等终态。
- `consecutiveFailures` 持续增长：看 `decision_log` 的最后结果和地形日志。

完整闭环、阶段和模型账本见[自主生存闭环](autonomy.md)。

## 6. 验证

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

最新结果和真实环境验收边界见[验证清单](verification.md)。

## 7. 数据

- 默认数据库：`~/.craftmate/craftmate.db`。
- WAL 伴生文件：`craftmate.db-wal`、`craftmate.db-shm`。
- 启动自动执行 `db/migrations/`。
- `model_cost` 记录成功模型调用的价格与 token 用量；零价格调用也保留 token 证据。
- 原始评论 24 小时后置空，保留哈希和结构化指标。
- 日志不写弹幕原文、prompt 或模型输出。
- `db/README.md` 已合并到[数据模型](../reference/data-model.md)。

## 8. Bridge 快速路径

1. 构建 Fabric Mod 并安装到专用 Minecraft 实例。
2. 启动 CraftMate 和游戏。
3. 管理端确认身体、能力、技能、控制权和队列。
4. 触发一个动作，观察进度、终态、接管和急停。

协议与线程约束见[Bridge 设计](../reference/bridge.md)。

## 9. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `ERR_UNKNOWN_FILE_EXTENSION` | Node 低于 22.5 | 升级 Node |
| `EADDRINUSE :4321` | 残留进程或端口被其他程序占用 | `./stop.command`；仍占用则查看脚本输出的 PID |
| `migration ... changed after being applied` | 修改了已应用迁移 | 恢复原文件，新增迁移 |
| 桌面窗口打不开 | 缺 Rust / Cargo | 安装 Rust，或用 `./start.command --web` |
| 模型不可用 | 未配置 Key、URL、模型名或超时 | 管理端保存配置，看决策流降级原因 |
| Voice 无声 | 系统输出设备或路由问题 | 先查 Voice 日志；macOS 切换可用扬声器 |
| Ingress `upstream=false` | 未连上 Orchestrator | 检查 4321 和 ingress token |
| Bridge 未连接 | 游戏未启动、Mod 未安装或 token 不匹配 | 检查 Fabric 日志、版本和 bridge token |
| 有目标但角色只随机看/走 | 身体处于 `idle action=...`，没有 Agent 任务 | 检查 `retryAt`、失败退避和 Bridge 终态，不要误判为随机寻路 |
| 模型额度长期不变 | 只有一个确定性候选、未配置模型，或供应商请求失败 | 查 `model_cost`、候选数量和 Stage C / 供应商错误 |
| 供应商返回 502 | 上游模型服务不可用或模型名不支持 | 保留失败记录，切换模型/端点后再触发一次 Stage C；无成功请求不产生费用 |

## 10. 停止

`./stop.command` 只结束工作目录属于本仓库的进程，并检查 4321、4322、4323、5173。
端口被无关程序占用时不会强杀，会打印 PID 和工作目录。
