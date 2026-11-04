# Issue #32 实施状态报告

## 概述

本文档记录 [Issue #32](https://github.com/XiaoFeiASK/CraftMate/issues/32) 的实施进度和当前状态。

## 已完成并验证

### 1. DeepSeek 模型集成（通过 YYAPI）

**配置状态：** ✅ 完成并验证

- API 地址：`https://www.yyapi.cloud/v1`
- 模型：`deepseek-v4.1-flash`
- API Key 已配置在 `.env` 文件中
- 模型状态追踪：`unverified` → `ready` → `error` 三态管理
- Planner 控制台 UI 实时显示模型状态（位于 `/packages/agent/application/planner.ts`）

**测试结果：**
```
✅ HTTP 200 响应
✅ 返回有效的结构化 JSON
✅ DeepSeek AI 助手正常回复
```

### 2. 火山引擎端到端实时语音（Seeduplex）

**配置状态：** ✅ 完成并验证

- `VolcengineRealtimeTtsProvider` 位于 `/services/voice/src/providers.ts`
- 使用 WebSocket 端到端实时语音协议
- 每句发送 `session.create` 和 `speech_text_buffer.commit`
- 接收 24kHz `pcm_s16le`，在会话结束前直接送入本机流式播放器
- API Key 保存在权限 `0600` 的本地配置文件（值不写入仓库）
- 默认配置：
  - Provider: `volcengine-realtime`
  - URL: `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`
  - Voice: `zh_female_vv_uranus_bigtts`

**验证结果与边界：**
```
✅ 实时接口返回有效音频
✅ 真实 PCM 首包约 196–215ms
✅ 真机已出现过真实 spoken 事件
✅ 播放失败会报告 E_AUDIO_PLAYBACK，不伪造 spoken
⚠️ 本机 macOS 音频输出也曾返回 AudioQueueStart failed (-66681)
```

旧的 HTTP TTS、SSE TTS、备用语音和伪造字幕降级路径已删除。详细配置见：
[端到端实时语音配置](./volcengine-tts-setup.md)。

### 3. 环境配置和文档

**配置文件：** ✅ 完成

- `.env` 文件已创建，权限设置为 600
- `.env` 已在 `.gitignore` 中，不会推送到仓库
- `.env.example` 提供了完整的配置模板
- 更新了 `/docs/local-setup.md`，包含 Provider 配置说明

### 4. Fabric 1.21.11 真实游戏身体

- `mods/craftmate-body` 是 Fabric Loader 0.20.1 / Minecraft 1.21.11 客户端 Mod
- 游戏线程执行动作，网络线程只排队；心跳超时会释放本地输入
- 真实开发实例已创建世界并通过 `/bridge` 上报快照
- 已覆盖 `goto`、`look_at`、`mine_block`、`say`、`wait`、`attack`、
  `equip`、`eat`、`use_block`、`place_block`
- Planner 只接收当前身体在 `hello.skills` 中声明的动作，模型无法选择未连接身体
  支持的能力

### 5. 测试覆盖

2026-11-04 合并前本机结果：

```
✅ npm test：182 项通过，0 失败
✅ npm run typecheck、npm run build、两种数据库校验通过
✅ Fabric Mod Gradle 构建与 Swift PCM 播放器类型检查通过
✅ 覆盖实时语音流、模型技能纠错、Ingress supervisor、世界快照和动作白名单
```

## 🚧 下一步工作

### 1. 接入真实抖音直播间

**优先级：** 高

先把 dyhub 跑起来，再在管理端「设置 → 接入」填写房间号和 dyhub 地址并保存。
Orchestrator 会自动启停 Ingress；真实直播间和 dyhub 仍需现场校准。

### 2. 真实方块删除与独立存档验收

**优先级：** 中

**当前状态：**
- HMCL 启动器版本：3.16.4
- 仓库可构建 Minecraft 1.21.11 / Fabric Loader 0.20.1 的
  `craftmate-body-0.1.0.jar`
- HMCL 配置的开发实例已进入真实世界、连接 Bridge、上报世界快照并接受 `mine_block`
- 最近一次因目标被地形遮挡以 `E_PRECONDITION` 结束；方块最终删除与独立存档仍待验收

**需要的操作：**
1. 在 HMCL 中为 Minecraft 1.21.11 安装 **Fabric Loader 0.20.1**
2. 把 `mods/craftmate-body/build/libs/craftmate-body-0.1.0.jar` 放进实例
3. 启动 Orchestrator 与 Voice，然后进入真实单人世界
4. 在管理端确认身体已连接后测试动作、接管与方块最终删除

**说明：**
- Bridge 模块负责控制游戏内操作（移动、建造、对话等）
- CraftMate Body 直接通过 `/bridge` WebSocket 与游戏通信

### 3. 完整系统测试

**优先级：** 高

在完成上述步骤后，进行端到端测试：

1. 启动完整系统：
   ```bash
   npm run dev
   ```

2. 验证各服务状态：
   - Orchestrator（主服务）监听 WebSocket
   - Voice 服务显示 "ready" 状态
   - Model 状态显示 "ready"

3. 测试 AI 对话、真实游戏动作、方块终态和语音输出

4. （可选）连接真实抖音直播间：
   ```bash
   # 在 .env 中设置 DOUYIN_ROOM_ID
   # 先启动 dyhub；Ingress 由 Orchestrator 按管理端配置自动启动
   npm run start:ingress
   ```

## 配置摘要

### 当前 `.env` 配置

```bash
# DeepSeek 模型（通过 YYAPI）
CRAFTMATE_MODEL_PROVIDER=deepseek
CRAFTMATE_MODEL_URL=https://www.yyapi.cloud/v1
CRAFTMATE_MODEL=deepseek-v4.1-flash
CRAFTMATE_MODEL_TIMEOUT_MS=30000
CRAFTMATE_MODEL_KEY=<your-api-key>

# 火山引擎 TTS（豆包语音）
TTS_PRIMARY_ID=primary
TTS_PRIMARY_PROVIDER=volcengine-realtime
TTS_PRIMARY_URL=wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue
TTS_PRIMARY_VOICE_ID=zh_female_vv_uranus_bigtts
TTS_PRIMARY_KEY=<your-api-key>

# 抖音直播间（可选）
DOUYIN_ROOM_ID=
DYHUB_URL=ws://127.0.0.1:8757
```

### 关键文件位置

- **模型集成：** `/packages/agent/application/planner.ts`
- **TTS 提供商：** `/services/voice/src/providers.ts`
- **语音服务：** `/services/voice/src/main.ts`
- **Bridge 实现：** `/packages/bridge/`
- **Fabric 游戏身体：** `/mods/craftmate-body/`
- **环境配置：** `/.env`（不会提交到 Git）
- **配置模板：** `/.env.example`
- **部署文档：** `/docs/local-setup.md`
- **TTS 配置指南：** `/docs/volcengine-tts-setup.md`

## 约束条件

- Git 操作使用 SSH（已配置）
- 分支命名：`fix/<descriptive-name>`（不使用 `codex/` 前缀）
- 禁止在未经明确授权的情况下 force push
- API Keys 保存在本机权限 `0600` 的 `.env` 或
  `~/.craftmate/integrations.json` 中，永远不要提交到仓库

## 参考资源

- [Issue #32](https://github.com/XiaoFeiASK/CraftMate/issues/32)
- [本地部署指南](./local-setup.md)
- [火山引擎 TTS 配置指南](./volcengine-tts-setup.md)
- [DeepSeek API 文档](https://platform.deepseek.com/api-docs/)
- [火山引擎 TTS API 文档](https://www.volcengine.com/docs/6561/79820)
