# 本地开发环境

> 目标：从空目录到能发一条模拟弹幕并看到决策，不需要问人。
> 已经能跑什么见 [status.md](status.md)。

## 1. 必需

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | ≥ 22.5 | 运行时与 `node:sqlite` |
| npm | 随 Node | workspace 安装 |

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

- 数据库文件、`-wal`、`-shm` 都在 `.gitignore` 里，不要提交。
- `.env` 不入库；密钥最终放 macOS Keychain，不写配置文件。
- 日志里不写弹幕原文、prompt 或模型输出。

## 6. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `ERR_UNKNOWN_FILE_EXTENSION` | Node 版本低于 22.5 | 升级 Node |
| `EADDRINUSE :4321` | 已有实例在跑 | 停掉旧进程，或设 `CRAFTMATE_PORT` |
| `db:check` 报 not empty | 指向了已有数据库 | 换一个新路径，或传目录让它建临时库 |
| 桌面窗口打不开 | 缺 Rust / Cargo | 安装 Rust，或先用 `./start.command --web` |
