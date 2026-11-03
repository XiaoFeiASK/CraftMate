# 本地开发

> 目标：从空目录到发出模拟弹幕并看到决策，不需要问人。
> 已经能跑什么见 [实现状态](status.md)，架构与端口约定见 [技术设计](technical-design.md) §2。

## 1. 必需

| 依赖 | 版本 | 是否必需 | 用途 |
| --- | --- | --- | --- |
| Node.js | ≥ 22.5 | 必需 | 运行时与 `node:sqlite` |
| npm | 随 Node | 必需 | workspace 安装 |
| Rust / Cargo | 稳定版 | 仅桌面窗口 | Tauri 2 构建 |
| Minecraft + Fabric | 1.21.11 | 仅游戏执行 | 当前阶段不需要 |
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
并检查 `4321`、`4322`、`4323`、`5173`、`4391` 是否释放。使用 `--dry-run` 可以
先查看将要停止的进程；占用端口的其他程序不会被结束，脚本会打印其 PID 和
工作目录供确认。

只在浏览器里预览界面（不打开桌面窗口）：

```bash
./start.command --web
```

`--web --no-open` 不会自动打开浏览器。浏览器版和桌面版连的是同一个 Orchestrator。

终端 B：

```bash
npx tsx tools/mock.ts
```

模拟弹幕会按脚本发送评论，管理端的评论与决策区应随之更新。

只想跑其中一半：

```bash
npm run dev:orchestrator
npm run dev:voice
npm run dev:console
```

Orchestrator、Ingress 与 Voice 共用一个本机 token，默认保存在 `~/.craftmate/ingress-token`
（权限 `0600`）。设 `CRAFTMATE_TOKEN` 可覆盖；设 `CRAFTMATE_TOKEN_FILE` 可改路径。
不要把 token 写进 URL 或提交到仓库。

没有配置真实 TTS 时，Voice 以「仅字幕」模式运行：合成器返回空音频，
控制台仍能看到 `speaking / spoken / failed` 事件。接真实供应商：

```bash
TTS_PRIMARY_URL=http://127.0.0.1:9000/tts \
TTS_PRIMARY_KEY=... \
TTS_BACKUP_URL=http://127.0.0.1:9001/tts \
npm run dev:voice
```

播放默认调用 macOS `afplay`；可用 `AUDIO_PLAYER` 换命令。音频路由
（BlackHole → OBS）尚未自动配置，需要在本机音频设置里手动完成。

Voice 的配置变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VOICE_PORT` | `4323` | Voice WebSocket 与健康检查端口 |
| `VOICE_HOST` | `127.0.0.1` | 监听地址 |
| `TTS_PRIMARY_URL` | 空 | 主 TTS HTTP 端点；未配置时进入仅字幕模式 |
| `TTS_PRIMARY_KEY` | 空 | 主 TTS 的 Bearer token |
| `TTS_BACKUP_URL` | 空 | 备用 TTS HTTP 端点 |
| `TTS_BACKUP_KEY` | 空 | 备用 TTS 的 Bearer token |
| `AUDIO_PLAYER` | `afplay` | 播放命令 |
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

`npm run start:ingress` 与上面的 `npx tsx` 等价，可任选一种。

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
- `.env` 不入库；密钥最终放 macOS Keychain，不写配置文件。
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

没有真实直播间时，先用本仓库的假源验证整条链路：

```bash
npm run fake:dyhub                      # 终端 1：假 dyhub，127.0.0.1:8757
npm run dev:orchestrator                # 终端 2：4321
DOUYIN_ROOM_ID=test npm run start:ingress   # 终端 3：订阅并转发
```

接真实房间时，先把 dyhub 跑起来（默认 `127.0.0.1:8757`），然后：

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
再看控制台左下角的「抖音评论在线」。`upstream: false` 说明 ingress 没连上 Orchestrator，
不是抖音的问题。

## 8. Bridge 模拟身体

Bridge 尚未装配进 Orchestrator，当前只能独立验证协议与协调器。`npm run dev:bridge`
默认监听 `4323`，与 Voice 冲突，所以同时运行时必须显式指定端口：

```bash
BRIDGE_PORT=4391 npm run dev:bridge              # 终端 1：fake body
BRIDGE_PORT=4391 npm run bridge:smoke            # 终端 2：跑一轮 mine_block
BRIDGE_LONG_RUN_MS=60000 npm run bridge:long-run # 可选：虚拟时钟采样
```

`bridge:smoke` 只连接 fake body，不连接 Minecraft。真实 Mod、mcpfabric 与长时验收
仍未完成，详见 [Bridge 运行报告](bridge-run-report.md)。
