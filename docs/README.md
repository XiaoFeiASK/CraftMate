# 文档索引

换对话、换人接手，从这里开始读。

| 文档 | 用途 |
| --- | --- |
| [architecture.md](architecture.md) | **先读这个**。系统长什么样、边界在哪、关键不变量是什么。 |
| [status.md](status.md) | **现在能跑什么**。已实现、部分实现、未实现的事实清单。 |
| [delivery-plan.md](delivery-plan.md) | **接下来做什么**。目标队列、PR 切片、完成定义和停止条件。 |
| [local-setup.md](local-setup.md) | **怎么跑起来**。本机、Docker、验证命令和常见问题。 |
| [technical-design.md](technical-design.md) | **技术记忆基线**。协议、表结构、参数、约束。 |
| [tech-stack.md](tech-stack.md) | **技术选型**。前端/后端选什么，为什么不用 Python、Go。 |
| [decisions.md](decisions.md) | 为什么这么选。一个文件收录全部决策。 |
| [../GLOSSARY.md](../GLOSSARY.md) | 术语表。讨论前先对齐用词。 |

## 阅读顺序

1. 先读 [architecture.md](architecture.md)，建立整体印象。
2. 用 [status.md](status.md) 确认哪些是真实的、哪些还只是设计。
3. 用 [delivery-plan.md](delivery-plan.md) 确认下一个目标的边界和验收。
4. 要动手时照着 [local-setup.md](local-setup.md) 起环境。
5. 再看 [technical-design.md](technical-design.md) 的「一页纸速查」，按章节跳读细节。
6. 想知道「为什么选这个技术」，读 [tech-stack.md](tech-stack.md)。
7. 想知道「某个具体决定为什么这么定」，查 [decisions.md](decisions.md)。
8. 讨论时用 [GLOSSARY.md](../GLOSSARY.md) 里的词。

## 维护规则

- 新的拍板结论追加到 [decisions.md](decisions.md)，再更新技术设计。
- 每次合并后同步 [status.md](status.md)，它是「已实现/未实现」的唯一事实来源。
- 技术设计里不写「待讨论」的猜测，未定的进第 20 节。
- 架构变化先改 [architecture.md](architecture.md)，再改实现。
- 已废止的方案不删除，标状态并链接到取代它的决策编号。
