# 数据模型

> SQLite 是单机运行时持久层。连接、迁移执行器和 Store 在 `packages/storage/src/`。

## 1. 约定

- 迁移文件：`db/migrations/NNNN_name.sql`，只向前追加，不修改已发布文件。
- 每个迁移在单事务中执行，记录版本和 checksum；checksum 漂移启动失败。
- 运行时配置：WAL、`foreign_keys = ON`、`busy_timeout = 5000`。
- 数据库时间使用 epoch 毫秒；协议和游戏动作使用 tick。
- 原始证据可过期；解释性记录用版本、事件或状态链保留。

## 2. 核心对象

`0001_initial.sql` 覆盖以下域：

| 域 | 对象 |
| --- | --- |
| 人格 | `persona`、`persona_version` |
| 场次 | `show_session` |
| 证据 | `source` |
| 决策 | `decision_log` |
| 动作 | `action_attempt` |
| 世界 | `world_event` |
| 承诺 | `commitment`、`commitment_event` |
| 记忆 | `memory`、`memory_evidence`、`memory_fts`、`review_candidate` |
| 运维 | `incident`、`schema_migration` |

后续迁移：

| 迁移 | 内容 |
| --- | --- |
| `0002_show_settings` | 按场次保存可变配置 |
| `0003_drop_unused_app_preference` | 删除服务端界面偏好 |
| `0004_source_retention_audit` | 原文清理审计 |
| `0005_planned_decisions` | 决策规划字段 |
| `0006_model_cost` | 模型成本账本 |

当前校验器报告 27 个对象、23 个索引；新增迁移后以 `npm run db:check` 输出为准。

## 3. 不变量

- `source.external_event_id` 在 `(session_id, kind, external_event_id)` 内去重；
  本地 `operator`、`world`、`system` 事件为 `NULL`。
- `decision_log.priority` 由契约显式写入，SQL 不设默认值。
- 承诺和动作终态必须有结束时间。
- 承诺状态迁移和事件在同一事务。
- 记忆只有从 `review_candidate` 批准后才写入可用记忆；FTS 命中必须连接当前有效记忆。
- 迁移目录只允许 SQL 迁移文件。

## 4. 保留策略

`source.raw_expires_at_ms = received_at_ms + 24h`。

- Orchestrator 启动时清一轮，之后每小时执行一次，每批 500 行、每批独立事务。
- 只清 `raw_text`，保留哈希、payload、外部 ID 和接收时间；去重和统计不受影响。
- 每条清理记录写入 `source_retention_audit(action='raw_text_expired')`；唯一索引防重复。
- 审计和原文清空在同一事务。
- 决策、承诺、动作不随原文过期删除。
- 日志和 trace JSON 不保存弹幕原文、prompt 或模型输出。

## 5. 校验

```bash
npm run db:check        # 内存库，日常最快
npm run db:check:file   # .tmp-db 中创建真实 WAL 文件库，退出清理
node tools/check-schema.mjs /path/to/dir
```

校验器执行全部迁移，并检查外键、唯一约束、终态时间、优先级、非法状态、保留审计、
当前视图、FTS 中文查询、迁移命名、WAL 和外键配置。FTS 使用 trigram；少于三个字符的
中文查询不保证命中。
