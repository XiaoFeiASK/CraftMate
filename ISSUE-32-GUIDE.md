# Issue #32 完成指南

## 🎉 已完成的工作

### ✅ DeepSeek AI 模型集成

你的 DeepSeek API（通过 YYAPI）已经配置完成并通过测试：

- **API 地址**：`https://www.yyapi.cloud/v1`
- **模型**：`deepseek-v4.1-flash`
- **状态**：✅ 正常工作

测试结果显示模型可以正常回复对话请求。

### ✅ 代码实现完成

- ✅ 模型状态追踪系统（unverified → ready → error）
- ✅ 控制台 UI 显示模型状态
- ✅ Volcengine TTS Provider 实现（V3 SSE API）
- ✅ 160 个测试全部通过
- ✅ TypeScript 编译无错误

### ✅ 配置文件就绪

- ✅ `.env` 文件已创建（权限 600，不会推送到 Git）
- ✅ API Keys 已安全配置
- ✅ 文档已更新

---

## ⚠️ 你需要完成的步骤

### 步骤 1：修复豆包语音（TTS）配置

**问题：** 当前配置的语音资源可能未在你的火山引擎账号中开通。

**解决方法：**

1. **登录火山引擎控制台**
   - 访问：https://console.volcengine.com/
   - 进入「语音技术」→「豆包语音」

2. **查看你的账号已开通的服务**
   - 记录「资源 ID」（Resource ID）
   - 记录「音色 ID」（Voice ID）

3. **更新 `.env` 文件**
   
   打开项目根目录的 `.env` 文件，修改这两行：
   
   ```bash
   TTS_PRIMARY_RESOURCE_ID=你的资源ID  # 例如：volc.tts.default
   TTS_PRIMARY_VOICE_ID=你的音色ID    # 例如：zh_female_tianmeixiaoyuan
   ```

4. **测试 TTS 服务**
   
   ```bash
   node --env-file=.env services/voice/src/main.ts
   ```
   
   如果看到 "Voice server ready" 且没有错误，说明配置正确。

**详细步骤见：** [火山引擎 TTS 配置指南](./docs/volcengine-tts-setup.md)

**可选：如果暂时不需要语音**

可以注释掉 `.env` 中的所有 `TTS_` 开头的行，系统会以"仅字幕"模式运行（AI 回复会显示文字，但不播放语音）。

---

### 步骤 2：安装 Fabric 和 MCPFabric Mod（可选）

**当前状态：** 你的 Minecraft 1.21.11 是原版（Vanilla），需要安装 Fabric Loader 才能让 CraftMate 控制游戏。

**如果你需要游戏内 AI 控制功能，请执行：**

1. **在 HMCL 启动器中**
   - 选择你的 Minecraft 1.21.11 实例
   - 点击「自动安装」→「Fabric」
   - 安装完成后重启实例

2. **下载并安装 MCPFabric Mod**
   - 将 Mod 文件放入 `.minecraft/mods/` 目录
   - 重启游戏

3. **验证连接**
   - 启动 CraftMate 系统（见下方）
   - 进入游戏
   - 如果连接成功，控制台会显示 Bridge 状态

**如果暂时不需要游戏控制：** 可以跳过此步骤，CraftMate 仍可作为对话 AI 使用。

---

## 🚀 启动系统

### 方法 1：运行启动测试脚本

```bash
cd /Users/xiaofei/Project/CraftMate
./test-startup.sh
```

这会：
- 检查配置是否完整
- 运行所有测试
- 测试 DeepSeek 模型连接

### 方法 2：直接启动完整系统

```bash
cd /Users/xiaofei/Project/CraftMate
npm run dev
```

这会同时启动：
- **Orchestrator**（主服务）
- **Voice**（语音服务）
- **Ingress**（输入服务）

### 方法 3：单独测试 Voice 服务

```bash
cd /Users/xiaofei/Project/CraftMate
node --env-file=.env services/voice/src/main.ts
```

---

## 📋 系统检查清单

启动系统后，检查以下状态：

- [ ] 控制台显示 Model 状态为 "ready"
- [ ] 控制台显示 Voice 状态（如果配置了 TTS）
- [ ] 没有错误信息（error code 45000030 等）
- [ ] WebSocket 服务正常监听

---

## 🔧 故障排除

### 问题：TTS 报错 "requested resource not granted"

**原因：** 火山引擎 API Key 未开通当前配置的语音资源。

**解决：** 按照「步骤 1」修复 TTS 配置。

### 问题：DeepSeek 模型无法连接

**检查：**
1. API Key 是否正确（`.env` 中的 `CRAFTMATE_MODEL_KEY`）
2. YYAPI 额度是否充足
3. 网络连接是否正常

### 问题：Bridge 无法连接游戏

**检查：**
1. Minecraft 是否安装了 Fabric Loader
2. MCPFabric Mod 是否正确安装
3. 游戏版本是否为 1.21.11

---

## 📚 相关文档

- [实施状态报告](./docs/issue-32-implementation-status.md) - 详细的技术实施记录
- [火山引擎 TTS 配置指南](./docs/volcengine-tts-setup.md) - TTS 配置详细步骤
- [本地部署指南](./docs/local-setup.md) - 完整的本地部署文档

---

## 🎯 下一步建议

1. **立即可做：**
   - 修复 TTS 配置（按照步骤 1）
   - 运行 `./test-startup.sh` 验证系统
   - 启动 `npm run dev` 测试对话功能

2. **后续可做：**
   - 安装 Fabric + MCPFabric（如需游戏控制）
   - 配置抖音直播间连接（如需直播互动）
   - 自定义 AI 行为和回复策略

---

## 💡 提示

- **API Keys 安全：** `.env` 文件已在 `.gitignore` 中，不会被 Git 追踪
- **测试环境：** 所有 160 个测试都已通过，代码质量有保障
- **模型已验证：** DeepSeek 通过 YYAPI 的连接已确认可用
- **仅字幕模式：** 即使 TTS 未配置，系统仍可正常运行（无语音播放）

如有问题，请查看 [Issue #32](https://github.com/XiaoFeiASK/CraftMate/issues/32) 或相关文档。
