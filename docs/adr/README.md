# 架构决策记录

每条 ADR 记录一个已经拍板、且改动会带来真实成本的决定。格式统一为：背景、决策、后果。

状态含义：

- **已采纳**：当前有效，实现必须遵守。
- **已废止**：曾经有效，被后续 ADR 取代。
- **待定**：已有倾向，但还没最终确认。

| 编号 | 标题 | 状态 |
| --- | --- | --- |
| [0001](0001-fabric-over-mineflayer.md) | 游戏执行层用 Fabric Mod，不用 Mineflayer | 已采纳 |
| [0002](0002-typescript-kernel.md) | 执行内核用 TypeScript，不用 Go | 已采纳 |
| [0003](0003-client-mod-real-account.md) | 客户端 Mod 驱动真实玩家账号 | 已采纳 |
| [0004](0004-local-singleplayer.md) | 本地单人世界作为直播场地 | 已采纳 |
| [0005](0005-tauri-console.md) | 管理端用 Tauri，交互按原生桌面程序做 | 已采纳 |
| [0006](0006-version-compat-layer.md) | 版本不锁死，用 compat 层隔离差异 | 已采纳 |
| [0007](0007-douyin-two-adapters.md) | 抖音接入做官方与抓取双实现 | 已采纳 |
| [0008](0008-no-agpl-code.md) | 不复制 AGPL 项目代码 | 已采纳 |
| [0009](0009-dafeiyu-persona.md) | 默认人格用社区大肥鱼 | 已采纳 |
| [0010](0010-dual-license.md) | 双许可 MIT OR Apache-2.0 | 已采纳 |
| [0011](0011-postponed-risk-engineering.md) | 暂不做完整风险分级与存档回滚 | 已采纳 |
| [0012](0012-deepseek-first.md) | 模型接入先用 DeepSeek | 已采纳 |
| [0013](0013-dafeiyu-voice-reference.md) | 语音参考社区大肥鱼音色 | 已采纳 |
| [0014](0014-first-show-format.md) | 首播采用单一主线目标 | 已采纳 |
| [0015](0015-self-built-pathfinding.md) | 寻路自研，Baritone 仅作对照 | 已采纳 |

