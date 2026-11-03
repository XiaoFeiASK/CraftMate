# 方向 C 运行报告

> 记录日期：2026-11-03
> 分支：`fix/bridge-control-reconnect`（任务 C 首个切片）
> 基线：`8a8f243`
> 结论：**控制权跨重连、急停/接管不自动获权与本地 500ms 停止已通过自动化；
> Minecraft 真机、MCPFabric、60 分钟和 4 小时仍未完成，不得把本节结果当作直播验收。**

## 1. 环境

| 项 | 值 |
| --- | --- |
| 宿主 | macOS（Apple Silicon） |
| Node.js | v26.9.0 |
| npm | 11.19.1 |
| Java | Temurin 21.0.13 LTS |
| Minecraft | 未安装 / 未启动 |
| MCPFabric | 未安装 / 未连接 |
| 分支基线 | `8a8f243` |

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
- 500ms 本地看门狗释放按键，且看门狗停机同样跨重连保持；
- WebSocket 真实往返与断线释放。

没有用 mock 冒充的项：真机移动/挖掘、窗口失焦、tick 线程零 I/O、真实 Minecraft 崩溃恢复。

## 3. 短时运行

### 3.1 Smoke

```bash
BRIDGE_PORT=4391 node --experimental-strip-types tools/bridge/sim-body.mjs
BRIDGE_PORT=4391 node --experimental-strip-types tools/bridge/smoke.mjs
```

结果：连接成功，`mine_block` 完成，`pressed` 清空，`completed` 包含幂等键。

健康接口初始样例：

```json
{
  "ok": true,
  "bridge": {
    "connected": false,
    "owner": "none",
    "queued": 0,
    "running": 0,
    "watchdogMs": 500
  }
}
```

### 3.2 长时采样（虚拟时钟，仅工具自检）

```bash
BRIDGE_LONG_RUN_MS=60000 BRIDGE_SAMPLE_MS=5000 \
  node --expose-gc --experimental-strip-types tools/bridge/long-run.mjs
```

60 秒虚拟时钟（实际执行 22ms）、600 个动作、13 个采样点：

| 指标 | 结果 |
| --- | --- |
| 队列增长 | `0` |
| 动作尝试 | `600`，无丢单或重复终态 |
| 末次 tick | `2640` |
| 首个采样堆内存 | 约 9.4 MB |
| 末个采样堆内存 | 约 12.1 MB |
| 堆增长 | `3,124,768` bytes |

队列没有持续增长；堆增长包含 600 条内存动作记录，尚未证明存在泄漏。**这只证明采样工具与有界队列工作，不证明真实直播稳定。**

## 4. 真机阻塞

2026-11-03 复查：`~/Library/Application Support/minecraft` 只有缓存目录，没有
启动器、版本、Fabric Loader 或 MCPFabric；Java 21.0.13 可用。因此以下验收全部未完成：

- 真实移动与挖掘目标方块；
- 进度/结果关联 `traceId`；
- 窗口失焦仍运行；
- tick 线程不做 I/O；
- 崩溃恢复与 60 分钟无人重启；
- 4 小时资源曲线、镜头与切片。

按照 issue #11，必须补齐真实 Mod 或明确阻塞，不能仅凭 `SimBody` 通过验收。下一步需要在装有 Minecraft 1.21.11 + Fabric 的机器上执行。

## 5. 已交付与未交付

**已交付**

- `packages/contracts/src/bridge.ts` 完整 v1 帧与能力/错误码；
- `packages/bridge/**` 协调器、队列、模拟身体、WS 适配、token、动作端口；
- `packages/bridge-mcpfabric/**` 适配清单与安全握手校验；
- `tools/bridge/**` fake body、smoke、长时采样；
- Bridge 自动化测试进入 `npm test`。

验证结果：合并前 `npm test` 61 项通过，`npm run typecheck` 通过，`npm run build` 通过，
`npm run db:check` 报告 25 个对象 / 17 个索引。

**未交付**

- 真实 Fabric Mod / mcpfabric 进程接入；
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
