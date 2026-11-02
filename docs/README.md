# 文档索引

换对话、换人接手，从这里开始读。

| 文档 | 用途 |
| --- | --- |
| [architecture.md](architecture.md) | **先读这个**。系统长什么样、边界在哪、关键不变量是什么。 |
| [technical-design.md](technical-design.md) | **技术记忆基线**。协议、表结构、参数、路线图。 |
| [decisions.md](decisions.md) | 为什么这么选。一个文件收录全部决策。 |
| [../GLOSSARY.md](../GLOSSARY.md) | 术语表。讨论前先对齐用词。 |

## 阅读顺序

1. 先读 [architecture.md](architecture.md)，建立整体印象。
2. 再看 [technical-design.md](technical-design.md) 的「一页纸速查」，按章节跳读细节。
3. 想知道「为什么这么选」，查 [decisions.md](decisions.md)。
4. 讨论时用 [GLOSSARY.md](../GLOSSARY.md) 里的词。

## 维护规则

- 新的拍板结论追加到 [decisions.md](decisions.md)，再更新技术设计。
- 技术设计里不写「待讨论」的猜测，未定的进第 20 节。
- 架构变化先改 [architecture.md](architecture.md)，再改实现。
- 已废止的方案不删除，标状态并链接到取代它的决策编号。
