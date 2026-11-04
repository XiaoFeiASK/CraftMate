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
- ✅ Volcengine Seeduplex 端到端实时语音 Provider
- ✅ 真实 Fabric 1.21.11 Mod 与 Bridge 世界快照

### ✅ 配置文件就绪

- ✅ `.env` 文件已创建（权限 600，不会推送到 Git）
- ✅ API Keys 已安全配置
- ✅ 文档已更新

---

## ⚠️ 你需要完成的步骤

### 步骤 1：配置抖音房间

在管理端「设置 → 接入」填写直播间号与 dyhub 地址并保存。Orchestrator 会自动
启动 Ingress；地址更改会热切换，房间号清空会停止 Ingress。

### 步骤 2：安装 Fabric 与 CraftMate Body（游戏控制所需）

**当前状态：** 仓库已包含真实的 `mods/craftmate-body` Fabric Mod。HMCL 中的
Minecraft 1.21.11 需使用 Fabric Loader `0.20.1`。

**如果你需要游戏内 AI 控制功能，请执行：**

1. **在 HMCL 启动器中**
   - 选择你的 Minecraft 1.21.11 实例
   - 点击「自动安装」→「Fabric」
   - 安装完成后重启实例

2. **安装 CraftMate Body**
   - 构建 `mods/craftmate-body/build/libs/craftmate-body-0.1.0.jar`
   - 将 Mod 文件放入该实例的 `.minecraft/mods/` 目录
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
- **管理端**（浏览器版）

配置了抖音房间号时，Orchestrator 还会自动启动 Ingress。

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
- [ ] 没有连接或播放错误信息
- [ ] WebSocket 服务正常监听

---

## 🔧 故障排除

### 问题：DeepSeek 模型无法连接

**检查：**
1. API Key 是否正确（`.env` 中的 `CRAFTMATE_MODEL_KEY`）
2. YYAPI 额度是否充足
3. 网络连接是否正常

### 问题：Bridge 无法连接游戏

**检查：**
1. Minecraft 是否安装了 Fabric Loader
2. Fabric Loader 与 CraftMate Body 是否正确安装
3. 游戏版本是否为 1.21.11

---

## 📚 相关文档

- [实施状态报告](./docs/issue-32-implementation-status.md) - 详细的技术实施记录
- [火山引擎 TTS 配置指南](./docs/volcengine-tts-setup.md) - TTS 配置详细步骤
- [本地部署指南](./docs/local-setup.md) - 完整的本地部署文档

---

## 🎯 下一步建议

1. **立即可做：**
   - 在管理端配置抖音房间号
   - 运行 `./test-startup.sh` 验证系统
   - 启动 `npm run dev` 测试对话功能

2. **后续可做：**
   - 安装 Fabric + CraftMate Body
   - 配置抖音直播间连接（如需直播互动）
   - 自定义 AI 行为和回复策略

---

## 💡 提示

- **API Keys 安全：** `.env` 文件已在 `.gitignore` 中，不会被 Git 追踪
- **真实联调：** 模型、Seeduplex PCM 和 Fabric 世界快照均已有真实证据；本机音频设备故障仍会使播放如实失败
- **模型已验证：** DeepSeek 通过 YYAPI 的连接已确认可用
- **配置失效策略：** TTS 未配置时 Voice 明确报告不可用，不伪造音频

如有问题，请查看 [Issue #32](https://github.com/XiaoFeiASK/CraftMate/issues/32) 或相关文档。
