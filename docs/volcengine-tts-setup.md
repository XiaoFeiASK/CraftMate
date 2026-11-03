# 火山引擎 TTS 配置指南

## 问题说明

如果你遇到类似以下错误：
```
HTTP 200 but error code 45000030: "requested resource not granted"
```

这表示你的 API Key 有效，但没有访问当前配置的 TTS 资源的权限。

## 解决步骤

### 1. 登录火山引擎控制台

访问 [火山引擎控制台](https://console.volcengine.com/)，进入「语音技术」→「豆包语音」服务。

### 2. 查看已开通的服务

在控制台中找到：
- **资源 ID** (Resource ID)：例如 `volc.tts.default`、`volc.seedtts.default`、`seed-tts-2.0`
- **音色 ID** (Voice ID)：例如 `zh_female_tianmeixiaoyuan`、`zh_male_aojiaobazong`

记录下你账号实际开通的资源和音色。

### 3. 更新 `.env` 配置

修改 CraftMate 项目根目录的 `.env` 文件：

```bash
TTS_PRIMARY_PROVIDER=volcengine
TTS_PRIMARY_RESOURCE_ID=你的资源ID  # 例如：volc.tts.default
TTS_PRIMARY_VOICE_ID=你的音色ID    # 例如：zh_female_tianmeixiaoyuan
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
npm run dev
```

这会同时启动：
- Orchestrator（主服务）
- Voice（语音服务）
- Ingress（评论输入服务）

## 常见资源和音色

### 基础 TTS 资源
- `volc.tts.default`：最基础的 TTS 服务

### 高级 TTS 资源（需要单独开通）
- `seed-tts-2.0`：豆包高保真语音合成
- `volc.seedtts.default`：种子语音服务

### 常见音色 ID
- `zh_female_tianmeixiaoyuan`：甜美小媛（女声）
- `zh_male_aojiaobazong`：傲娇霸总（男声）
- `zh_female_vv_uranus_bigtts`：天王星音色（需 seed-tts-2.0）

## 临时解决方案：仅字幕模式

如果暂时无法解决 TTS 授权问题，可以注释掉所有 TTS 配置：

```bash
# TTS_PRIMARY_PROVIDER=volcengine
# TTS_PRIMARY_RESOURCE_ID=seed-tts-2.0
# TTS_PRIMARY_VOICE_ID=zh_female_vv_uranus_bigtts
# TTS_PRIMARY_KEY=...
```

系统会以"仅字幕"模式运行：
- 合成器返回空音频
- 控制台仍能看到 `speaking / spoken / failed` 事件
- AI 助手的回复会以字幕形式显示，但不会播放语音

## 相关文档

- [CraftMate 本地部署指南](./local-setup.md)
- [火山引擎 TTS API 文档](https://www.volcengine.com/docs/6561/79820)
