# 本地开发

> 目标：从空目录启动真实控制面、模型、端到端实时语音与配置界面。
> 已经能跑什么见 [实现状态](status.md)，架构与端口约定见 [技术设计](technical-design.md) §2。

## 1. 必需

| 依赖 | 版本 | 是否必需 | 用途 |
| --- | --- | --- | --- |
| Node.js | ≥ 22.5 | 必需 | 运行时与 `node:sqlite` |
| npm | 随 Node | 必需 | workspace 安装 |
| Rust / Cargo | 稳定版 | 仅桌面窗口 | Tauri 2 构建 |
| Minecraft + Fabric | 1.21.11 / Fabric 0.20.1 | 游戏执行 | 需要真实动作时必需 |
| OBS / BlackHole | — | 仅推流 | 当前阶段不需要 |

```bash
node -v    # 需要 v22.5 或更高
npm install
```

`npm install` 会按 workspace 安装 `apps/*`、`services/*`、`packages/*` 的依赖。

## 2. 本机启动

终端 A：

```bash
./start.command
```

脚本会检查 Node.js 版本、在需要时安装依赖，然后同时启动：

- Orchestrator：`ws://127.0.0.1:4321/control`，健康检查 `http://127.0.0.1:4321/health`
- Voice：`ws://127.0.0.1:4323/voice`，健康检查 `http://127.0.0.1:4323/health`
- 桌面窗口：Tauri 原生应用，自动弹出 CraftMate 窗口

在 Finder 里双击也会打开终端并运行它。也可以跳过脚本直接运行 `npm run dev`。

停止全部本地开发进程：

```bash
./stop.command
```

脚本只结束工作目录属于本仓库的 Orchestrator、Voice、Vite、Tauri 与相关子进程，
并检查 `4321`、`4322`、`4323`、`5173` 是否释放。使用 `--dry-run` 可以
先查看将要停止的进程；占用端口的其他程序不会被结束，脚本会打印其 PID 和
工作目录供确认。

只在浏览器里预览界面（不打开桌面窗口）：

```bash
./start.command --web
```

`--web --no-open` 不会自动打开浏览器。浏览器版和桌面版连的是同一个 Orchestrator。

只想跑其中一半：

```bash
npm run dev:orchestrator
npm run dev:voice
npm run dev:console
```

Orchestrator、Ingress 与 Voice 共用一个本机 token，默认保存在 `~/.craftmate/ingress-token`
（权限 `0600`）。设 `CRAFTMATE_TOKEN` 可覆盖；设 `CRAFTMATE_TOKEN_FILE` 可改路径。
不要把 token 写进 URL 或提交到仓库。

仓库根目录的 `.env` 会由标准启动脚本自动加载，且已加入 `.gitignore`；shell 环境变量优先级更高。
首次启动可从 `.env.example` 提供默认值，随后在管理端「设置 → 接入」中编辑并保存。
凭据保存在 `~/.craftmate/integrations.json`，目录和文件仅当前用户可访问，API Key
不会通过控制面回传明文。
DeepSeek 使用 OpenAI 兼容接口；可在 `CRAFTMATE_MODEL` 设置 YYAPI 已开通的模型名。仓库示例采用 `deepseek-v4.1-flash`；可用 `CRAFTMATE_MODEL_TIMEOUT_MS`
设置模型等待上限，超时后会降级模板。接入面板会显示模型 Provider 与模型名，不会显示 Key。

Voice 使用端到端实时语音；未配置 API Key 时 Voice 保持运行并明确报告不可用。
在管理端保存语音配置后，运行中的 Voice 服务会立即切换：

```bash
TTS_PRIMARY_PROVIDER=volcengine-realtime \
TTS_PRIMARY_KEY=... \
TTS_PRIMARY_VOICE_ID=zh_female_vv_uranus_bigtts \
npm run dev:voice
```

当前语音使用豆包「端到端实时语音（Seeduplex）」：
`wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`。
Voice 为每句已决定好的字幕建立会话，发送 `session.create` 与
`speech_text_buffer.commit`，再把流式返回的 24kHz `pcm_s16le` 在会话结束前
直接送入本机流式播放器。错误时会如实上报，不伪造播放完成。
模型只负责发声，不接收观众评论，也不参与 CraftMate 的决策与工具调用。
`TTS_PRIMARY_INSTRUCTIONS` 用于设定「大肥鱼」的音色与说话方式。

