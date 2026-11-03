# CraftMate 快速启动指南

## 🚀 启动命令

```bash
# 启动完整系统
npm run dev

# 或运行测试脚本
./test-startup.sh

# 单独启动 Voice 服务
node --env-file=.env services/voice/src/main.ts
```

## ✅ 当前状态

- ✅ DeepSeek 模型：正常工作
- ⚠️ TTS 语音：需要配置（见下方）
- ✅ 所有测试：160/160 通过
- ✅ TypeScript：编译无错误

## ⚠️ TTS 配置步骤

1. 登录火山引擎控制台：https://console.volcengine.com/
2. 进入「语音技术」→「豆包语音」
3. 查看已开通的「资源 ID」和「音色 ID」
4. 编辑 `.env` 文件，修改这两行：
   ```
   TTS_PRIMARY_RESOURCE_ID=你的资源ID
   TTS_PRIMARY_VOICE_ID=你的音色ID
   ```
5. 测试：`node --env-file=.env services/voice/src/main.ts`

详细步骤见：`./docs/volcengine-tts-setup.md`

## 📁 关键文件

- `.env` - 配置文件（包含 API Keys）
- `ISSUE-32-GUIDE.md` - 完整实施指南
- `docs/volcengine-tts-setup.md` - TTS 配置详细步骤
- `docs/issue-32-implementation-status.md` - 技术实施记录

## 🎮 游戏连接（可选）

如需 AI 控制游戏：
1. 在 HMCL 中为 Minecraft 1.21.11 安装 Fabric Loader
2. 安装 MCPFabric Mod
3. 启动游戏和 CraftMate

## 🆘 常见问题

**Q: TTS 报错 "requested resource not granted"**
A: 需要在火山引擎控制台检查并修改资源 ID 和音色 ID

**Q: 暂时不需要语音怎么办？**
A: 注释掉 `.env` 中所有 `TTS_` 开头的行，系统会以"仅字幕"模式运行

**Q: 如何验证系统是否正常？**
A: 运行 `./test-startup.sh` 查看所有检查项

## 📚 更多信息

详细文档见 `ISSUE-32-GUIDE.md` 和 `docs/` 目录。
