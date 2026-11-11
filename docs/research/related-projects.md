# 相关项目调研

> 首次整理：2026-11-04。记录公开仓库与文档中可观察到的技术方案，供 CraftMate 后续设计讨论；不代表已决定实现或复用代码。

## 调研范围

| 项目 | 定位 | 主要参考资料 |
| --- | --- | --- |
| [MaiBot](https://github.com/Mai-with-u/MaiBot) | 面向聊天与陪伴的通用 Agent | [README](https://github.com/Mai-with-u/MaiBot/blob/main/README.md)、[文档](https://docs.mai-mai.org) |
| [MaiCraftMod](https://github.com/Mai-with-u/MaiCraftMod) | 通过 MCP 控制 Minecraft 客户端玩家的 Fabric / NeoForge Mod | [README](https://github.com/Mai-with-u/MaiCraftMod/blob/main/README.md)、[设计总览](https://github.com/Mai-with-u/MaiCraftMod/blob/main/docs/design/README.md) |
| [Amaidesu](https://github.com/Mai-with-u/Amaidesu) | AI 虚拟主播框架，含直播编排和游戏 Agent | [README](https://github.com/Mai-with-u/Amaidesu/blob/main/README.md)、[架构说明](https://github.com/Mai-with-u/Amaidesu/blob/main/docs/architecture/v2-architecture.md)、[Minecraft Agent](https://github.com/Mai-with-u/Amaidesu/blob/main/docs/architecture/minecraft-agent.md)、[主播记忆](https://github.com/Mai-with-u/Amaidesu/blob/main/docs/architecture/streamer-memory.md) |
| [dsh-mc-agent](https://github.com/blueziii/dsh-mc-agent) | DSH 插件：用 Mineflayer 身体让通用 Agent 自主玩 Minecraft | [README](https://github.com/blueziii/dsh-mc-agent/blob/main/README.md)、[插件说明](https://github.com/blueziii/dsh-mc-agent/blob/main/插件说明.md)、[开发说明](https://github.com/blueziii/dsh-mc-agent/blob/main/开发说明.md)、[踩坑档案](https://github.com/blueziii/dsh-mc-agent/blob/main/踩坑档案.md) |

## 对 CraftMate 的对比

| 维度 | 外部项目的强项 | CraftMate 的现状与差异 |
| --- | --- | --- |
| 社交互动 | MaiBot 以自然对话、互动时机、观众关系和扩展生态为核心 | CraftMate 有观众仲裁、人格权重、记忆和承诺机制，重点是把直播输入安全地转成可执行行为 |
| 游戏身体 | MaiCraftMod 提供更宽的游戏能力目录，并将长任务建模为目标；宿主可观察、查询、等待、取消和读取事件 | CraftMate 当前 Fabric 身体声明 16 个技能；Bridge 已具备能力协商、队列、任务终态、控制权和看门狗，A*、战斗、自动垫桥和脱困已在 1.20.1 实机验证 |
| 任务结果 | MaiCraftMod 的任务结果强调完成变化、尝试过的策略、未确认事项和受阻原因 | CraftMate 已通过 `changes`、`unconfirmed`、`attempts` 等字段记录结果，适合继续把结果证据与任务进展对齐 |
| 直播节奏 | Amaidesu 用 Rundown 流程单和自主 Planner 设计空场时继续推进内容，并由 Replyer 专注表达 | CraftMate 已有观众驱动和确定性目标模式两条路径；目标模式仍偏生存执行，不是节目流程单或空场话题编排 |
| 记忆 | Amaidesu 有场次回顾、观众画像、长期笔记和本场备忘录；MaiBot 强调长期理解与个性化互动 | CraftMate 将证据、待审记忆、已批准记忆、人格版本和承诺分开管理，强调来源、审批与可回滚 |
| 直播输出 | Amaidesu 集成 TTS、虚拟形象、OBS、字幕和屏幕感知 | CraftMate 已有语音和字幕链路，但 OBS/实播音频路由与完整虚拟形象联动尚未验收 |
| 自主循环 | dsh-mc-agent 用反射事件叫醒、空闲叫醒和长期目标让角色在无人指挥时继续行动；单次工具调用只做一件事，到点带 `remaining` 和 `hint` 返回 | CraftMate 已有 `GoalRuntime` 的连续目标闭环和 `GoalSpeechGate`，但空场时是否自动进入目标、反射事件后是否主动起反应仍取决于操作员设置 |
| 失败记忆 | dsh-mc-agent 的记忆条目带来源、成功/失败次数、适用版本和失败条件；同一 key 再记会累加而不是堆重复条目 | CraftMate 的记忆有证据、置信度、披露级别和审核队列，但缺少跨会话的成功/失败计数与“在什么条件下失败”的结构化字段 |

## 值得持续观察的方向

### 1. MaiBot：观众关系与自然对话

重点观察它如何通过回应时机、多人语境、用户习惯和个性化表达减少“每条消息都像一次问答”的机械感，以及插件生态如何让扩展能力保持可发现、可配置。

对 CraftMate 的启发是增强对常客和群体语境的连续理解，但要沿用现有证据与记忆审核边界，不把模型生成的印象直接当作事实。还应继续评估观众身份映射、记忆保留期限和隐私对本项目是否合适。

### 2. MaiCraftMod：目标、事件与执行证据

它把 Minecraft 对外能力归纳为观察、能力查询、执行、目标管理和事件读取，并让长时间身体行为在宿主等待期间继续推进。这个形态可作为 CraftMate 未来复杂移动、采集和建造行为的参考：单次命令确认、后台目标状态、任务事件、终态证据应有明确关系。

CraftMate 不应因此直接替换现有 Bridge。Bridge 继续围绕单机安全控制、技能白名单、操作员接管和断线释放设计；目标生命周期由上层 `GoalRuntime` 管理，而不是把“目标”塞进传输协议。MaiCraftMod README 将当前版本标记为预发布，并提示尚未经过完整实机验收，所以其能力广度不等于生产稳定性。

### 3. Amaidesu：节目自主性与分工

值得观察的方向包括：用流程单驱动空场内容、把规划和表达分开、把游戏作为独立命令驱动 Agent、用事件回传游戏进展，以及按场次整理回顾和观众画像。这些设计能帮助 CraftMate 从“响应评论并执行游戏动作”逐步扩展到“有持续节目节奏的直播角色”。

适用前提是先建立可靠的游戏状态和真机任务终态；否则自主节目循环可能会围绕过时或未经确认的状态继续叙述。Amaidesu README 标记为早期开发，其文档中的主动推进也明确依赖流程单和提示词质量，应视为方向性设计而非成熟能力保证。

### 4. dsh-mc-agent：事件叫醒与单动作闭环

它把“自主”拆成四层：反射层只监测危险和玩家发言，用插件提示叫醒同一个会话；空闲层在角色停下一段时间后，带着长期目标、背包、附近玩家和未完成任务叫醒它；模型每次只做一个可验证动作，做完先看结果再决定下一步；长动作被切成约 10 秒一段，到点返回 `remaining`、`hint` 和已完成进度，由模型决定是否续跑。

值得 CraftMate 借鉴的是“叫醒”而不是“替模型行动”：反射层只报告事实，吃什么、捡什么、跟不跟随、往哪撤由模型决定；叫醒文案明确要求“做一个动作、看结果、再决定”，不允许用等待或反问代替行动。空闲叫醒还有每小时配额、最小间隔、无动作指数退避，危险叫醒单独配额，避免挂机空转把保命额度烧光。

dsh-mc-agent 也暴露了几个反例：41 个工具语义重叠、部分工具内部仍会自动换工具/补中间产物/挑燃料/开门/挖路，和“让 AI 决定”的原则冲突；`selfcheck` 有“打 ❌ 但不影响退出码”的历史，提醒 CraftMate 继续把 `typecheck`、单测和真机证据作为硬门禁，而不是只靠文档自检。

## 初步结论

目前最直接的工程参考是 MaiCraftMod 的目标生命周期和证据化结果；最贴近产品体验的参考是 Amaidesu 的空场节目编排和跨场记忆；dsh-mc-agent 最适合作为“事件叫醒、单动作闭环、分段预算、失败记忆”的运行时参照；MaiBot 更适合作为自然互动、观众连续性和扩展生态的长期对照。

短期优先继续完成 CraftMate 已有的 Bridge、身体事件、技能终态和完整生存链真机验收。目标级跟踪已经由 `GoalRuntime` 落地，但节目单驱动、场次回顾和观众画像仍应等待游戏状态与终态证据稳定后再扩展。

## 已映射到 CraftMate 的执行改进

2026-11-04 先处理了“决策已批准，却在规划或桥接阶段失去执行”的直接卡点。这些改动只吸收前述项目的设计原则，代码为独立实现：

| 观察到的外部方案 | CraftMate 的对应实现 | 解决的问题 | 后续想模仿 |
| --- | --- | --- | --- |
| MaiCraftMod 把游戏动作视作有生命周期、由可观察结果决定成败的目标 | 明确获批的砍树意图走窄范围确定性规划；获批执行在模型故障时仍可降级到最小技能 | 不再因为多一次 LLM 往返或模型超时而只剩口头回应 | 目标级取消、暂停、查询和恢复；长任务跨回合保留 |
| 计划与执行分离，执行循环有边界，失败必须返回宿主 | 下发异常在进入身体前即写为终态；首次终态不可被迟到的完成消息覆盖 | 控制台与持久化记录不再长期卡在“执行中”，旧连接结果也不能污染新连接 | 更完整的目标事件流和可解释的重规划决策 |
| 游戏内任务必须持续观察世界变化，而不是只相信发出的输入 | `goto` 与 `mine_block` / `chop_tree` 用实际距离、可见性和方块状态判定进展；连续 3 秒无进展才失败；移动遇阻会尝试跳跃和重新选目标 | 输入已按下但角色未移动、局部障碍导致立即失败、遮挡后不会接近新目标等问题减少 | 后续按任务类型配置预算，并累积失败策略与部分完成证据 |
| 长任务等待期间宿主可以继续推进，进程与身体之间的身份必须稳定 | 每次 `BodySession` 和真实 Mod 连接使用独立任务命名空间；桥接发送失败立即结算 | 旧 ACK/进度/结果不会和新连接同名任务混淆，传输失败也不会留下虚构的运行中状态 | 在协议 v2 中显式携带 body/session 标识，替代前缀隔离 |

这一轮优先落实三个最小闭环：**获批动作尽快进入身体、没有身体或传输失败能马上看见、身体动作以世界变化判定成功与阻塞**。MaiBot 的观众关系和自然对话仍偏产品方向；Amaidesu 的节目编排、场次回顾与虚拟形象协同仍是后续工作，不在本轮执行卡点内。

2026-11-06 的目标模式进一步把这些原则合成了一个闭环：`GoalRuntime` 以身体事实
选择单个任务，终态证据决定是否推进，失败后改道或退避再观察。它仍是确定性规划，
不是外部项目的 LLM Planner；这样可以先验证身体和证据链，再评估是否引入模型级
目标推理。

2026-11-11 吸收 dsh-mc-agent 的运行时经验，补了四条独立实现：

- 反射事件不再只进 `world_event`，`Show.reactToIncident` 会按事件类型生成短台词，
  带 30 秒同类冷却和每小时配额，不授予技能、不创建承诺；
- 评论空窗 45 秒后 `Show.downtimeBeat` 生成环境节拍，目标模式开启时让位给
  `GoalRuntime` 的已验证任务解说；
- `skillOutcomeSchema` 增加 `progress`、`remaining`、`resumable`、`nextHint`，
  失败时把剩余工作和下一步提示写进目标运行时的恢复记录；
- 记忆增加成功/失败次数、失败条件和适用版本，召回时按置信度与成功率排序；
  同时给反射事件、世界快照和记忆内容加了提示词侧长度上限。

## 许可与边界

按仓库当前公开说明，MaiBot 使用 GPL-3.0，MaiCraftMod 使用 GPL-3.0-only，Amaidesu 使用 MIT，dsh-mc-agent 使用 MIT。这里只记录功能和架构方向，不复制代码；若未来考虑采用代码、依赖或协议实现，需单独审查对应版本的许可证、NOTICE 和兼容性。CraftMate 当前采用 MIT OR Apache-2.0，相关既有约束见[决策记录](../decisions/adr.md)。