流式播放使用 macOS AVFoundation；非流式测试音频才使用 `AUDIO_PLAYER`（默认 `afplay`）。音频路由
（BlackHole → OBS）尚未自动配置，需要在本机音频设置里手动完成。

Voice 的配置变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VOICE_PORT` | `4323` | Voice WebSocket 与健康检查端口 |
| `VOICE_HOST` | `127.0.0.1` | 监听地址 |
| `TTS_PRIMARY_URL` | Seeduplex 官方端点 | 端到端实时语音 WebSocket 地址 |
| `TTS_PRIMARY_KEY` | 空 | 主 TTS 的 API Key 或 Bearer token |
| `TTS_PRIMARY_PROVIDER` | `volcengine-realtime` | 使用豆包端到端实时语音 |
| `TTS_PRIMARY_VOICE_ID` | `zh_female_vv_uranus_bigtts` | 端到端实时语音的发声人 |
| `TTS_PRIMARY_INSTRUCTIONS` | 大肥鱼提示词 | 固定人格、音色和朗读方式 |
| `TTS_SYNTHESIS_TIMEOUT_MS` | `300000` | 单句实时语音会话的等待上限 |
| `AUDIO_PLAYER` | `afplay` | 非流式测试音频的播放命令 |
| `CRAFTMATE_VOICE` | `ws://127.0.0.1:4323/voice` | Orchestrator 连接的 Voice 地址 |

接入真实抖音评论（需要先在本机跑起 dyhub）：

```bash
DOUYIN_ROOM_ID=<直播间号> npx tsx services/ingress/src/main.ts
```

`DYHUB_URL` 默认 `ws://127.0.0.1:8757`，`CRAFTMATE_INGRESS` 默认
`ws://127.0.0.1:4321/ingress`。Orchestrator 只接受本机来源且 token 正确的
ingress；伪造 token、未 `hello` 或非 loopback 连接会被直接关闭。

Ingress 健康检查 `http://127.0.0.1:4322/health` 会同时返回丢弃原因计数，
例如 `rate limited` / `queue full`。

在管理端「设置 → 接入」保存房间号和 dyhub 地址后，Orchestrator 会自动启动或
重启 Ingress；清空房间号会停止 Ingress。`npm run start:ingress` 仍可用于独立排查，
但正式启动不需要再手动运行，也不要与自动托管的 Ingress 同时占用 `4322`。

## 3. 验证

```bash
npm run typecheck
npm test
npm run build
npm run db:check
npm run db:check:file
```

`npm test` 覆盖 `packages`、`apps`、`services` 三个目录。新增测试文件放在对应包的
`src/` 下，命名 `*.test.ts` 即可被收集。

GitHub Actions 会在 Pull Request、推送到 `main` 和手动触发时运行以上检查。CI 使用
Node.js 22，并执行锁文件安装、类型检查、测试、控制台构建及内存/WAL 数据库校验；
Tauri 多平台打包、Minecraft/Fabric 集成和真实外部服务联调尚未纳入自动化。

## 4. 桌面窗口（默认）

`./start.command` 默认就启动桌面窗口，需要 Rust / Cargo。只启动窗口、不启
Orchestrator 时：

```bash
npm run dev:desktop
```

它用 Tauri 2 承载 `apps/admin-console` 的构建产物。不要在这里再建一个前端；
`desktop-shell` 只是宿主。

## 5. 数据与密钥

- 数据库默认在 `~/.craftmate/craftmate.db`；`CRAFTMATE_DB` 可指定文件，`CRAFTMATE_DB_DIR` 可指定目录。
- 数据库文件、`-wal`、`-shm` 都在 `.gitignore` 里，不要提交。
- 启动时自动跑 `db/migrations/`；迁移 checksum 与已应用记录不一致会直接启动失败。
- `.env` 不入库；管理端保存的服务凭据在 `~/.craftmate/integrations.json`，权限 `0600`。
- 日志里不写弹幕原文、prompt 或模型输出。

