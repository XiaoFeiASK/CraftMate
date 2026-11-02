# 文档索引

换对话、换人接手，从这里开始读。根目录的 [README](../README.md) 是产品介绍与文档地图，本文只给维护者一条最短路径。

## 按问题找文档

| 我想知道 | 读这篇 |
| --- | --- |
| 系统分几层、边界在哪、哪些不能破 | [architecture.md](architecture.md) |
| 协议、参数、状态机、人格、记忆、表结构 | [technical-design.md](technical-design.md) |
| 抖音评论和游戏身体怎么接 | [integration.md](integration.md) |
| 接下来做什么、怎么验收 | [delivery-plan.md](delivery-plan.md) |
| 现在能跑什么、哪些是假的 | [status.md](status.md) |
| 怎么启动、怎么排错 | [local-setup.md](local-setup.md) |
| 为什么用 TS / Tauri / Java | [tech-stack.md](tech-stack.md) |
| 某个技术决定为什么这么定 | [decisions.md](decisions.md) |
| 某个词到底指什么 | [../GLOSSARY.md](../GLOSSARY.md) |
| 数据库迁移、幂等与保留策略 | [../db/README.md](../db/README.md) |

## 三条阅读路径

1. **第一次接触**：architecture → technical-design §1 → status。
2. **准备动手**：local-setup → status → delivery-plan 的 M1 当前切片。
3. **接外部系统**：integration → technical-design §2「本机协议」→ decisions。

## 文档职责

每篇只回答一类问题，不重复别人的内容。

| 文档 | 唯一职责 | 不写什么 |
| --- | --- | --- |
| `architecture.md` | 边界、不变量、状态机形态、部署拓扑 | 字段、参数、代码路径 |
| `technical-design.md` | 协议、参数、算法、存储、人格与记忆细节 | 路线图、选型论证 |
| `integration.md` | 外部组件选型与映射 | 分阶段排期（放交付计划） |
| `delivery-plan.md` | 顺序、切片、验收、PR 规则 | 现状事实（放 status） |
| `status.md` | 已实现 / 部分 / 未实现 | 计划与设计 |
| `tech-stack.md` | 语言与框架的取舍论证 | 具体实现细节 |
| `decisions.md` | 不可轻易回退的决定 | 实现细节 |

## 维护规则

- 新的拍板结论先追加到 `decisions.md`，再更新 `technical-design.md`。
- 每次合并后同步 `status.md`；它是「已实现 / 未实现」的唯一事实来源。
- 架构变化先改 `architecture.md`，再改实现。
- 不新增与上表职责重叠的文档。内容多了先拆章节，不先拆文件。
- 已废止的方案不删除，在 `decisions.md` 标「已废止」并链接取代者。
- 文档里的路径、命令、端口必须能在仓库里验证；改代码时顺手改对应文档。
