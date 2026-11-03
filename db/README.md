# 数据库

SQLite 是单机运行时的持久层。迁移文件在这里，连接、迁移执行器与 Store 实现
在 [`packages/storage`](../packages/storage/src/index.ts)。

## 约定

- 迁移文件：`db/migrations/NNNN_name.sql`，只向前追加，不修改已发布文件。
- 每个迁移由迁移器在单事务中执行，并记录版本和校验和。
- 运行时使用 WAL、`foreign_keys = ON`、`busy_timeout = 5000`。
- 所有时间为 Unix epoch 毫秒；游戏精度时间另存为 tick。
- 事件证据 append-only；记忆、人格、承诺用 revision 保留历史。
- 原始评论只保留 24 小时，之后清空原文并保留哈希、ID 和结构化指标。
- 不在日志或 trace JSON 中写弹幕原文、prompt 或模型输出。
- 平台事件用 `source.external_event_id` 做幂等去重，作用域是
  `(session_id, kind, external_event_id)`；本地产生的 `operator` / `world` /
  `system` 事件该字段为 `NULL`，不受唯一索引约束。
- `decision_log.priority` 由仲裁结果显式写入，不允许仓储层猜默认值。
  `packages/contracts` 的 `Decision` 已带 `priority`，SQL 里不设 `DEFAULT`。

## 首个迁移

`0001_initial.sql` 覆盖 12 组实体、15 张表（含 FTS 主表）与 4 个视图；
`0002_show_settings.sql` 增加按场次保存的可变配置，`0003` 清掉初版误建的
`app_preference`（界面偏好存在浏览器本机，服务端不读），`0004` 增加原文
过期审计（每个 source 每种动作只记一次）：

- `persona` / `persona_version`
- `show_session`
- `source`
- `decision_log`
- `action_attempt`
- `world_event`
- `commitment` / `commitment_event`
- `memory` / `memory_evidence` / `memory_fts`
- `review_candidate`
- `incident`
- `schema_migration`
- `show_settings`（`0002`，一场一行，JSON 内容由契约校验）
- `source_retention_audit`（`0004`，原文清理证据：source、动作、哈希、时间）

运行时由 `openDatabase()` 在启动时自动建库并跑迁移；`db:check` 只做独立校验，
不写任何真实数据库。

## 校验

```bash
npm run db:check        # 内存库，日常最快
npm run db:check:file   # 在 .tmp-db/ 里建真实 WAL 文件库，用完即删
node tools/check-schema.mjs /path/to/dir   # 任意目录，用完即删
```

内存库模式只验证 SQL 语义。WAL、`busy_timeout` 和真实的文件锁只有文件库才有，
所以涉及连接参数或迁移器的 PR 必须额外跑一次文件库模式。传入目录时校验器会在
里面建一个临时库，退出时连同 `-wal` / `-shm` 一起删掉。

校验器会执行全部迁移，并检查：

- 外键和唯一约束。
- 承诺和动作终态必须有结束时间。
- 每条决策必须记录优先级，不在仓储层猜默认值。
- 非法决策、记忆状态被拒绝。
- 同一 source 的原文清理审计不能重复，未知动作被拒绝。
- 当前决策、开放承诺、当前记忆视图返回正确结果。
- FTS5 trigram 索引可检索中文片段。
- FTS 命中不会被误当成有效记忆（必须连 `memory_active`）。
- 迁移文件命名连续，`db/migrations/` 里没有非迁移文件。
- 文件库模式下 `journal_mode` 确实是 `wal`，且 `foreign_keys` 保持开启。

`trigram` 对少于 3 个字符的查询不保证命中；需要两字检索时，单独评估 ngram
tokenizer，不在 v1 里同时维护两套索引。

FTS 表包含所有记忆版本。召回查询必须连接 `memory_active`（或
`memory_current` 并显式检查 state），不能直接拿 FTS 命中当可用记忆。

## 保留策略

`source.raw_expires_at_ms = received_at_ms + 24h`。Orchestrator 启动时先清一轮，
之后每小时执行一次 `SourceStore.expireRawText()`，每批 500 行、每批独立事务：

- 只清 `raw_text`，保留 `content_hash`、`payload_json`、`external_event_id`、
  `received_at_ms`，所以去重和统计不受影响。
- 每个被清理的 source 写入一行 `source_retention_audit`
  （`action = 'raw_text_expired'`）。唯一索引保证重跑不会产生第二条。
- 清理失败只记录错误并等下一轮，不阻塞直播；审计和原文清空在同一事务内，
  不会出现「清了原文但没有证据」。
- 决定、承诺和动作记录不随原文过期删除；它们的可解释性只依赖 ID 与哈希。