SQLite 是嵌入式库，**不需要也不应该**单独跑数据库进程。`npm run db:check:file`
会在 `.tmp-db/` 里建一个真实 WAL 文件库，校验完连同 `-wal` / `-shm` 一起删除。

## 6. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `ERR_UNKNOWN_FILE_EXTENSION` | Node 版本低于 22.5 | 升级 Node |
| `EADDRINUSE :4321` | 已有实例或残留进程在跑 | 运行 `./stop.command`；被其他程序占用时手动停止或设 `CRAFTMATE_PORT` |
| 启动即报 `migration ... changed after being applied` | 改过已应用的迁移文件 | 恢复文件内容，新增迁移而不是改旧的 |
| `db:check` 报 not empty | 指向了已有数据库 | 换一个新路径，或传目录让它建临时库 |
| 桌面窗口打不开 | 缺 Rust / Cargo | 安装 Rust，或先用 `./start.command --web` |

## 7. 接入抖音评论（ingress）

接真实房间时，先把 dyhub 跑起来（默认 `127.0.0.1:8757`），然后在管理端
「设置 → 接入」填写直播间号和 dyhub 地址并保存。Orchestrator 会立即启动
Ingress；修改任一值时自动重启，清空直播间号时停止。需要脱离管理端独立排查时，
才手动运行：

```bash
DOUYIN_ROOM_ID=<live.douyin.com 后面的数字> npm run start:ingress
```

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DOUYIN_ROOM_ID` | 必填 | 直播间 `web_rid`，不是房间内部 id |
| `DYHUB_URL` | `ws://127.0.0.1:8757` | dyhub 地址 |
| `CRAFTMATE_INGRESS` | `ws://127.0.0.1:4321/ingress` | orchestrator 入口 |
| `INGRESS_HEALTH_PORT` | `4322` | ingress 自身探活端口 |

排查顺序：先 `curl http://127.0.0.1:4322/health` 看 `source.state` 与 `upstream`，
再看控制台左下角的「抖音评论在线」。`upstream: false` 说明 Ingress 没连上
Orchestrator，不是抖音的问题。Ingress 异常退出时会保留错误状态，修复 dyhub
地址或房间号后再次保存即可重新启动。

## 8. Bridge 真实身体

`/bridge` 已装配进 Orchestrator。`mods/craftmate-body` 是真实的 Fabric
1.21.11 客户端 Mod，README 中的 Gradle 命令可构建安装。没有身体时控制台明确显示
未连接；正式启动不会自动注入测试身体。HMCL 配置的开发实例已连接并接受动作命令；
方块最终删除、独立存档和长时验收仍需完成，详见
[Bridge 运行报告](bridge-run-report.md)。

## 9. 模型与预算

Stage C 只有一个 OpenAI 兼容 Provider，未配置凭据时按模板回应：

| 变量 | 作用 |
| --- | --- |
| `CRAFTMATE_MODEL_KEY` | 模型 API Key；不设则不调用模型 |
| `CRAFTMATE_MODEL` | 模型名，例如 `deepseek-chat` |
| `CRAFTMATE_MODEL_URL` | 兼容端点，默认 `https://api.deepseek.com/v1` |
| `CRAFTMATE_MODEL_PROVIDER` | 账本里的 provider 名，默认 `deepseek` |
| `CRAFTMATE_MODEL_PRICE_IN` / `_OUT` | 每百万 token 单价，用于预算 |
| `CRAFTMATE_MODEL_HOURLY_LIMIT` | 每小时成本上限，超过后改走模板 |
| `CRAFTMATE_MODEL_KEY_LIMIT` | 单个 Key 的累计上限 |

坏输出、超时和超预算都会写一条 `incident`，控制台在决策流里能看到 `Stage C` 与降级
标记。模型收到的观众文本只作为 JSON 数据字段，不进入系统提示。

## 10. Bridge

`/bridge` 与 `/control`、`/ingress` 共用 4321 端口。Token 在
`~/.craftmate/bridge.token`（`0600`），与 ingress/voice 的 token 不同。

没有身体连接时控制台显示「未连接任何身体」，`Decision.skill` 即使非空也不会下发。
