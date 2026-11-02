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
npm run dev
```

这条命令同时启动：

- Orchestrator：`ws://127.0.0.1:4321/control`，健康检查 `http://127.0.0.1:4321/health`
- 管理端 Vite：`http://localhost:5173`

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

## 4. 桌面窗口（可选）

需要 Rust / Cargo：

```bash
npm run dev:desktop
```

它用 Tauri 2 承载 `apps/admin-console` 的构建产物。不要在这里再建一个前端；
`desktop-shell` 只是宿主。

## 5. Docker（可选）

适用于不想污染本机环境、或在 Linux 上验证的场合。桌面窗口、Minecraft、OBS 和
音频路由不能进容器。

```bash
docker compose up orchestrator      # 控制面，映射到本机 4321
docker compose run --rm db-check    # 在容器内真实文件库上校验 schema
```

两个服务都在 `docker-compose.yml` 里，镜像定义在 `docker/Dockerfile`。

端口冲突时换宿主端口：

```bash
CRAFTMATE_PORT=4400 docker compose up orchestrator
```

国内网络拉不到 Docker Hub 时换镜像源，不要把镜像源写进仓库：

```bash
NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine docker compose build
```

### 为什么没有数据库容器

SQLite 是嵌入式库，不是独立服务：数据就在进程打开的那个文件里。用容器跑一个
空的 SQLite 容器没有意义，真正需要验证的是**文件库上的 WAL 和锁行为**。

`db-check` 服务把 `/data` 挂到命名卷，校验器在里面建临时库、执行全部迁移、
断言 `journal_mode = wal` 和 `foreign_keys = 1`，然后删除临时文件。

将来出现需要独立进程的依赖（例如本地 embedding 服务、对象存储、消息队列），
再加到这个 compose 文件里，而不是让每个人在宿主机上手动装。

## 6. 数据与密钥

- 数据库文件、`-wal`、`-shm` 都在 `.gitignore` 里，不要提交。
- `.env` 不入库；密钥最终放 macOS Keychain，不写配置文件。
- 日志里不写弹幕原文、prompt 或模型输出。

## 7. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `ERR_UNKNOWN_FILE_EXTENSION` | Node 版本低于 22.5 | 升级 Node |
| `EADDRINUSE :4321` | 已有实例在跑 | 停掉旧进程，或设 `CRAFTMATE_PORT` |
| 容器起来了但本机连不上 | 只监听 `127.0.0.1` | 设 `CRAFTMATE_HOST=0.0.0.0`（compose 已设） |
| `db:check` 报 not empty | 指向了已有数据库 | 换一个新路径，或传目录让它建临时库 |
| 桌面窗口打不开 | 缺 Rust / Cargo | 先只用 `npm run dev` |
