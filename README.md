# CraftMate

用 Agent 操作《我的世界》Java 版，把直播间评论变成受控游戏动作和实时语音回应。系
统会判断评论是否值得执行，维护人格、记忆和承诺，操作员可以随时接管或急停。

## 当前状态

最后核对：2026-11-04。

**已在本机运行**

- React 管理端、Tauri 桌面宿主、Orchestrator、Ingress、Voice、Bridge 协调器。
- SQLite 持久化、人格与承诺状态机、Stage A/B 仲裁、成本预算与回放查询。
- DeepSeek OpenAI 兼容模型、豆包 Seeduplex 实时语音、真实 Fabric 1.21.11 身体的开发实例连接。

**尚未完成**

- 真实抖音房间字段与故障联调。
- 游戏方块最终删除、失焦、独立存档与长时运行验收。
- 直播画面采集、BlackHole/OBS 音频路由自动化。

自动化验证状态见[验证清单](docs/operations/verification.md)；这些结论不会因文档重
组改变，计划与验收仍跟踪 [Issue #32](https://github.com/XiaoFeiASK/CraftMate/issues/32)。

## 快速开始

```bash
node -v           # 需要 v22.5+
npm install
./start.command   # 桌面窗口 + Orchestrator + Voice
./start.command --web
./stop.command
```

在管理端「设置 → 接入」填写模型、语音、抖音和游戏配置。凭据保存到
`~/.craftmate/integrations.json`，不会回传明文。完整启动、数据、端口和排错见
[运行手册](docs/operations/runbook.md)。

常用验证：

```bash
npm run typecheck
npm test
npm run build
npm run db:check
npm run db:check:file
```

## 仓库结构

```text
apps/
  admin-console/     React 管理端
  desktop-shell/     Tauri 2 桌面宿主
services/
  orchestrator/      控制面、持久化装配、运行时入口
  ingress/           抖音评论归一化、去重、限流
  voice/             分句、实时语音、字幕与播放
packages/
  contracts/         跨进程 zod 契约
  agent/             决策内核、规划、人格、承诺
  storage/           SQLite 连接、迁移与仓储
  bridge/            游戏通道协调器与队列
  bridge-mcpfabric/  MCPFabric 候选映射
  local-auth/        本机 token 与 loopback 校验
  local-config/      本机凭据配置
db/                 SQLite 迁移
docs/               分类文档
mods/craftmate-body/ Fabric 1.21.11 客户端 Mod
tools/              开发与校验脚本
```

`services/supervisord/` 不存在，也不是当前实现。

## 文档导航

从 [docs/README.md](docs/README.md) 进入。按需阅读：

1. **新环境跑起来**：运行手册 → 外部集成。
2. **理解或修改架构**：架构总览 → 技术设计 → 数据模型。
3. **接游戏身体**：Bridge 设计 → 运行手册 §8。
4. **了解取舍**：决策记录 → 技术选型。

## 许可与参考

项目采用 MIT OR Apache-2.0 双许可，文本见 [licenses/README.md](licenses/README.md)。

致谢：[PowerContext](https://github.com/oceanbase/powercontext) 启发了证据与记忆分离、
版本化和召回预算；[SeekMemory](https://github.com/NeverENG/SeekMemory) 启发了注意力
闸门、跟进窗口和取消语义；[AstrBot](https://github.com/AstrBotDevs/AstrBot) 启发了阶
段编排与策略选择结构；[dafeiyu-astrbot](https://github.com/whyever77/dafeiyu-astrbot)
提供了「大肥鱼」人格性格参考。本项目代码为独立实现，不复制许可证受限源码。
