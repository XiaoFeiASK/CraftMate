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
- ✅ 豆包 Seeduplex 实时语音：真实鉴权、PCM 流式合成已验证
- ✅ Fabric 1.21.11 游戏身体与 Bridge：真实世界快照已验证
- ⚠️ 本机音频输出：当前 `afplay` 返回 `AudioQueueStart failed (-66681)`，需先修复系统输出设备

## ⚠️ 接入配置步骤

1. 打开管理端「设置 → 接入」。
2. 填写抖音房间号、dyhub 地址、模型和语音参数；Key 只需填写一次。
3. 保存后配置写入 `~/.craftmate/integrations.json`，模型和 Voice 会立即重载。
4. 填写房间号时 Orchestrator 自动启动 Ingress；清空房间号会停止。
5. 在「接入与语音」点击试听验证。

## 📁 关键文件

- `.env` - 配置文件（包含 API Keys）
- `ISSUE-32-GUIDE.md` - 完整实施指南
- `docs/volcengine-tts-setup.md` - TTS 配置详细步骤
- `docs/issue-32-implementation-status.md` - 技术实施记录

## 🎮 游戏连接（可选）

如需 AI 控制游戏：
1. 在 HMCL 中为 Minecraft 1.21.11 安装 Fabric Loader
2. 启动 CraftMate
3. 把 `mods/craftmate-body/build/libs/craftmate-body-0.1.0.jar` 放入该 Fabric 实例的 `mods/`
4. 进入真实单人世界，再在管理端确认 Bridge 显示已连接

## 🆘 常见问题

**Q: 为什么控制台显示抖音未接入？**
A: 先确认 dyhub 已在配置的地址运行，再填写正确的直播间号；保存后查看
`http://127.0.0.1:4322/health`。

**Q: 暂时不需要语音怎么办？**
A: 不配置语音 Key 时 Voice 会明确报告不可用，不会伪造语音

**Q: 如何验证系统是否正常？**
A: 运行 `./test-startup.sh` 查看所有检查项

## 📚 更多信息

详细文档见 `ISSUE-32-GUIDE.md` 和 `docs/` 目录。
