# Issue #32 实施状态报告

## 概述

本文档记录 [Issue #32](https://github.com/XiaoFeiASK/CraftMate/issues/32) 的实施进度和当前状态。

## ✅ 已完成的工作

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

### 2. 火山引擎 TTS 集成（豆包语音）

**配置状态：** ⚠️ 需要用户操作

- 已创建 `VolcengineTtsProvider` 类（位于 `/services/voice/src/providers.ts`）
- 实现了 V3 SSE API：解析 `event: 352` 音频块（base64 格式）
- API Key 已配置：`c50a63b2-11ae-4491-a722-aebfc1a80bb6`
- 默认配置：
  - Provider: `volcengine`
  - Resource: `volc.tts.default`（已从 `seed-tts-2.0` 更改）
  - Voice: `zh_female_tianmeixiaoyuan`（已从 `zh_female_vv_uranus_bigtts` 更改）

**已知问题：**
原配置使用 `seed-tts-2.0` 资源和 `zh_female_vv_uranus_bigtts` 音色时，返回错误：
```
HTTP 200 but error code 45000030: "requested resource not granted"
```

这表示 API Key 有效，但该账号未开通高级语音资源。已将配置改为更通用的 `volc.tts.default` 和 `zh_female_tianmeixiaoyuan`。

**用户需要做的事：**
1. 登录火山引擎控制台
2. 检查已开通的资源 ID 和音色 ID
3. 根据实际情况修改 `.env` 中的 `TTS_PRIMARY_RESOURCE_ID` 和 `TTS_PRIMARY_VOICE_ID`
4. 详细步骤见：[火山引擎 TTS 配置指南](./volcengine-tts-setup.md)

### 3. 环境配置和文档

**配置文件：** ✅ 完成

- `.env` 文件已创建，权限设置为 600
- `.env` 已在 `.gitignore` 中，不会推送到仓库
- `.env.example` 提供了完整的配置模板
- 更新了 `/docs/local-setup.md`，包含 Provider 配置说明

### 4. 测试覆盖

**测试状态：** ✅ 全部通过

```
✅ 160 个测试全部通过
✅ TypeScript 编译无错误
✅ 包含 Volcengine TTS SSE 事件解析测试
```

## 🚧 下一步工作

### 1. 修复 TTS 授权（用户操作）

**优先级：** 高

按照 [火山引擎 TTS 配置指南](./volcengine-tts-setup.md) 完成以下步骤：

1. 在火山引擎控制台查看已开通的资源和音色
2. 更新 `.env` 文件中的配置
3. 测试 TTS 服务：
   ```bash
   node --env-file=.env services/voice/src/main.ts
   ```
4. 验证完整系统：
   ```bash
   npm run dev
   ```

### 2. 游戏连接（Bridge/MCPFabric）

**优先级：** 中

**当前状态：**
- HMCL 启动器版本：3.16.4
- Minecraft 版本：1.21.11
- 游戏类型：**原版（Vanilla）** - 未安装 Fabric Loader

**需要的操作：**
1. 在 HMCL 中为 Minecraft 1.21.11 安装 **Fabric Loader**
2. 下载并安装 **MCPFabric Mod**
3. Bridge 实现已完成（位于 `/packages/bridge/body/`），等待游戏连接

**说明：**
- Bridge 模块负责控制游戏内操作（移动、建造、对话等）
- 需要 Fabric Loader + MCPFabric Mod 才能建立连接
- 安装后，Bridge 可以通过 MCP 协议与游戏通信

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

3. 测试 AI 对话和语音输出

4. （可选）连接真实抖音直播间：
   ```bash
   # 在 .env 中设置 DOUYIN_ROOM_ID
   # 然后启动 dyhub 和 ingress
   npm run start:ingress
   ```

## 配置摘要

### 当前 `.env` 配置

```bash
# DeepSeek 模型（通过 YYAPI）
CRAFTMATE_MODEL_PROVIDER=deepseek
CRAFTMATE_MODEL_URL=https://www.yyapi.cloud/v1
CRAFTMATE_MODEL=deepseek-v4.1-flash
CRAFTMATE_MODEL_TIMEOUT_MS=10000
CRAFTMATE_MODEL_KEY=sk-PSG3K9bKv9mIYJK4y9GmGDOn7LqA2MngfsvhvwmaNFbVoHb0

# 火山引擎 TTS（豆包语音）
TTS_PRIMARY_ID=primary
TTS_PRIMARY_PROVIDER=volcengine
TTS_PRIMARY_RESOURCE_ID=volc.tts.default  # 请根据你的账号修改
TTS_PRIMARY_VOICE_ID=zh_female_tianmeixiaoyuan  # 请根据你的账号修改
TTS_PRIMARY_KEY=c50a63b2-11ae-4491-a722-aebfc1a80bb6

# 抖音直播间（可选）
DOUYIN_ROOM_ID=
DYHUB_URL=ws://127.0.0.1:8757
```

### 关键文件位置

- **模型集成：** `/packages/agent/application/planner.ts`
- **TTS 提供商：** `/services/voice/src/providers.ts`
- **语音服务：** `/services/voice/src/main.ts`
- **Bridge 实现：** `/packages/bridge/body/`
- **环境配置：** `/.env`（不会提交到 Git）
- **配置模板：** `/.env.example`
- **部署文档：** `/docs/local-setup.md`
- **TTS 配置指南：** `/docs/volcengine-tts-setup.md`

## 约束条件

- Git 操作使用 SSH（已配置）
- 分支命名：`fix/<descriptive-name>`（不使用 `codex/` 前缀）
- 禁止在未经明确授权的情况下 force push
- API Keys 必须保存在 `.env` 中，永远不要提交到仓库

## 参考资源

- [Issue #32](https://github.com/XiaoFeiASK/CraftMate/issues/32)
- [本地部署指南](./local-setup.md)
- [火山引擎 TTS 配置指南](./volcengine-tts-setup.md)
- [DeepSeek API 文档](https://platform.deepseek.com/api-docs/)
- [火山引擎 TTS API 文档](https://www.volcengine.com/docs/6561/79820)
