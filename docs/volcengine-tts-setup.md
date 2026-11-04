# 火山引擎端到端实时语音配置

## 接入方式

CraftMate 只使用豆包端到端实时语音（Seeduplex）的 WebSocket 接口。旧的
一次性文字转语音 HTTP / SSE 调用已经删除。

## 解决步骤

### 1. 登录火山引擎控制台

访问 [火山引擎控制台](https://console.volcengine.com/)，进入「语音技术」→「豆包语音」服务。

### 2. 查看已开通的实时语音服务

在控制台找到端到端实时语音（Seeduplex）的音色 ID，例如
`zh_female_vv_uranus_bigtts`。

记录下你账号实际开通的资源和音色。

### 3. 在管理端保存配置

推荐在管理端「设置 → 接入」填写。也可以把下列变量作为首次启动默认值写入
项目根目录的 `.env`：

```bash
TTS_PRIMARY_PROVIDER=volcengine-realtime
TTS_PRIMARY_URL=wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue
TTS_PRIMARY_VOICE_ID=你的音色ID    # 例如：zh_female_vv_uranus_bigtts
TTS_PRIMARY_KEY=你的API_Key
```

### 4. 测试配置

运行以下命令测试 TTS 服务：

```bash
cd /Users/xiaofei/Project/CraftMate
node --env-file=.env services/voice/src/main.ts
```

如果配置正确，Voice 服务会正常启动，监听 `127.0.0.1:4323`。

### 5. 启动完整系统

```bash
./start.command --web
```

这会同时启动：
- Orchestrator（主服务）
- Voice（语音服务）
- 管理端（浏览器版）

在管理端配置了抖音房间号时，Orchestrator 还会自动启动 Ingress。

## API 调用

CraftMate 为每句已决定好的台词建立 WebSocket 会话，发送
`session.create` 和 `speech_text_buffer.commit`，把 24kHz `pcm_s16le`
在会话结束前直接送入本机流式播放器。它不会调用一次性文字转语音 HTTP 接口，
播放失败时会报告 `E_AUDIO_PLAYBACK`。

macOS 若返回 `AudioQueueStart failed (-66681)`，即使其他程序也完全无声，应先检查
“系统设置 → 声音 → 输出”并切换到可用扬声器。CraftMate 不会把这类系统故障降级为
假装播放成功。

## 相关文档

- [CraftMate 本地部署指南](./local-setup.md)
- [豆包端到端实时语音文档](https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh)
