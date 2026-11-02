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
- 桌面窗口：Tauri 原生应用，自动弹出 CraftMate 窗口

在 Finder 里双击也会打开终端并运行它。也可以跳过脚本直接运行 `npm run dev`。

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
npm run dev:console
```

接入真实抖音评论（需要先在本机跑起 dyhub）：

```bash
DOUYIN_ROOM_ID=<直播间号> npx tsx services/ingress/src/main.ts
```

`DYHUB_URL` 默认 `ws://127.0.0.1:8757`，`CRAFTMATE_INGRESS` 默认
`ws://127.0.0.1:4321/ingress`。仓库还没有 `dev:ingress` 脚本。

## 3. 验证

```bash
npm run typecheck
npm test
npm run build
npm run db:check
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
| `EADDRINUSE :4321` | 已有实例在跑 | 停掉旧进程，或设 `CRAFTMATE_PORT` |
| 启动即报 `migration ... changed after being applied` | 改过已应用的迁移文件 | 恢复文件内容，新增迁移而不是改旧的 |
| `db:check` 报 not empty | 指向了已有数据库 | 换一个新路径，或传目录让它建临时库 |
| 桌面窗口打不开 | 缺 Rust / Cargo | 安装 Rust，或先用 `./start.command --web` |
