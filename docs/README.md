# 文档地图

CraftMate 文档按使用场景分为四类。每个主题只有一个权威文档；重复的阶段性说明不保留。

| 场景 | 文档 | 回答的问题 |
| --- | --- | --- |
| 了解项目 | [README](../README.md) | 产品要做什么、现在能跑什么、从哪里开始 |
| 首次运行 | [运行手册](operations/runbook.md) | 依赖、启动、服务、数据、排错 |
| 接外部系统 | [外部集成](guides/integrations.md) | 模型、语音、抖音、Minecraft 的配置与联调 |
| 理解系统 | [架构总览](reference/architecture.md) | 模块边界、运行链路、硬约束 |
| 查实现细节 | [技术设计](reference/technical-design.md) | 协议、决策内核、存储、人格与记忆 |
| 接游戏身体 | [Bridge 设计](reference/bridge.md) | 游戏通道协议、队列、控制权与安全 |
| 查术语与数据 | [术语表](reference/glossary.md)、[数据模型](reference/data-model.md) | 词义、迁移、约束、保留策略 |
| 查验收事实 | [验证清单](operations/verification.md) | 已验证、未验证、验收标准和证据 |
| 查决策 | [决策记录](decisions/adr.md)、[技术选型](decisions/tech-stack.md) | 已拍板方案、理由和重新评估条件 |

## 维护规则

- 一个主题只放一篇权威文档；新内容优先进入现有章节。
- 一次性实施报告不进仓库。结论并入状态或验证清单，原始过程保留在 Issue。
- 文档中的命令、路径和配置必须能用仓库验证。
- 修改运行行为时，同步运行手册或外部集成；修改数据时，同步数据模型。
- 状态句必须区分「自动化验证」「本机验收」「未验收」，不能把模拟结果写成真实结果。
