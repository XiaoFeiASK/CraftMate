# 外部集成

> 本文覆盖模型、语音、抖音和 Minecraft 身体的接入与联调。通用启动见[运行手册](../operations/runbook.md)，协议细节见[技术设计](../reference/technical-design.md)。

## 1. 模型：OpenAI 兼容接口

CraftMate 通过 `OpenAICompatibleProvider` 调用模型；当前使用 YYAPI 的 DeepSeek
`deepseek-v4.1-flash`，但不绑定该网关。

### 配置

推荐在管理端「设置 → 接入」保存；也可写入本机 `.env` 作为首次默认值：

```bash
CRAFTMATE_MODEL_PROVIDER=deepseek
CRAFTMATE_MODEL_URL=https://www.yyapi.cloud/v1
CRAFTMATE_MODEL=deepseek-v4.1-flash
CRAFTMATE_MODEL_KEY=<your-api-key>
CRAFTMATE_MODEL_TIMEOUT_MS=20000
```

### 验证

1. 启动系统。
2. 管理端显示 Provider 和模型名，不显示 Key。
3. 发送一条能触发 Stage C 的评论。
4. 决策流应显示模型、耗时和 `speech`；超时或坏 JSON 会显示降级和 incident。

模型输出只能产生 `speech` 和声明过的技能；观众文本不进入系统提示。

## 2. 豆包 Seeduplex 实时语音

Voice 只使用端到端实时语音 WebSocket；一次性 TTS HTTP 接口已删除。

### 获取配置

1. 登录[火山引擎控制台](https://console.volcengine.com/)。
2. 进入「语音技术 → 豆包语音」。
3. 确认端到端实时语音资源和音色，例如 `zh_female_vv_uranus_bigtts`。

### 配置

```bash
TTS_PRIMARY_PROVIDER=volcengine-realtime
TTS_PRIMARY_URL=wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue
TTS_PRIMARY_VOICE_ID=<你的音色ID>
TTS_PRIMARY_KEY=<your-api-key>
```

保存后运行中的 Voice 立即热切换，无需重启。`TTS_PRIMARY_INSTRUCTIONS` 用于固定
「大肥鱼」的音色和表达方式；模型只负责发声，不做决策和工具调用。

### 验证与排错

| 现象 | 处理 |
| --- | --- |
| Voice 明确不可用 | 检查 Key、音色、端点和区域资源 |
| 无 `spoken` 但无供应商错误 | 看 Voice 日志中的 PCM、会话结束和播放器错误 |
| `AudioQueueStart failed (-66681)` | macOS 输出设备不可用；在「系统设置 → 声音」切换扬声器，不要伪造播放成功 |
| OBS 需要独立音频 | 手工安装和路由 BlackHole；当前未自动化 |

## 3. 抖音：dyhub sidecar

Ingress 通过本机 dyhub WebSocket 订阅评论、礼物、点赞、进场和房间状态，再做归一化
与限流。

### 为什么选 dyhub

- 保持本机进程，不把直播间数据上传到第三方云。
- 提供统一 WS 事件流，适合 sidecar 装配。
- 断线、房间关闭和坏消息可以在 Ingress 层测试。

`douyin-mcp-skills` 不是目标方案：它把网页控制动作混入数据接入，且不利于低延迟稳
定事件流。

### 配置

推荐在管理端「设置 → 接入」填写：

| 字段 | 说明 |
| --- | --- |
| 房间号 | `live.douyin.com` URL 中的 `web_rid` 数字 |
| dyhub 地址 | 默认 `ws://127.0.0.1:8757` |

保存后 Orchestrator 自动启动或重启 Ingress；清空房间号即停止。独立排查时才运行：

```bash
DOUYIN_ROOM_ID=<web_rid> npm run start:ingress
```

Ingress 健康检查：`http://127.0.0.1:4322/health`。

### 排查顺序

1. `curl http://127.0.0.1:4322/health`。
2. `upstream=false` 表示 Ingress 没连上 Orchestrator，先检查 token 和 4321。
3. `source.state=degraded` 或上游断开，再查 dyhub 和抖音房间。
4. 管理端底部状态应与 Ingress 健康一致。

## 4. Minecraft：Fabric 身体

当前身体是仓库内 `mods/craftmate-body`，目标版本为 Minecraft 1.20.1 与 Fabric
Loader 0.15.11。

### 安装

1. 准备 Minecraft 1.20.1、Fabric Loader 0.15.11 和 Fabric API 0.92.2+1.20.1 实例；开发验证使用 HMCL。
2. 构建：

   ```bash
   cd mods/craftmate-body
   ./gradlew build
   ```

3. 按该实例的 mods 目录安装构建产物。
4. 直播世界关闭失焦暂停，并使用专用存档。
5. 启动 CraftMate 和游戏实例。

管理端「设置 → 目标模式」默认关闭。关闭时空闲不移动、不下发计划任务，只响应
观众评论或操作员操作。开启后由 GoalRuntime 一次下达一个任务，等待身体终态后
再重新观察；接管、急停和暂停会取消当前命令。评论进入「观众提议」收件箱，
经过安全、目标与执行三层闸门，票数不会覆盖安全拒绝。

### 验证

1. 管理端 Bridge 状态显示身体、能力和技能。
2. 触发一个可观察动作，例如 `mine_block`。
3. 观察 `ack`、`progress`、终态和游戏内结果。
4. 测试窗口失焦、断线、接管和急停后输入释放。

`bridge-mcpfabric` 中的候选映射尚未接入运行时，不能视为可用身体能力。

## 5. 凭据与安全

- API Key 推荐通过管理端保存到 `~/.craftmate/integrations.json`，权限 `0600`。
- 控制面只回传脱敏配置，不回传明文 Key。
- `.env` 不提交仓库。
- 所有外部服务默认绑定或访问 loopback；远程调试使用 SSH 隧道。
- 抖音和游戏事件都是不可信输入，只能进入 schema 化数据字段。
