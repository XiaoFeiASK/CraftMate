# 方向 C 运行报告

> 记录日期：2026-11-04
> 分支：`fix/issue-32-ai-agent-implementation`
> 结论：**控制权跨重连、急停/接管不自动获权与协商式本地看门狗已通过自动化；
> HMCL 配置的 Fabric 1.21.11 实例已连接、上报真实世界快照并接受 `mine_block`；
> 方块最终删除、窗口失焦、60 分钟和 4 小时仍未验收，不得把本节结果当作直播验收。**

## 1. 环境

| 项 | 值 |
| --- | --- |
| 宿主 | macOS（Apple Silicon） |
| Node.js | v26.9.0 |
| npm | 11.19.1 |
| Java | Temurin 21.0.13 LTS |
| Minecraft | 1.21.11 |
| Fabric Loader | 0.20.1 |
| CraftMate Body | `mods/craftmate-body`，HMCL 配置的开发实例已连接 |

## 2. 自动化

执行命令与结果：

```bash
npm test            # 当时 54 passed / 0 failed
npm run typecheck   # passed
npm run build       # passed
npm run db:check    # 25 objects / 17 indexes
```

> 合并后的 `main` 已扩到 113 项测试、26 个对象 / 19 个索引；本页保留当时的
> Bridge 专项结果，当前总数以 [实现状态](status.md) 为准。

Bridge 专项覆盖：

- 版本化 schema 往返与非法帧拒绝；
- 独立 token、能力与技能协商；
- `cmd → ack → progress → result`；
- 幂等键不重复副作用；
- 有界队列与优先级淘汰；
- 终态不可逆；
- ACK 前取消/超时后迟到 ACK 的补偿取消；
- 接管/急停取消运行与排队项，支持中恢复 `agent`；
- 接管/急停后重连不自动获权，`welcome` 携带 sticky owner/generation；
- 旧 generation 的迟到模型结果被拒绝；
- ACK 前取消按 command id 阻止身体执行；
- 协商式本地看门狗释放按键，且看门狗停机同样跨重连保持；
- WebSocket 真实往返与断线释放。

没有用 mock 冒充的项：真机移动/挖掘、窗口失焦、tick 线程零 I/O、真实 Minecraft 崩溃恢复。

## 3. 短时运行

### 3.1 Smoke

```bash
npm test -- --test-name-pattern="bridge"
```

结果：Bridge 握手、命令生命周期、重连控制权、急停与看门狗自动化测试通过。
正式启动不注入测试身体，真实连接状态必须以 `/bridge` 为准。

### 3.2 队列边界（自动化）

```bash
npm test -- --test-name-pattern="bridge queue"
```

结果是队列边界与优先级淘汰测试通过。虚拟时钟不证明真实直播稳定，60 分钟
与 4 小时真机曲线仍需在现场采样。

## 4. 真机进度与边界

2026-11-04 已使用 HMCL 配置的真实 Fabric 开发客户端进入单人世界，通过 Bridge
上报位置、朝向、生命、饥饿、快捷栏、近邻实体与方块快照。真实 DeepSeek 请求返回了
结构化的 `mine_block`，Mod 在暂停菜单和世界已加载的边界下接受了命令，并产生
`finding` 进度与 Action 终态。最后一次因目标被地形遮挡以 `E_PRECONDITION` 结束，
因此不能把“接受命令”等同于“方块已挖掉”。以下仍需完成：

- 至少一次方块最终删除并确认对应 Action 为 `completed`；
- 进度/结果关联 `traceId`；
- 窗口失焦仍运行；
- tick 线程不做 I/O；
- 崩溃恢复与 60 分钟无人重启；
- 4 小时资源曲线、镜头与切片。

正式启动不注入 `SimBody`；它只用于自动化测试。不能凭 `SimBody` 或世界快照代替真实动作验收。
HMCL 已在开发实例中使用 Fabric Loader 0.20.1；面向独立存档、正式账号与其他版本的
安装流程仍待单独验收。

## 5. 已交付与未交付

**已交付**

- `packages/contracts/src/bridge.ts` 完整 v1 帧与能力/错误码；
- `packages/bridge/**` 协调器、队列、WS 适配、token、动作端口；
- `packages/bridge-mcpfabric/**` 适配清单与安全握手校验；
- Bridge 自动化测试进入 `npm test`。

验证结果：合并前 `npm test` 182 项通过，`npm run typecheck`、`npm run build`、
内存库和 WAL 文件库校验均通过；Fabric Mod Gradle 构建通过，Swift PCM 播放器
类型检查通过。

**未交付**

- 独立存档、正式账号与方块最终删除的真实动作验收；
- 60 分钟与 4 小时真实彩排；
- 镜头策略与切片标记；
- 控制台 `/bridge` 可视化（B 的 UI 边界）。

## 6. 给 B 的接入说明

在 B 的 public HTTP upgrade 路由中增加一次委派，不要新建监听端口：

```ts
import { createBridgeUpgrade, loadOrCreateBridgeToken, SqliteActionPort } from "@craftmate/bridge";

const bridge = createBridgeUpgrade({
  token: loadOrCreateBridgeToken(),
  sessionId: persistent.context.sessionId,
  actions: new SqliteActionPort(db, {
    sessionId: persistent.context.sessionId,
    decisionId, // 该动作对应的 decision_log.id
    priority: "command",
  }),
});

http.on("upgrade", (request, socket, head) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/bridge") {
    bridge.handleUpgrade(request, socket, head);
    return;
  }
  // 原有 /control 与 /ingress 路由保持不动。
});
```

`/health` 可读取 `bridge.health()`，字段包括连接、所有权、排队数、运行数、tick 与看门狗窗口。

如果 B 的 upgrade 路由需要先判断 `/control`/`/ingress`，请原样保留其逻辑，只把 `/bridge` 交给模块；不要让两个模块重复接管同一端口。
